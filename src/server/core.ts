// The domain service: identity, hiring, routing + wake rules, the call lifecycle, cards, watchdog.
// Pure logic over the Store, a Spawner and a Clock — no HTTP here (see api.ts).
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import type { Spawner } from '../harness/index';
import { SPARROW_HOME, TMUX_PREFIX, type Settings } from '../shared/config';
import { newId } from '../shared/ids';
import type {
  Agent, AgentState, Call, CallEndReason, Card, CardCreateReq, CardPatchReq, CardState, DoneReq, HireReq,
  HarnessHealth, HarnessName, Message, MessageKind, MessageView, Project, RegisterCaptainReq, RegisterCaptainRes, Resume,
  ResumeView, SendReq, ServerEvent, TeamStatus, TurnEndReq, TurnEndRes, UpdateReq,
} from '../shared/types';
import { CARD_STATES } from '../shared/types';
import { type CatalogService, gateCheck, resumeStatus } from './catalog';
import { publicCall, type CallRow, Store } from './db';
import { EventBus } from './events';
import {
  crashResume, freshReplay, hhmm, NUDGE_REPORT, nudgeQuiet, PROTOCOL_PATH, renderEnvelope, renderSystemPrompt,
} from './prompts';
import { hashText, Resumes } from './resumes';

/** Hidden project for doctor / "test resume" probe agents (never listed, never in chat). */
export const DOCTOR_PROJECT = '_doctor';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as any),
};

export interface CoreDeps {
  store: Store;
  spawner: Spawner;
  settings: Settings;
  resumes: Resumes;
  events?: EventBus;
  clock?: Clock;
  log?: (line: string) => void;
  tmuxPrefix?: string;
  protocolPath?: string;
  deliverDelayMs?: number;            // delay before typing into a TUI after its turn ended (default 1000)
  detectRoot?: (cwd: string) => string; // git root of cwd (or cwd)
  doctorRoot?: string;                  // root of the hidden _doctor project (default <SPARROW_HOME>/doctor)
}

const FRIENDLY = ['james', 'maya', 'leo', 'iris', 'omar', 'nina', 'theo', 'zara', 'ravi', 'lena', 'ivan', 'mira', 'kai', 'ada', 'ben', 'cleo'];
const RESERVED = new Set(['captain', 'group', 'system', 'user', 'all', 'everyone', 'here', 'none']);
const HANDLE_RE = /^[a-z][a-z0-9-]{0,23}$/;

export function gitRoot(cwd: string): string {
  try {
    const r = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' });
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out) return out;
  } catch { /* not a git repo / git missing */ }
  return resolvePath(cwd);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
// Last n non-padding lines of a screen: TUIs pad with blank rows, so drop trailing spaces and collapse blank runs.
const tail = (text: string, n: number) =>
  text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '').split('\n').slice(-n).join('\n');
const isText = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const optStr = (x: unknown, field: string): string | undefined => {
  if (x === undefined || x === null || x === '') return undefined;
  if (typeof x !== 'string') throw new HttpError(400, `${field} must be a string`);
  return x;
};
const TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export class Core {
  readonly store: Store;
  readonly spawner: Spawner;
  readonly settings: Settings;
  readonly resumes: Resumes;
  readonly events: EventBus;
  readonly clock: Clock;
  private log: (line: string) => void;
  private tmuxPrefix: string;
  private protocolPath: string;
  private deliverDelayMs: number;
  private detectRoot: (cwd: string) => string;
  readonly doctorRoot: string;
  // U1: set by createApp. The hire gate and resume status read the catalog and the latest doctor verdict.
  catalogs: CatalogService | null = null;
  healthOf: (h: HarnessName) => HarnessHealth | null = () => null;

  private closeTimers = new Map<string, unknown>();      // agentId -> grace timer
  private otherTimers = new Set<unknown>();
  private deadCounts = new Map<string, number>();         // callId -> consecutive dead checks
  private snapshots = new Map<string, { text: string; at: number }>();
  private waiters = new Map<string, Set<() => void>>();   // agentId -> inbox long-poll resolvers
  private stopped = false;
  private ticking = false;

  constructor(d: CoreDeps) {
    this.store = d.store;
    this.spawner = d.spawner;
    this.settings = d.settings;
    this.resumes = d.resumes;
    this.events = d.events ?? new EventBus();
    this.clock = d.clock ?? realClock;
    this.log = d.log ?? (() => {});
    this.tmuxPrefix = d.tmuxPrefix ?? TMUX_PREFIX;
    this.protocolPath = d.protocolPath ?? PROTOCOL_PATH;
    this.deliverDelayMs = d.deliverDelayMs ?? 1000;
    this.detectRoot = d.detectRoot ?? gitRoot;
    this.doctorRoot = d.doctorRoot ?? join(process.env.SPARROW_HOME ?? SPARROW_HOME, 'doctor');
  }

  now() { return this.clock.now(); }

  /**
   * Run slow spawner work (a TUI can take 10+ s to start) without holding the HTTP request open.
   * wake()/startCall() reserve the slot, call row and deliveries synchronously before their first
   * await, so the state the caller sees in the response is already final.
   */
  private bg(p: Promise<unknown>) {
    p.catch((err) => this.say(`background error: ${(err as Error)?.message ?? err}`));
  }

  private say(line: string) {
    const d = new Date(this.now());
    const ts = `${hhmm(this.now())}:${String(d.getSeconds()).padStart(2, '0')}`;
    try { this.log(`${ts} ${line}`); } catch { /* ignore */ }
  }

  // ======================================================== helpers / views

  handleOf = (id: string): string => {
    if (id === 'system' || id === 'user') return id;
    return this.store.getAgent(id)?.handle ?? id;
  };

  threadLabel(thread: string, short = false): string {
    const ids = thread.split(':').slice(1);
    const agents = ids.map((id) => this.store.getAgent(id));
    const sorted = agents
      .map((a, i) => ({ h: a?.handle ?? ids[i], depth: a?.depth ?? 99 }))
      .sort((x, y) => x.depth - y.depth || x.h.localeCompare(y.h));
    const s = sorted.map((x) => `@${x.h}`).join(' ↔ ');
    return short ? s : `dm ${s}`;
  }

  view(m: Message): MessageView {
    return {
      ...m,
      from_handle: m.from_id === 'system' ? 'system' : this.handleOf(m.from_id),
      thread_label: this.threadLabel(m.thread),
      to_handles: m.mentions.map((id) => this.handleOf(id)),
    };
  }

  private emit(e: ServerEvent) { this.events.emit(e); }

  private saveAgent(id: string, patch: Partial<Agent> & { queued_at?: number | null; resume_note?: string | null }): Agent {
    const a = this.store.patchAgent(id, patch, this.now());
    this.emit({ type: 'agent.updated', project_id: a.project_id, agent: a });
    return a;
  }

  private saveCard(id: number, patch: Partial<Card>): Card {
    const c = this.store.patchCard(id, patch, this.now());
    this.emit({ type: 'card.updated', project_id: c.project_id, card: c });
    return c;
  }

  private dmThread(a: string, b: string) {
    return `dm:${[a, b].sort().join(':')}`;
  }

  /**
   * Insert a message + pending deliveries; emits + wakes long-pollers. Does NOT wake agents (callers decide when).
   * `quiet` recipients get a quiet delivery (amendment A5): pending, handed over with the next waking delivery, but
   * never wakes them or ends their long-poll. Retired quiet recipients are skipped (nothing would ever consume it).
   */
  private post(p: {
    project_id: string; thread: string; from_id: string; kind: MessageKind; text: string; to: string[];
    quiet?: string[]; card_id?: number | null; meta?: Record<string, unknown>;
  }): Message {
    const to = [...new Set(p.to)].filter((id) => id !== p.from_id);
    const quiet = [...new Set(p.quiet ?? [])]
      .filter((id) => id !== p.from_id && !to.includes(id) && this.store.getAgent(id)?.state !== 'retired');
    const m = this.store.tx(() => {
      const msg = this.store.insertMessage({
        id: newId('msg'), project_id: p.project_id, thread: p.thread, from_id: p.from_id, kind: p.kind, text: p.text,
        mentions: to, card_id: p.card_id ?? null, meta: p.meta ?? {}, created_at: this.now(),
      });
      for (const id of to) this.store.insertDelivery(msg.id, id);
      for (const id of quiet) this.store.insertDelivery(msg.id, id, false);
      return msg;
    });
    this.emit({ type: 'message.created', project_id: m.project_id, message: this.view(m) });
    for (const id of to) {
      const ws = this.waiters.get(id);
      if (ws) for (const w of [...ws]) w();
    }
    return m;
  }

  private resumeFor(a: Agent): Resume {
    const r = this.resumes.get(a.resume);
    if (r) return r;
    return {
      slug: a.resume, title: a.title, description: '', harness: (a.harness === 'human' ? 'claude' : a.harness) as HarnessName,
      model: a.model, effort: a.effort, can_hire: a.can_hire,
      limits: { quiet_minutes: this.settings.quiet_minutes, max_call_minutes: this.settings.max_call_minutes }, body: '', path: '',
    };
  }

  isCaptain(a: Agent) { return a.kind === 'human' || a.can_hire.length > 0; }

  // ======================================================== identity

  registerCaptain(req: RegisterCaptainReq): RegisterCaptainRes {
    if (!req?.cwd || typeof req.cwd !== 'string') throw new HttpError(400, 'register needs {cwd}');
    const cwd = resolvePath(req.cwd);
    const root = this.projectRootFor(cwd);
    let project = this.store.getProjectByRoot(root);
    if (!project) {
      const base = slugify(basename(root));
      let id = base;
      for (let n = 2; this.store.getProject(id); n++) id = `${base}-${n}`;
      project = { id, name: basename(root) || id, root, created_at: this.now() };
      this.store.insertProject(project);
      this.say(`project ${id} (${root})`);
    }
    let cap = this.store.getAgentByHandle(project.id, 'captain');
    const now = this.now();
    if (!cap) {
      const a: Agent = {
        id: newId('ag'), project_id: project.id, handle: 'captain', kind: 'human', resume: 'captain', title: 'Captain',
        harness: 'human', model: null, effort: null, can_hire: ['*'], parent_id: null, depth: 0, cwd,
        tmux_session: this.tmuxPrefix + project.id, tmux_window: '', tmux_window_id: null, session_id: req.session_id ?? null,
        state: 'idle', call_id: null, last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: now,
        resume_hash: null, last_run: null, created_at: now, updated_at: now,
      };
      this.store.insertAgent(a);
      cap = a;
      this.emit({ type: 'agent.updated', project_id: a.project_id, agent: a });
      this.say(`captain registered for ${project.id}`);
    } else {
      cap = this.saveAgent(cap.id, { cwd, last_seen_at: now, ...(req.session_id ? { session_id: req.session_id } : {}) });
    }
    return { agent: cap, project };
  }

  /** Project semantics: the longest registered project root containing cwd; else its git root; else cwd. */
  projectRootFor(cwd: string): string {
    const inside = this.store.listProjects()
      .filter((p) => p.id !== DOCTOR_PROJECT && (cwd === p.root || cwd.startsWith(p.root.endsWith(sep) ? p.root : p.root + sep)))
      .sort((a, b) => b.root.length - a.root.length);
    return inside[0]?.root ?? this.detectRoot(cwd);
  }

  identify(id: string): Agent {
    const a = this.store.getAgent(id);
    if (!a) throw new HttpError(401, `Unknown agent id ${id}. It is not registered with this Sparrow server (was the database reset?). Unset SPARROW_AGENT_ID to act as the captain.`);
    return a;
  }

  touch(a: Agent): Agent {
    const now = this.now();
    this.store.patchAgent(a.id, { last_seen_at: now }, now);
    return { ...a, last_seen_at: now };
  }

  whoami(caller: Agent) {
    return {
      agent: caller,
      project: this.store.getProject(caller.project_id),
      parent: caller.parent_id ? this.store.getAgent(caller.parent_id) : null,
    };
  }

  /** Find an agent by '@handle', 'handle' or id within a project. */
  resolveAgent(project: string | null, ref: unknown): Agent | null {
    if (!isText(ref)) return null;
    if (ref.startsWith('ag_')) return this.store.getAgent(ref);
    const h = ref.replace(/^@/, '').toLowerCase();
    return project ? this.store.getAgentByHandle(project, h) : null;
  }

  private rosterText(project: string): string {
    const r = this.store.listAgents(project).filter((a) => a.state !== 'retired').map((a) => `@${a.handle}`).reverse();
    return r.length ? r.join(', ') : '(nobody)';
  }

  // ======================================================== hire

  async hire(caller: Agent, req: HireReq): Promise<{ agent: Agent; message: MessageView }> {
    if (!isText(req?.resume) || !isText(req?.task)) throw new HttpError(400, 'hire needs {resume, task} as non-empty strings');
    for (const f of ['name', 'cwd', 'tmux_session', 'tmux_window', 'model', 'effort'] as const) optStr((req as any)[f], f);
    for (const f of ['tmux_session', 'tmux_window'] as const) {
      const v = req[f];
      if (v && !TMUX_NAME_RE.test(v)) throw new HttpError(400, `Invalid ${f} "${v}": use 1-40 letters, digits, '_' or '-' (tmux treats '.' and ':' as target separators).`);
    }
    const slug = String(req.resume).trim();
    if (caller.kind !== 'human' && !caller.can_hire.includes('*') && !caller.can_hire.includes(slug)) {
      throw new HttpError(403, `@${caller.handle} (${caller.resume}) may not hire ${slug}: can_hire = [${caller.can_hire.join(', ')}]`);
    }
    const depth = caller.depth + 1;
    if (depth > this.settings.max_depth) {
      throw new HttpError(403, `Hiring from @${caller.handle} would create depth ${depth}, but max_depth is ${this.settings.max_depth}. Do the work yourself, or ask your parent to hire.`);
    }
    const resume = this.resumes.get(slug);
    if (!resume) {
      throw new HttpError(404, `No resume "${slug}". Available: ${this.resumes.list().map((r) => r.slug).join(', ') || '(none — run sparrow install)'}`);
    }
    const project = caller.project_id;
    let handle: string;
    if (req.name) {
      handle = String(req.name).replace(/^@/, '').toLowerCase();
      if (!HANDLE_RE.test(handle)) throw new HttpError(400, `Invalid name "${req.name}": use lowercase letters, digits and '-', starting with a letter, max 24 chars.`);
      if (RESERVED.has(handle)) throw new HttpError(400, `"${handle}" is reserved; pick another name.`);
      if (this.store.getAgentByHandle(project, handle)) throw new HttpError(409, `@${handle} already exists in project ${project}; pick another --name.`);
    } else {
      handle = FRIENDLY.find((n) => !this.store.getAgentByHandle(project, n)) ?? '';
      for (let n = 1; !handle; n++) if (!this.store.getAgentByHandle(project, `${slug}-${n}`)) handle = `${slug}-${n}`;
    }
    const cwd = req.cwd ? resolvePath(caller.cwd, req.cwd) : caller.cwd;
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, `cwd ${cwd} does not exist or is not a directory.`);
    let card: Card | null = null;
    if (req.card_id != null) {
      card = this.store.getCard(Number(req.card_id));
      if (!card || card.project_id !== project) throw new HttpError(404, `No card #${req.card_id} in project ${project}.`);
    }
    const model = req.model ?? resume.model;
    const effort = req.effort ?? resume.effort;
    // Hire gate (U1): refuse before the row exists, so no window ever opens for a broken harness or a dead model.
    const refusal = this.gate(resume.harness, model, effort);
    if (refusal) {
      this.say(`hire REFUSED ${resume.slug}/${resume.harness} by @${caller.handle}: ${refusal}`);
      throw new HttpError(409, refusal);
    }
    const now = this.now();
    const agent: Agent = {
      id: newId('ag'), project_id: project, handle, kind: 'agent', resume: resume.slug, title: resume.title,
      harness: resume.harness, model, effort, can_hire: resume.can_hire,
      parent_id: caller.id, depth, cwd, tmux_session: req.tmux_session || this.tmuxPrefix + project,
      tmux_window: req.tmux_window || handle, tmux_window_id: null, session_id: null, state: 'idle', call_id: null,
      last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, resume_hash: this.resumes.hash(resume.slug),
      last_run: null, created_at: now, updated_at: now,
    };
    this.store.insertAgent(agent);
    this.emit({ type: 'agent.updated', project_id: project, agent });
    const msg = this.post({
      project_id: project, thread: this.dmThread(caller.id, agent.id), from_id: caller.id, kind: 'task',
      text: req.task, to: [agent.id], card_id: card?.id ?? null,
    });
    if (card) {
      this.saveCard(card.id, {
        assignee_id: agent.id, state: 'in_progress',
        position: card.state === 'in_progress' ? card.position : this.store.maxPosition(project, 'in_progress') + 1,
        notes: [...card.notes, { at: now, by: caller.handle, text: `assigned to @${handle}` }],
      });
    }
    this.say(`hire @${handle} ${resume.slug}/${resume.harness} by @${caller.handle} → ${agent.tmux_session}:${agent.tmux_window}`);
    this.bg(this.wake(agent.id));
    return { agent: this.store.getAgent(agent.id)!, message: this.view(msg) };
  }

  /** Hire gate: refusal text or null. `fake` always passes; no catalog / no doctor run yet → allow. */
  gate(harness: HarnessName, model: string | null, effort: string | null): string | null {
    return gateCheck(this.catalogs?.get(harness) ?? null, this.healthOf(harness), harness, model, effort, this.now());
  }

  // ======================================================== probes (doctor round trips, "test resume")

  private doctorProject(): { project: Project; captain: Agent } {
    let project = this.store.getProject(DOCTOR_PROJECT);
    if (!project) {
      mkdirSync(this.doctorRoot, { recursive: true });
      project = { id: DOCTOR_PROJECT, name: 'doctor', root: this.doctorRoot, created_at: this.now() };
      this.store.insertProject(project);
    }
    let cap = this.store.getAgentByHandle(DOCTOR_PROJECT, 'captain');
    if (!cap) {
      const now = this.now();
      cap = {
        id: newId('ag'), project_id: DOCTOR_PROJECT, handle: 'captain', kind: 'human', resume: 'captain', title: 'Doctor',
        harness: 'human', model: null, effort: null, can_hire: ['*'], parent_id: null, depth: 0, cwd: this.doctorRoot,
        tmux_session: this.tmuxPrefix + 'doctor', tmux_window: '', tmux_window_id: null, session_id: null, state: 'idle',
        call_id: null, last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: now,
        resume_hash: null, last_run: null, created_at: now, updated_at: now,
      };
      this.store.insertAgent(cap);
    }
    return { project, captain: cap };
  }

  /**
   * Hire a throwaway probe agent (kind 'probe') in the hidden _doctor project: no hire gate (it IS the test), not
   * counted in max_running, tmux session <prefix>doctor, cwd <doctorRoot>/<run>/<label>.
   */
  hireProbe(o: { harness: HarnessName; model: string | null; effort: string | null; task: string; run: string; label: string; resume?: string }): Agent {
    const { captain } = this.doctorProject();
    const cwd = join(this.doctorRoot, o.run, o.label);
    mkdirSync(cwd, { recursive: true });
    const base = `${o.label}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 17) || 'probe';
    let handle = base;
    for (let n = 2; this.store.getAgentByHandle(DOCTOR_PROJECT, handle); n++) handle = `${base}-${n}`;
    const r = o.resume ? this.resumes.get(o.resume) : null;
    const now = this.now();
    const agent: Agent = {
      id: newId('ag'), project_id: DOCTOR_PROJECT, handle, kind: 'probe', resume: o.resume ?? 'probe', title: r?.title ?? 'Doctor probe',
      harness: o.harness, model: o.model, effort: o.effort, can_hire: [], parent_id: captain.id, depth: 1, cwd,
      tmux_session: this.tmuxPrefix + 'doctor', tmux_window: handle, tmux_window_id: null, session_id: null, state: 'idle',
      call_id: null, last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null,
      resume_hash: o.resume ? this.resumes.hash(o.resume) : null, last_run: null, created_at: now, updated_at: now,
    };
    this.store.insertAgent(agent);
    this.post({ project_id: DOCTOR_PROJECT, thread: this.dmThread(captain.id, agent.id), from_id: captain.id, kind: 'task', text: o.task, to: [agent.id] });
    this.say(`probe @${handle} ${o.harness} ${o.model ?? '(default)'}/${o.effort ?? '-'}`);
    this.bg(this.wake(agent.id));
    return this.store.getAgent(agent.id)!;
  }

  /** Close a probe's window (if any) and retire it. */
  async retireProbe(id: string): Promise<void> {
    const a = this.store.getAgent(id);
    if (!a || a.kind !== 'probe' || a.state === 'retired') return;
    this.cancelClose(a.id);
    await this.stopIfOurs(a, true);
    const cur = this.store.getAgent(id)!;
    if (cur.call_id) this.endCall(cur, 'released', { state: 'retired', close: 'none' });
    this.store.dropPending(id);
    this.saveAgent(id, { state: 'retired', tmux_window_id: null, call_id: null, queued_at: null });
  }

  lastScreenOf(id: string, n = 15): string { return tail(this.lastScreen(id), n); }

  // ======================================================== resumes (U1)

  resumeView(r: Resume): ResumeView {
    const hash = this.resumes.hash(r.slug) ?? hashText('');
    const st = resumeStatus(r, this.catalogs?.get(r.harness) ?? null, this.healthOf(r.harness), this.now());
    const stale = this.store.listAgents()
      .filter((a) => a.kind === 'agent' && a.resume === r.slug && a.state !== 'retired' && a.resume_hash !== hash)
      .map((a) => a.id);
    return { ...r, hash, builtin: this.resumes.isBuiltin(r), status: st.status, status_detail: st.detail, resolved_model: st.resolved, stale_agents: stale };
  }

  resumeViews(): ResumeView[] { return this.resumes.list().map((r) => this.resumeView(r)); }

  emitResume(slug: string) {
    const r = this.resumes.get(slug);
    if (r) this.emit({ type: 'resume.updated', project_id: '*', resume: this.resumeView(r) });
    else this.emit({ type: 'resume.deleted', project_id: '*', slug });
  }

  /**
   * "Apply to existing agents": every non-retired agent hired from an older copy of the resume takes the current
   * harness/model/effort/can_hire/title/hash; the changed resume text is prepended to its next envelope.
   */
  applyResume(slug: string): string[] {
    const r = this.resumes.get(slug);
    if (!r) throw new HttpError(404, `No resume "${slug}".`);
    const view = this.resumeView(r);
    const out: string[] = [];
    for (const id of view.stale_agents) {
      const a = this.store.getAgent(id);
      if (!a) continue;
      const harnessChanged = a.harness !== r.harness;
      const note = [
        `[sparrow] Your resume "${slug}" was updated by the user${harnessChanged ? ` (you now run on ${r.harness}; this is a fresh session, check your folder for earlier work)` : ''}. Your role from now on:`,
        '',
        r.body.trim(),
      ].join('\n');
      this.saveAgent(id, {
        harness: r.harness, model: r.model, effort: r.effort, can_hire: r.can_hire, title: r.title, resume_hash: view.hash,
        resume_note: note, ...(harnessChanged ? { session_id: null } : {}),
      });
      out.push(id);
    }
    if (out.length) this.say(`apply ${slug} → ${out.length} agent(s)`);
    this.emitResume(slug);
    return out;
  }

  /** Recent project roots for "Start captain", newest activity first. */
  recentRoots(): string[] {
    const last = new Map<string, number>();
    for (const p of this.store.listProjects()) {
      if (p.id === DOCTOR_PROJECT) continue;
      last.set(p.root, Math.max(p.created_at, ...this.store.listAgents(p.id).map((a) => a.updated_at)));
    }
    return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([root]) => root);
  }

  // ======================================================== messaging

  async send(caller: Agent, req: SendReq): Promise<MessageView> {
    const text = req?.text;
    if (!isText(req?.to) || !isText(text)) throw new HttpError(400, 'send needs {to, text} as non-empty strings');
    const toL = String(req.to).trim().toLowerCase();
    if (toL === 'group' || toL === '@group') throw new HttpError(400, 'Group chat was removed. DM a teammate: sparrow send @<handle> "…"');
    const cardId = this.checkCard(caller.project_id, req.card_id);
    const target = this.resolveAgent(caller.project_id, req.to);
    if (!target || target.project_id !== caller.project_id) {
      throw new HttpError(404, `No agent ${req.to} in project ${caller.project_id}. Roster: ${this.rosterText(caller.project_id)}`);
    }
    if (target.id === caller.id) throw new HttpError(400, 'You cannot message yourself.');
    if (target.state === 'retired') throw new HttpError(409, `@${target.handle} was released (retired) and cannot receive messages. Hire a new agent instead.`);
    const m = this.post({
      project_id: caller.project_id, thread: this.dmThread(caller.id, target.id), from_id: caller.id, kind: 'chat', text,
      to: [target.id], card_id: cardId,
    });
    this.say(`dm @${caller.handle} → @${target.handle}: ${clip(text.replace(/\s+/g, ' '), 60)}`);
    this.bg(this.wake(target.id));
    return this.view(m);
  }

  private checkCard(project: string, cardId: number | undefined | null): number | null {
    if (cardId == null) return null;
    const c = this.store.getCard(Number(cardId));
    if (!c || c.project_id !== project) throw new HttpError(404, `No card #${cardId} in project ${project}.`);
    return c.id;
  }

  /** An update goes to the DM thread with the parent as a QUIET delivery: it reaches the parent with its next waking message. */
  update(caller: Agent, req: UpdateReq): MessageView {
    if (!isText(req?.text)) throw new HttpError(400, 'update needs {text} as a non-empty string');
    const parent = caller.parent_id ? this.store.getAgent(caller.parent_id) : null;
    if (!parent) throw new HttpError(400, `@${caller.handle} has no parent; updates go to a parent. Use sparrow card note to annotate a card.`);
    const cardId = this.checkCard(caller.project_id, req.card_id);
    const m = this.post({
      project_id: caller.project_id, thread: this.dmThread(caller.id, parent.id), from_id: caller.id, kind: 'update',
      text: req.text, to: [], quiet: [parent.id], card_id: cardId,
    });
    this.saveAgent(caller.id, { last_update: req.text, last_update_at: this.now() });
    if (cardId != null) {
      const c = this.store.getCard(cardId)!;
      this.saveCard(c.id, { notes: [...c.notes, { at: this.now(), by: caller.handle, text: req.text }] });
    }
    this.say(`update @${caller.handle}: ${clip(req.text.replace(/\s+/g, ' '), 80)}`);
    return this.view(m);
  }

  /** Shared tail of done / ask / wait. */
  private async finish(
    caller: Agent, callHeader: string | null, reason: 'done' | 'ask' | 'wait',
    record: () => Message | null, newState: AgentState,
  ): Promise<{ ended: boolean; message: MessageView | null }> {
    // A report from a call that is already over (e.g. `done` twice): accept silently, record nothing.
    if (caller.kind !== 'human' && callHeader && callHeader !== caller.call_id) return { ended: true, message: null };
    const onCall = caller.kind !== 'human' && caller.state === 'working' && !!caller.call_id;
    // Amendment A1: with WAKING pending deliveries record NOTHING; the piggyback hands them over and the agent
    // reports again. Quiet ones (A5: children's updates, FYI notices) never block; they wait for the next call.
    if ((onCall || caller.kind === 'human') && this.store.countWaking(caller.id) > 0) {
      this.say(`${reason} @${caller.handle} not sent: ${this.store.countWaking(caller.id)} new message(s) first`);
      return { ended: false, message: null };
    }
    const m = record();
    if (onCall) {
      this.endCall(caller, reason, { state: newState });
    }
    for (const id of m?.mentions ?? []) this.bg(this.wake(id));
    if (onCall) this.bg(this.dequeue());
    return { ended: true, message: m ? this.view(m) : null };
  }

  private parentOf(a: Agent): Agent {
    const p = a.parent_id ? this.store.getAgent(a.parent_id) : null;
    if (!p) throw new HttpError(400, `@${a.handle} has no parent to report to.`);
    return p;
  }

  async done(caller: Agent, req: DoneReq, callHeader: string | null = null) {
    if (!isText(req?.summary)) throw new HttpError(400, 'done needs {summary} as a non-empty string');
    const status = req.status ?? 'ok';
    if (!['ok', 'blocked', 'failed'].includes(status)) throw new HttpError(400, 'status must be ok | blocked | failed');
    const parent = this.parentOf(caller);
    return this.finish(caller, callHeader, 'done', () => {
      const call = caller.call_id ? this.store.getCall(caller.call_id) : null;
      const m = this.post({
        project_id: caller.project_id, thread: this.dmThread(caller.id, parent.id), from_id: caller.id, kind: 'result',
        text: req.summary, to: [parent.id], meta: { status, ...(call ? { call_ms: this.now() - call.started_at } : {}) },
      });
      this.say(`done @${caller.handle} (${status}) → @${parent.handle}`);
      return m;
    }, 'idle');
  }

  async ask(caller: Agent, req: { question: string }, callHeader: string | null = null) {
    if (!isText(req?.question)) throw new HttpError(400, 'ask needs {question} as a non-empty string');
    const parent = this.parentOf(caller);
    return this.finish(caller, callHeader, 'ask', () => {
      const m = this.post({
        project_id: caller.project_id, thread: this.dmThread(caller.id, parent.id), from_id: caller.id, kind: 'question',
        text: req.question, to: [parent.id],
      });
      this.say(`ask @${caller.handle} → @${parent.handle}: ${clip(req.question.replace(/\s+/g, ' '), 60)}`);
      return m;
    }, 'waiting');
  }

  async wait(caller: Agent, req: { reason?: string }, callHeader: string | null = null) {
    const reason = (isText(req?.reason) && req.reason.trim()) || 'for messages';
    return this.finish(caller, callHeader, 'wait', () => {
      const text = `waiting: ${reason}`;
      const parent = caller.parent_id ? this.store.getAgent(caller.parent_id) : null;
      // The human captain has no parent: nothing to record, but last_update still says what it waits for.
      const m = parent
        ? this.post({
          project_id: caller.project_id, thread: this.dmThread(caller.id, parent.id), from_id: caller.id, kind: 'update',
          text, to: [], quiet: [parent.id],
        })
        : null;
      this.saveAgent(caller.id, { last_update: text, last_update_at: this.now() });
      this.say(`wait @${caller.handle}: ${clip(reason, 60)}`);
      return m;
    }, 'waiting');
  }

  /**
   * Piggyback: pending deliveries (waking and quiet, seq order) for the caller, now marked delivered. Only for the
   * human captain and agents on the matching open call.
   */
  takeInbox(callerId: string, callHeader: string | null = null): MessageView[] {
    const a = this.store.getAgent(callerId);
    if (!a) return [];
    if (a.kind !== 'human') {
      if (a.state !== 'working' || !a.call_id) return [];
      if (callHeader && callHeader !== a.call_id) return [];
    }
    const pending = this.store.pendingFor(a.id);
    if (!pending.length) return [];
    this.store.markDelivered(a.id, pending.map((m) => m.id), a.kind !== 'human' ? a.call_id : null, this.now());
    return pending.map((m) => this.view(m));
  }

  /** Long-poll: resolves when the agent has ≥1 WAKING pending delivery or after `sec` seconds (quiet ones never end it). */
  waitForPending(agentId: string, sec: number, signal?: AbortSignal): Promise<void> {
    if (this.store.countWaking(agentId) > 0 || sec <= 0) return Promise.resolve();
    return new Promise<void>((res) => {
      let set = this.waiters.get(agentId);
      if (!set) this.waiters.set(agentId, (set = new Set()));
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        set!.delete(done);
        if (!set!.size) this.waiters.delete(agentId);
        if (timer) clearTimeout(timer);
        res();
      };
      set.add(done);
      timer = setTimeout(done, sec * 1000); // real time on purpose: an HTTP request is waiting
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** The caller's non-retired children that are not idle, for the `inbox` digest ("Still working"). */
  team(agentId: string): TeamStatus[] {
    return this.store.children(agentId)
      .filter((a) => a.state !== 'retired' && a.state !== 'idle')
      .map((a) => ({
        handle: a.handle, resume: a.resume, harness: a.harness, state: a.state,
        call_started_at: a.call_id ? this.store.getCall(a.call_id)?.started_at ?? null : null,
        last_update: a.last_update, last_update_at: a.last_update_at,
      }));
  }

  // ======================================================== wake / calls / queue

  workingCount() { return this.store.countWorking(); }

  async wake(agentId: string): Promise<void> {
    const a = this.store.getAgent(agentId);
    if (!a || a.kind === 'human') return;
    if (a.state === 'retired') { this.store.dropPending(a.id); return; }
    if (a.state === 'working' || a.state === 'queued') return;
    if (this.store.countWaking(a.id) === 0) return; // quiet-only pending never starts a call
    if (a.kind === 'probe' || this.store.countWorking() < this.settings.max_running) {
      await this.startCall(a, {});
    } else {
      this.saveAgent(a.id, { state: 'queued', queued_at: this.now() });
      this.say(`queued @${a.handle} (max_running ${this.settings.max_running} reached)`);
    }
  }

  async dequeue(): Promise<void> {
    const starts: Promise<void>[] = [];
    while (this.store.countWorking() < this.settings.max_running) {
      const q = this.store.oldestQueued();
      if (!q) break;
      if (this.store.countWaking(q.id) === 0) {
        this.saveAgent(q.id, { state: 'idle', queued_at: null });
        continue;
      }
      starts.push(this.startCall(q, {})); // reserves its slot synchronously
    }
    await Promise.all(starts);
  }

  /**
   * Start a call. The slot, call row and deliveries are reserved synchronously (before the first await),
   * so concurrent wakes never double-start and hooks from the new window are recognised immediately.
   */
  async startCall(a0: Agent, opts: { prefix?: string; resume?: boolean; fresh?: boolean; restarts?: number }): Promise<void> {
    const callId = newId('call');
    const pending = this.store.pendingFor(a0.id);
    const sessionId = opts.fresh ? null : a0.session_id;
    const resume = opts.fresh ? false : (opts.resume ?? sessionId != null) && sessionId != null;
    const project = this.store.getProject(a0.project_id);
    const note = this.store.takeResumeNote(a0.id);
    const prefix = [note, opts.prefix].filter(Boolean).join('\n\n') || undefined;
    const envelope = renderEnvelope(a0, pending, this.handleOf, { prefix, projectId: project?.id });
    const now = this.now();
    const call: Call = {
      id: callId, agent_id: a0.id, started_at: now, ended_at: null, end_reason: null, exit_code: null, resumed: resume,
      nudges: 0, restarts: opts.restarts ?? Math.max(0, ...pending.map((m) => Number(m.meta?.restart) || 0)), prompt: envelope,
      harness: a0.harness === 'human' ? null : a0.harness, model: a0.model, effort: a0.effort,
    };
    const oldWindow = a0.tmux_window_id;
    const t = this.closeTimers.get(a0.id);
    if (t !== undefined) { this.clock.clearTimeout(t); this.closeTimers.delete(a0.id); }
    const agent = this.store.tx(() => {
      this.store.markDelivered(a0.id, pending.map((m) => m.id), callId, now);
      this.store.insertCall(call);
      const last_run = { harness: a0.harness, model: a0.model, effort: a0.effort, at: now };
      return this.store.patchAgent(a0.id, { state: 'working', call_id: callId, session_id: sessionId, queued_at: null, last_run }, now);
    });
    this.emit({ type: 'agent.updated', project_id: agent.project_id, agent });
    this.emit({ type: 'call.started', project_id: agent.project_id, call });

    // ---- async part
    if (oldWindow) {
      await this.stopIfOurs(a0);
      const cur = this.store.getAgent(a0.id)!;
      if (cur.tmux_window_id === oldWindow) this.store.patchAgent(a0.id, { tmux_window_id: null }, this.now());
    }
    const parent = agent.parent_id ? this.store.getAgent(agent.parent_id) : null;
    const resumeCard = this.resumeFor(agent);
    let res: { window_id: string; session_id: string | null };
    try {
      const fresh = this.store.getAgent(a0.id)!;
      const system = renderSystemPrompt(fresh, resumeCard, parent, project ?? { id: agent.project_id, name: agent.project_id, root: agent.cwd, created_at: 0 }, this.protocolPath);
      res = await this.spawner.start({ agent: fresh, call_id: callId, system_prompt: system, prompt: envelope, resume });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.say(`start FAILED @${agent.handle}: ${msg}`);
      const cur = this.store.getAgent(a0.id)!;
      if (cur.call_id === callId) {
        this.endCall(cur, 'crashed', { state: 'crashed', close: 'none' });
        await this.notifyParent(cur, `@${cur.handle} could not be started: ${msg}\nFix the cause, then send @${cur.handle} a message to retry.`, { error: msg });
        await this.dequeue();
      }
      return;
    }
    const cur = this.store.getAgent(a0.id)!;
    const sid = res.session_id ?? cur.session_id;
    if (cur.call_id === callId) {
      this.saveAgent(cur.id, { tmux_window_id: res.window_id, session_id: sid });
    } else if (cur.state !== 'working') {
      // The call ended before start() returned (very fast agent): remember the window so it gets closed.
      this.saveAgent(cur.id, { tmux_window_id: res.window_id, session_id: sid });
      if (!this.closeTimers.has(cur.id)) this.scheduleClose(cur.id);
    } else {
      try { await this.spawner.stop({ ...cur, tmux_window_id: res.window_id }); } catch { /* ignore */ }
    }
    this.say(`call @${agent.handle} ${resume ? 'resume' : 'new'} ${agent.harness} → ${agent.tmux_session}:${agent.tmux_window} (${res.window_id})${pending.length ? ` with ${pending.length} msg` : ''}`);
  }

  /** Close the open call (sync). Window closes after close_grace_ms unless a new call starts. */
  /**
   * close: 'grace' (window still ours and alive → stop it after close_grace_ms), 'dead' (the window died on its own →
   * forget its id at once; never stop by id later — tmux reuses ids), 'none' (caller handles the window).
   */
  endCall(a: Agent, reason: CallEndReason, opts: { state: AgentState; exitCode?: number | null; close?: 'grace' | 'dead' | 'none' }): Agent {
    const now = this.now();
    let call: CallRow | null = a.call_id ? this.store.getCall(a.call_id) : null;
    if (call && call.ended_at == null) {
      call = this.store.patchCall(call.id, { ended_at: now, end_reason: reason, exit_code: opts.exitCode ?? null });
      this.deadCounts.delete(call.id);
    }
    const close = opts.close ?? 'grace';
    if (close === 'dead') this.cancelClose(a.id);
    const agent = this.saveAgent(a.id, {
      state: opts.state, call_id: null, last_end_reason: reason, queued_at: null, ...(close === 'dead' ? { tmux_window_id: null } : {}),
    });
    if (call) this.emit({ type: 'call.ended', project_id: agent.project_id, call: publicCall(call) });
    this.say(`end @${agent.handle} ${reason}${opts.exitCode != null ? ` (exit ${opts.exitCode})` : ''} → ${opts.state}`);
    if (close === 'grace') this.scheduleClose(agent.id);
    return agent;
  }

  private cancelClose(agentId: string) {
    const t = this.closeTimers.get(agentId);
    if (t !== undefined) { this.clock.clearTimeout(t); this.closeTimers.delete(agentId); }
  }

  private scheduleClose(agentId: string) {
    const prev = this.closeTimers.get(agentId);
    if (prev !== undefined) this.clock.clearTimeout(prev);
    const h = this.clock.setTimeout(() => {
      this.closeTimers.delete(agentId);
      void this.closeWindow(agentId);
    }, this.settings.close_grace_ms);
    this.closeTimers.set(agentId, h);
  }

  /**
   * Stop a window by id ONLY if the spawner says it is alive and ours (T2 tags windows with the agent id, so a
   * reused tmux id reports not-alive). Returns whether it stopped. With `snapshot`, captures the screen first.
   */
  private async stopIfOurs(a: Agent, snapshot = false): Promise<boolean> {
    if (!a.tmux_window_id) return false;
    let ours = false;
    try { ours = await this.spawner.isAlive(a); } catch { ours = false; }
    if (!ours) return false;
    if (snapshot) await this.snapshotOne(a);
    try { await this.spawner.stop(a); } catch (e) { this.say(`stop failed @${a.handle}: ${(e as Error).message}`); }
    return true;
  }

  /** Stop the agent's window if no call is open. Captures a final snapshot first. */
  async closeWindow(agentId: string): Promise<void> {
    const a = this.store.getAgent(agentId);
    if (!a || a.state === 'working' || !a.tmux_window_id) return;
    const win = a.tmux_window_id;
    await this.stopIfOurs(a, true);
    const cur = this.store.getAgent(agentId)!;
    if (cur.tmux_window_id === win && cur.state !== 'working') {
      this.saveAgent(cur.id, { tmux_window_id: null });
      this.say(`closed window @${cur.handle} (${win})`);
    }
  }

  /**
   * Action-needed system notice: system message in the parent↔agent DM thread WITH a delivery to the parent, then wake it.
   * Used only for terminal notices: crashed (restarts used up), unreported, start failure, server_restart, max_call_minutes.
   */
  async notifyParent(a: Agent, text: string, meta: Record<string, unknown> = {}): Promise<void> {
    const parent = a.parent_id ? this.store.getAgent(a.parent_id) : null;
    if (!parent) return;
    this.post({
      project_id: a.project_id, thread: this.dmThread(parent.id, a.id), from_id: 'system', kind: 'system', text,
      to: [parent.id], meta: { about: a.id, ...meta },
    });
    this.bg(this.wake(parent.id));
  }

  /**
   * FYI system notice: same thread, QUIET delivery to the parent — never wakes it; it arrives together with the next
   * waking message (e.g. "crashed; restarting", quiet nudges).
   */
  fyiParent(a: Agent, text: string, meta: Record<string, unknown> = {}): void {
    const parent = a.parent_id ? this.store.getAgent(a.parent_id) : null;
    if (!parent) return;
    this.post({
      project_id: a.project_id, thread: this.dmThread(parent.id, a.id), from_id: 'system', kind: 'system', text,
      to: [], quiet: [parent.id], meta: { about: a.id, fyi: true, ...meta },
    });
  }

  private lastScreen(agentId: string): string {
    return this.snapshots.get(agentId)?.text ?? '';
  }

  // ======================================================== hooks

  private noteSession(a: Agent, sessionId: string | undefined | null): Agent {
    if (!isText(sessionId) || sessionId === a.session_id) return a;
    const call = a.call_id ? this.store.getCall(a.call_id) : null;
    if (!a.session_id || !(call?.resumed)) {
      this.say(`session @${a.handle} = ${sessionId}`);
      return this.saveAgent(a.id, { session_id: sessionId });
    }
    return a;
  }

  session(caller: Agent, callHeader: string | null, sessionId: string): { ok: true } {
    if (!isText(sessionId)) throw new HttpError(400, 'session needs {session_id} as a string');
    if (callHeader && caller.call_id && callHeader !== caller.call_id) return { ok: true };
    this.noteSession(caller, sessionId);
    return { ok: true };
  }

  private deliverLater(agentId: string, callId: string, text: string) {
    const h = this.clock.setTimeout(() => {
      this.otherTimers.delete(h);
      const a = this.store.getAgent(agentId);
      if (!a || a.call_id !== callId || a.state !== 'working') return;
      this.spawner.deliver(a, text).catch((e) => this.say(`deliver failed @${a.handle}: ${(e as Error).message}`));
    }, this.deliverDelayMs);
    this.otherTimers.add(h);
  }

  async turnEnd(caller: Agent, callHeader: string | null, req: TurnEndReq): Promise<TurnEndRes> {
    let a = this.noteSession(caller, req?.session_id);
    if (a.kind === 'human' || a.state !== 'working' || !a.call_id || (callHeader && callHeader !== a.call_id)) {
      return { action: 'allow' };
    }
    const call = this.store.getCall(a.call_id)!;
    const isClaude = (req?.harness ?? a.harness) === 'claude';
    // Deliver when ≥1 waking message is pending (quiet ones go along); quiet-only pending is not a reason to continue.
    const pending = this.store.countWaking(a.id) > 0 ? this.store.pendingFor(a.id) : [];
    if (pending.length) {
      this.store.markDelivered(a.id, pending.map((m) => m.id), a.call_id, this.now());
      const env = renderEnvelope(a, pending, this.handleOf, {});
      this.say(`turn-end @${a.handle}: delivering ${pending.length} msg`);
      if (isClaude) return { action: 'block', reason: env };
      this.deliverLater(a.id, a.call_id, env);
      return { action: 'none' };
    }
    // T2 fix (I1 bug 4): Claude stopped while its own background shells still run — it wakes itself when they
    // finish, so this is not "stopped without reporting": allow, no nudge, nothing counted.
    const bg = Number((req as { background_tasks_running?: unknown } | undefined)?.background_tasks_running ?? 0);
    if (bg > 0) {
      this.say(`turn-end @${a.handle}: ${bg} background task(s) running — allow, no nudge`);
      return { action: 'allow' };
    }
    if (call.nudges < this.settings.max_nudges) {
      this.store.patchCall(call.id, { nudges: call.nudges + 1 });
      this.say(`turn-end @${a.handle}: nudge ${call.nudges + 1}/${this.settings.max_nudges}`);
      if (isClaude) return { action: 'block', reason: NUDGE_REPORT };
      this.deliverLater(a.id, a.call_id, NUDGE_REPORT);
      return { action: 'none' };
    }
    await this.endUnreported(a, req?.last_message ?? null, false);
    return { action: 'allow' };
  }

  /** windowDying: the harness exited (exit hook) — the window closes itself; forget its id instead of closing by id. */
  private async endUnreported(a: Agent, lastMessage: string | null, windowDying: boolean) {
    if (windowDying) await this.snapshotOne(a);
    const last = (isText(lastMessage) && lastMessage.trim()) || tail(this.lastScreen(a.id), 15) || '(nothing captured)';
    const ended = this.endCall(a, 'unreported', { state: 'idle', close: windowDying ? 'dead' : 'grace' });
    await this.notifyParent(ended, `@${a.handle} stopped without reporting. Its last message: «${clip(last.trim(), 4000)}»\nSend @${a.handle} a message to resume it.`, { last_message: last });
    await this.dequeue();
  }

  async exitHook(caller: Agent, callHeader: string | null, code: number): Promise<{ ok: true }> {
    if (caller.kind === 'human') return { ok: true };
    if (!caller.call_id) {
      // The harness of an already-ended call exited (e.g. after done): its window is closing itself.
      // Forget the id now so a pending grace close can never hit a reused tmux id.
      const latest = this.store.latestCall(caller.id);
      if (caller.tmux_window_id && latest && (!callHeader || callHeader === latest.id)) {
        this.cancelClose(caller.id);
        this.saveAgent(caller.id, { tmux_window_id: null });
      }
      return { ok: true };
    }
    if (callHeader && callHeader !== caller.call_id) return { ok: true };
    const call = this.store.getCall(caller.call_id);
    if (!call || call.ended_at != null) return { ok: true };
    const c = Number.isFinite(Number(code)) ? Number(code) : -1;
    if (c === 0) {
      await this.endUnreported(caller, null, true);
      return { ok: true };
    }
    await this.crash(caller, c, true);
    return { ok: true };
  }

  private async snapshotOne(a: Agent) {
    if (!a.tmux_window_id) return;
    try {
      const text = await this.spawner.capture(a, 200);
      if (text) this.snapshots.set(a.id, { text, at: this.now() });
    } catch { /* window gone */ }
  }

  /** Crash path (CONTRACT §3.8). */
  async crash(a0: Agent, code: number, captureNow: boolean): Promise<void> {
    const callId = a0.call_id;
    if (!callId) return;
    if (captureNow) await this.snapshotOne(a0);
    let a = this.store.getAgent(a0.id)!;
    const call = this.store.getCall(callId);
    if (!call || call.ended_at != null || a.call_id !== callId) return;
    a = this.endCall(a, 'crashed', { state: 'crashed', exitCode: code, close: 'dead' });
    if (call.restarts < this.settings.max_restarts) {
      let fresh = call.resumed && this.now() - call.started_at < this.settings.fresh_fallback_ms;
      if (!fresh && !a.session_id) {
        let sid: string | null = null;
        try { sid = await this.spawner.discoverSession(a, call.started_at); } catch { /* ignore */ }
        a = this.store.getAgent(a.id)!;
        if (sid) a = this.saveAgent(a.id, { session_id: sid });
        else fresh = true;
      }
      a = this.store.getAgent(a.id)!;
      if (a.state !== 'crashed') return; // something else (a message, a release) took over meanwhile
      const prefix = fresh ? this.replayFor(a, code) : crashResume(code, a.last_update);
      if (this.store.countWorking() >= this.settings.max_running) {
        // No free slot (another hire took it meanwhile): queue the restart; its envelope waits as a pending delivery.
        if (fresh) a = this.saveAgent(a.id, { session_id: null });
        const thread = this.dmThread(a.parent_id ?? '', a.id); // every spawned agent has a parent
        this.post({ project_id: a.project_id, thread, from_id: 'system', kind: 'system', text: prefix, to: [a.id], meta: { about: a.id, restart: call.restarts + 1, exit_code: code } });
        this.saveAgent(a.id, { state: 'queued', queued_at: this.now() });
        this.fyiParent(a, `@${a.handle} crashed (exit ${code}); restart queued (max_running ${this.settings.max_running} reached).`, { exit_code: code });
        this.say(`queued restart @${a.handle} (max_running reached)`);
        return;
      }
      await this.startCall(a, { prefix, resume: !fresh, fresh, restarts: call.restarts + 1 });
      this.fyiParent(a, `@${a.handle} crashed (exit ${code}); restarting${fresh ? ' with a fresh session (its session could not be resumed)' : ' on the same session'}.`, { exit_code: code });
      return;
    }
    const screen = tail(this.lastScreen(a.id), 20);
    await this.notifyParent(a, `@${a.handle} crashed (exit ${code}) and its automatic restart was already used.\nLast screen:\n${screen || '(no snapshot)'}\nSend @${a.handle} a message to resume it.`, { exit_code: code, screen });
    await this.dequeue();
  }

  private replayFor(a: Agent, code: number): string {
    const parentId = a.parent_id ?? '';
    const thread = this.dmThread(parentId, a.id);
    const msgs = this.store.listMessages({ project: a.project_id, thread, limit: 200 });
    const tasks = msgs.filter((m) => m.kind === 'task' && m.mentions.includes(a.id));
    const task = tasks[tasks.length - 1] ?? null;
    const recent = msgs.filter((m) => m.id !== task?.id && m.kind !== 'system').slice(-10);
    return freshReplay(a, task, recent, a.last_update, this.handleOf, code);
  }

  // ======================================================== watchdog / snapshots / quiet

  async watchdogTick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      for (const a0 of this.store.agentsInState('working')) {
        if (this.stopped) return;
        if (!a0.tmux_window_id || !a0.call_id) continue; // still starting
        let alive = true;
        try { alive = await this.spawner.isAlive(a0); } catch { alive = true; }
        const a = this.store.getAgent(a0.id)!;
        if (a.call_id !== a0.call_id || a.state !== 'working') continue;
        if (alive) { this.deadCounts.delete(a.call_id!); }
        else {
          const n = (this.deadCounts.get(a.call_id!) ?? 0) + 1;
          this.deadCounts.set(a.call_id!, n);
          if (n >= 2) {
            this.say(`watchdog: @${a.handle} window gone`);
            await this.crash(a, -1, false);
            continue;
          }
        }
        await this.quietCheck(a);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async quietCheck(a: Agent) {
    const call = a.call_id ? this.store.getCall(a.call_id) : null;
    if (!call || call.ended_at != null) return;
    const limits = this.resumeFor(a).limits;
    const now = this.now();
    const lastSeen = Math.max(a.last_seen_at ?? 0, call.started_at);
    if (now - lastSeen >= limits.quiet_minutes * 60_000 && !(call.quiet_nudged_at != null && call.quiet_nudged_at >= lastSeen)) {
      this.store.patchCall(call.id, { nudges: call.nudges + 1, quiet_nudged_at: now });
      this.say(`quiet @${a.handle}: ${limits.quiet_minutes} min without a report → nudge`);
      this.fyiParent(a, `@${a.handle} posted nothing for ${limits.quiet_minutes} min; nudged it to post a progress update.`, { quiet_minutes: limits.quiet_minutes });
      try { await this.spawner.deliver(a, nudgeQuiet(limits.quiet_minutes)); } catch (e) { this.say(`deliver failed @${a.handle}: ${(e as Error).message}`); }
    }
    const mins = Math.floor((now - call.started_at) / 60_000);
    if (!call.long_notified && now - call.started_at >= limits.max_call_minutes * 60_000) {
      this.store.patchCall(call.id, { long_notified: true });
      const lu = a.last_update ? `«${clip(a.last_update, 300)}» (${Math.round((now - (a.last_update_at ?? now)) / 60_000)} min ago)` : 'none';
      await this.notifyParent(a, `@${a.handle} has been working ${mins} min on this call; last update ${lu}. It is not stopped automatically — message it or release it if it is stuck.`, { minutes: mins });
    }
  }

  async snapshotTick(): Promise<void> {
    if (this.stopped) return;
    for (const a of this.store.agentsInState('working')) await this.snapshotOne(a);
  }

  async screen(agentId: string, lines = 200): Promise<{ text: string; live: boolean; at: number | null }> {
    const a = this.store.getAgent(agentId);
    if (!a) throw new HttpError(404, `No agent ${agentId}.`);
    if (a.state === 'working' && a.tmux_window_id) {
      try {
        const text = await this.spawner.capture(a, lines);
        const at = this.now();
        this.snapshots.set(a.id, { text, at });
        return { text, live: true, at };
      } catch { /* fall back to the snapshot */ }
    }
    const s = this.snapshots.get(a.id);
    return { text: s?.text ?? '', live: false, at: s?.at ?? null };
  }

  // ======================================================== boot recovery / release

  async recover(): Promise<void> {
    for (const a of this.store.agentsInState('working')) {
      let alive = false;
      if (a.tmux_window_id) { try { alive = await this.spawner.isAlive(a); } catch { alive = false; } }
      if (alive) { this.say(`recover: re-adopted @${a.handle} (${a.tmux_window_id})`); continue; }
      // Not alive (or the id now names someone else's window): forget the id, never stop by it.
      const ended = this.endCall(a, 'server_restart', { state: 'crashed', close: 'dead' });
      await this.notifyParent(ended, `@${a.handle} was interrupted by a server restart; message @${a.handle} to resume it.`, {});
    }
    // Probes from a doctor run the restart interrupted are done for: close and retire them.
    for (const a of this.store.listAgents(DOCTOR_PROJECT)) if (a.kind === 'probe' && a.state !== 'retired') await this.retireProbe(a.id);
    // Windows left open by an interrupted close grace period.
    for (const a of this.store.listAgents()) {
      if (a.kind !== 'human' && a.state !== 'working' && a.tmux_window_id) {
        await this.stopIfOurs(a);
        this.saveAgent(a.id, { tmux_window_id: null });
      }
    }
    await this.dequeue();
  }

  async release(caller: Agent, ref: string): Promise<Agent> {
    if (!isText(ref)) throw new HttpError(400, 'release needs {agent} ("@handle" or agent id)');
    const t = this.resolveAgent(caller.project_id, ref);
    if (!t || t.project_id !== caller.project_id) throw new HttpError(404, `No agent ${ref} in project ${caller.project_id}. Roster: ${this.rosterText(caller.project_id)}`);
    if (t.kind === 'human') throw new HttpError(400, 'The human captain cannot be released.');
    if (!(t.parent_id === caller.id || caller.kind === 'human')) {
      throw new HttpError(403, `Only @${this.handleOf(t.parent_id ?? '')} (its parent) or the human captain may release @${t.handle}.`);
    }
    if (t.state === 'retired') return t;
    const timer = this.closeTimers.get(t.id);
    if (timer !== undefined) { this.clock.clearTimeout(timer); this.closeTimers.delete(t.id); }
    await this.stopIfOurs(t, true);
    const cur = this.store.getAgent(t.id)!;
    if (cur.call_id) this.endCall(cur, 'released', { state: 'retired', close: 'none' });
    this.store.dropPending(t.id);
    const out = this.saveAgent(t.id, { state: 'retired', tmux_window_id: null, call_id: null, queued_at: null });
    this.say(`release @${t.handle} by @${caller.handle}`);
    await this.dequeue();
    return out;
  }

  // ======================================================== cards

  private resolveAssignee(project: string, ref: string | null | undefined): string | null {
    if (ref != null && typeof ref !== 'string') throw new HttpError(400, 'assignee must be "@handle", an agent id, or null');
    if (ref == null || ref === '' || ref === 'none' || ref === '@none') return null;
    const a = this.resolveAgent(project, ref);
    if (!a || a.project_id !== project) throw new HttpError(404, `No agent ${ref} in project ${project}. Roster: ${this.rosterText(project)}`);
    return a.id;
  }

  propose(caller: Agent, req: { title: string; details?: string; category?: string }): Card {
    if (!isText(req?.title)) throw new HttpError(400, 'propose needs {title} as a non-empty string');
    optStr(req.details, 'details'); optStr(req.category, 'category');
    const now = this.now();
    const c = this.store.insertCard({
      project_id: caller.project_id, title: req.title.trim(), details: req.details ?? '', category: req.category ?? null,
      state: 'proposed', position: this.store.maxPosition(caller.project_id, 'proposed') + 1, assignee_id: null,
      created_by: caller.id, notes: [], created_at: now, updated_at: now,
    });
    this.emit({ type: 'card.updated', project_id: c.project_id, card: c });
    this.say(`propose #${c.id} by @${caller.handle}: ${clip(c.title, 60)}`);
    return c;
  }

  createCard(caller: Agent | null, req: CardCreateReq & { project?: string }): Card {
    if (!isText(req?.title)) throw new HttpError(400, 'card needs {title} as a non-empty string');
    optStr(req.details, 'details'); optStr(req.category, 'category'); optStr(req.assignee, 'assignee'); optStr(req.project, 'project');
    if (caller && !this.isCaptain(caller)) throw new HttpError(403, `@${caller.handle} is not a captain; use \`sparrow propose\` to suggest a card.`);
    const project = caller ? caller.project_id : req.project;
    if (!project || !this.store.getProject(project)) throw new HttpError(400, `card needs a valid {project}${project ? ` (no project ${project})` : ''}`);
    const state: CardState = req.state ?? 'todo';
    if (!CARD_STATES.includes(state)) throw new HttpError(400, `state must be one of ${CARD_STATES.join(', ')}`);
    const now = this.now();
    const c = this.store.insertCard({
      project_id: project, title: req.title.trim(), details: req.details ?? '', category: req.category ?? null, state,
      position: this.store.maxPosition(project, state) + 1, assignee_id: this.resolveAssignee(project, req.assignee),
      created_by: caller?.id ?? 'user', notes: [], created_at: now, updated_at: now,
    });
    this.emit({ type: 'card.updated', project_id: c.project_id, card: c });
    this.say(`card #${c.id} created by ${caller ? '@' + caller.handle : 'UI'}: ${clip(c.title, 60)}`);
    return c;
  }

  /** Tracking only: NEVER spawns, wakes or messages anyone. */
  patchCard(caller: Agent | null, id: number, req: CardPatchReq): Card {
    const card = this.store.getCard(Number(id));
    if (!card) throw new HttpError(404, `No card #${id}.`);
    if (caller && caller.project_id !== card.project_id) throw new HttpError(404, `No card #${id} in project ${caller.project_id}.`);
    const by = caller ? caller.handle : 'user';
    const captain = !caller || this.isCaptain(caller);
    if (!captain) {
      if (card.assignee_id !== caller!.id) throw new HttpError(403, `@${caller!.handle} may only update cards assigned to it (card #${id} is not); use \`sparrow propose\` or ask your captain.`);
      const allowed = (req.state === undefined || req.state === 'review') && req.assignee === undefined && req.title === undefined
        && req.details === undefined && req.position === undefined;
      if (!allowed) throw new HttpError(403, `As the assignee, @${caller!.handle} may only add notes and move card #${id} to review.`);
    }
    const patch: Partial<Card> = {};
    if (req.state !== undefined) {
      if (!CARD_STATES.includes(req.state)) throw new HttpError(400, `state must be one of ${CARD_STATES.join(', ')}`);
      patch.state = req.state;
      if (req.position === undefined && req.state !== card.state) patch.position = this.store.maxPosition(card.project_id, req.state) + 1;
    }
    if (req.position !== undefined) {
      if (typeof req.position !== 'number' || !Number.isFinite(req.position)) throw new HttpError(400, 'position must be a number');
      patch.position = req.position;
    }
    if (req.title !== undefined) { if (!isText(req.title)) throw new HttpError(400, 'title must be a non-empty string'); patch.title = req.title; }
    if (req.details !== undefined) { if (typeof req.details !== 'string') throw new HttpError(400, 'details must be a string'); patch.details = req.details; }
    if (req.assignee !== undefined) patch.assignee_id = this.resolveAssignee(card.project_id, req.assignee);
    const notes = [...card.notes];
    if (req.note !== undefined && req.note !== null && typeof req.note !== 'string') throw new HttpError(400, 'note must be a string');
    if (isText(req.note)) notes.push({ at: this.now(), by, text: req.note.trim() });
    if (req.state !== undefined && req.state !== card.state && caller) notes.push({ at: this.now(), by, text: `moved ${card.state} → ${req.state}` });
    if (notes.length !== card.notes.length) patch.notes = notes;
    const c = this.saveCard(card.id, patch);
    this.say(`card #${c.id} ${req.state && req.state !== card.state ? `${card.state} → ${c.state} ` : ''}by ${caller ? '@' + by : 'UI'}`);
    return c;
  }

  // ======================================================== reads

  listProjects() {
    return this.store.listProjects().filter((p) => p.id !== DOCTOR_PROJECT).map((p) => {
      const agents = this.store.listAgents(p.id).filter((a) => a.kind === 'agent');
      return { ...p, agents: agents.length, working: agents.filter((a) => a.state === 'working').length, cards: this.store.countCards(p.id) };
    });
  }

  agentDetail(id: string) {
    const agent = this.store.getAgent(id);
    if (!agent) throw new HttpError(404, `No agent ${id}.`);
    return { agent, calls: this.store.callsFor(id, 20).map(publicCall), children: this.store.children(id) };
  }

  messages(q: { project?: string | null; thread?: string | null; after?: number | null; limit?: number; caller?: Agent | null }): MessageView[] {
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
    let thread = q.thread || null;
    let fromOrTo: string | null = null;
    let project = q.project || q.caller?.project_id || null;
    if (thread === 'group') return []; // group chat was removed; its old rows stay in the DB, hidden
    if (thread && !thread.startsWith('dm:')) {
      const t = this.resolveAgent(project, thread);
      if (!t) throw new HttpError(404, `No agent ${thread}${project ? ` in project ${project}` : ''}.`);
      project = t.project_id;
      if (q.caller && q.caller.id !== t.id) thread = this.dmThread(q.caller.id, t.id);
      else { thread = null; fromOrTo = t.id; }
    }
    const rows = this.store.listMessages({ project, thread, after: q.after ?? null, limit, fromOrTo });
    // Probe traffic stays out of chat unless the _doctor project is asked for explicitly.
    return (project ? rows : rows.filter((m) => m.project_id !== DOCTOR_PROJECT)).map((m) => this.view(m));
  }

  threads(project: string) {
    if (!project) throw new HttpError(400, 'threads needs ?project=');
    // DM threads only (threadSummaries leaves out old 'group' rows), most recent first.
    return this.store.threadSummaries(project).map((s) => {
      const last = this.view(this.store.messageBySeq(s.last_seq)!);
      const members = s.thread.split(':').slice(1).map((id) => this.handleOf(id));
      return { thread: s.thread, label: this.threadLabel(s.thread, true), members, last, count: s.count };
    });
  }

  // ======================================================== shutdown

  stop() {
    this.stopped = true;
    for (const t of this.closeTimers.values()) this.clock.clearTimeout(t);
    for (const t of this.otherTimers) this.clock.clearTimeout(t);
    this.closeTimers.clear();
    this.otherTimers.clear();
    for (const set of this.waiters.values()) for (const w of [...set]) w();
    this.waiters.clear();
  }
}
