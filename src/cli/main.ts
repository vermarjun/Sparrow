// `sparrow` CLI entry. Every agent (and the captain) talks to the server through these commands.
// Output is plain text for models; `--json` prints the raw server response instead.
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { api, ApiError, type ApiOpts } from './client';
import { AGENT_ENV_VARS, inAgentWindow, lifecycleRefusal, lostIdentityRefusal } from './guard';
import { BIN, LOG_FILE, PORT, REPO_ROOT, SERVER_URL, SPARROW_HOME, TMUX_SOCKET } from '../shared/config';
import { CARD_STATES } from '../shared/types';
import { CARD_SORTS, cardKey, parseCardRef, sortCardsBy } from '../shared/cards';
import type {
  Agent, Card, CardState, CaptainDetail, CaptainStartReq, CaptainStartRes, CaptainSummary, DoneStatus, EndCallRes, HireRes,
  InboxRes, MessageRes, MessageView, Project, RegisterCaptainReq, RegisterCaptainRes, ResumeView,
} from '../shared/types';
import {
  age, agentSummary, captainHint, captainSelf, captainStartText, captainsTable, cardBoard, cardBriefText, cardDetail, hhmm,
  inboxBlock, logLines, oneLine, resumesDirectory, rosterTable, teamDigest, tmuxAttach,
} from './format';

/** Messages that wake their recipient. Quiet deliveries (amendment A5) are updates and FYI system notices. */
const wakes = (m: MessageView) => m.kind !== 'update' && !(m.meta as { fyi?: unknown } | null)?.fyi;

const GROUP_REMOVED = 'group chat was removed; DM a teammate: sparrow send @<handle> "…"';
const isGroup = (t: string | undefined) => !!t && ['group', '@group'].includes(t.trim().toLowerCase());

// ---------------------------------------------------------------- usage

const USAGE: Record<string, string> = {
  up: 'sparrow up [--port N] [--home DIR] [--max-running N] [--tmux] [--sandbox]   start the server (foreground; --tmux: in tmux session \'sparrow\', window \'server\'; --home must equal SPARROW_HOME and shows in ps; agents may only use --sandbox with a non-default SPARROW_HOME)',
  sandbox: 'sparrow sandbox up [--dir path] | down [--dir path]   a throwaway server: own home, free port (never 4040), tmux socket; allowed for agents',
  install: 'sparrow install [--force]   seed resumes, link ~/.local/bin/sparrow, install skills + harness assets',
  stop: 'sparrow stop [--sandbox]   stop the server of this SPARROW_HOME/SPARROW_PORT (agents: --sandbox, with SPARROW_HOME set to a non-default dir)',
  captain: 'sparrow captain [--cwd dir] [--name n] [--title "<what it works on>"] [--model m] [--effort e] | resume <@handle|id> | adopt <@handle>   launch a new Claude Code captain in tmux; reopen one on its session; or bind THIS session to an existing captain (after /clear)',
  captains: 'sparrow captains [--all]   this project\'s captains: handle, title, status, team (working/total), last activity, resume line; --all adds archived',
  title: 'sparrow title "<what you work on>"   name this captain\'s work (human captains; shown in the UI and `sparrow captains`)',
  status: 'sparrow status   server health + working agents and their windows',
  whoami: 'sparrow whoami   who I am: handle, project, and for a captain its title, fleet and resume line',
  resumes: 'sparrow resumes   the directory: slug, title, harness/model/effort, status, can_hire, description',
  roster: 'sparrow roster [--all]   agents in my project',
  hire: 'sparrow hire <resume> "<task>" [--name h] [--cwd d] [--tmux-session s] [--tmux-window w] [--card N] [--model m] [--effort e]',
  send: 'sparrow send <@handle> "<text>" [--card N]',
  update: 'sparrow update "<text>" [--card N]',
  ask: 'sparrow ask "<question>"',
  done: 'sparrow done "<summary>" [--status ok|blocked|failed]',
  wait: 'sparrow wait ["<reason>"]',
  inbox: 'sparrow inbox [--wait SEC] [--last [N]]   (SEC ≤ 600; N 1–50, default 10)',
  log: 'sparrow log [@handle] [-n 30]',
  propose: 'sparrow propose "<title>" [--context c] [--problem p] [--approach a] [--check "…"]… [--category c] [--tag t]… [--urgent] [--impact|--return low|medium|high] [--effort low|medium|high] [--estimate 2h] [--details d] [--blocked "on"]',
  card: 'sparrow card list [--state s] [--sort newest|oldest|urgent|roi|impact|effort|estimate|updated] [--category c] [--urgent] [--blocked] [--all] | show <N> [--json] | pick <N> | add "<title>" [ticket flags] | edit <N> [ticket flags] | move <N> <state> | assign <N> <@h|me|none> | note|comment <N> "<text>" | block <N> "<who/what>" | unblock <N> | later <N> [--undo] | urgent <N> [--undo] | check <N> <i> [--undo]',
  release: 'sparrow release <@handle>',
  hook: 'sparrow hook <kind> [...]   internal (harness hooks)',
};

function fullUsage(): string {
  return [
    'sparrow — local agent factory. Text arguments may be `-` to read stdin (use a quoted heredoc).',
    '',
    '  sparrow   start detached if needed, open the UI, and return',
    ...Object.values(USAGE).map((u) => '  ' + u),
    '',
    'Global: --json prints the raw server response.  Server: ' + SERVER_URL,
  ].join('\n');
}

class UsageError extends Error {
  constructor(public cmd: string, message: string) { super(message); }
}

// ---------------------------------------------------------------- context

interface Ctx {
  json: boolean;
  agentId: string | null;   // identity used for requests
  captain: boolean;         // true = human captain mode (no SPARROW_AGENT_ID)
  me: Agent | null;
  project: Project | null;
  inbox: MessageView[];
  notices: string[];        // one-time hints (a new captain was created); printed before the output, never with --json
}

interface Out {
  raw: unknown;             // printed with --json
  text?: string;            // printed before the inbox block
  trailer?: string;         // printed after the inbox block
  alreadyDelivered?: boolean;
}

function collect(ctx: Ctx, res: any) {
  const box = res && Array.isArray(res.inbox) ? (res.inbox as MessageView[]) : [];
  for (const m of box) if (!ctx.inbox.some((x) => x.id === m.id)) ctx.inbox.push(m);
}

async function call<T = any>(ctx: Ctx, method: string, path: string, body?: unknown, opts: ApiOpts = {}): Promise<T> {
  const res = await api<T>(method, path, body, { agentId: ctx.agentId, ...opts });
  collect(ctx, res);
  return res;
}

function detectHarness(env = process.env): { harness?: string; session_id?: string } {
  if (env.CLAUDECODE) return { harness: 'claude', session_id: env.CLAUDE_CODE_SESSION_ID || undefined };
  if (Object.keys(env).some((k) => k.startsWith('CODEX_') && k !== 'CODEX_HOME'))
    return { harness: 'codex', session_id: env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || undefined };
  if (env.OPENCODE) return { harness: 'opencode', session_id: env.OPENCODE_SESSION_ID || undefined };
  return {};
}

/** Make sure we have an identity: SPARROW_AGENT_ID, or register as this project's human captain. */
async function identify(ctx: Ctx, opts: { noInbox?: boolean } = {}): Promise<void> {
  if (ctx.agentId) return;
  const envId = process.env.SPARROW_AGENT_ID;
  if (envId) { ctx.agentId = envId; return; }
  const lost = lostIdentityRefusal();
  if (lost) throw new Error(lost);
  await register(ctx, {}, opts);
}

/** The captain's identity request: cwd, harness session, SPARROW_CAPTAIN_ID (wins on the server), plus `extra` (adopt). */
function registerBody(extra: Partial<RegisterCaptainReq> = {}): RegisterCaptainReq {
  const body: RegisterCaptainReq = { cwd: process.cwd() };
  const det = detectHarness();
  if (det.harness) body.harness = det.harness;
  if (det.session_id) body.session_id = det.session_id;
  const captainId = process.env.SPARROW_CAPTAIN_ID?.trim();
  if (captainId) body.captain_id = captainId;
  // /clear gives Claude Code a new session id in the same process: the pid lets the server re-attach this session.
  const pid = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(pid) && pid > 0) body.pid = pid;
  return { ...body, ...extra };
}

async function register(ctx: Ctx, extra: Partial<RegisterCaptainReq>, opts: { noInbox?: boolean } = {}): Promise<RegisterCaptainRes> {
  const path = opts.noInbox ? '/api/captains/register?no_inbox=1' : '/api/captains/register';
  const res = await api<RegisterCaptainRes>('POST', path, registerBody(extra), { agentId: null });
  if (!opts.noInbox) collect(ctx, res);
  ctx.agentId = res.agent.id;
  ctx.me = res.agent;
  ctx.project = res.project;
  ctx.captain = true;
  if (res.created) ctx.notices.push(captainHint(res.agent, res.project));
  return res;
}

/** Who am I + my project (captain mode already knows from register). */
async function self(ctx: Ctx): Promise<{ me: Agent; project: Project; parent: Agent | null }> {
  await identify(ctx);
  if (ctx.me && ctx.project && ctx.captain) return { me: ctx.me, project: ctx.project, parent: null };
  const res = await call<{ agent: Agent; project: Project; parent: Agent | null }>(ctx, 'GET', '/api/whoami');
  ctx.me = res.agent;
  ctx.project = res.project;
  return { me: res.agent, project: res.project, parent: res.parent };
}

/** Does this shell carry any sign of being a captain session (agent id, SPARROW_CAPTAIN_ID, a harness session id)? */
const hasIdentitySignal = () => !!(process.env.SPARROW_AGENT_ID || process.env.SPARROW_CAPTAIN_ID || detectHarness().session_id);

/** The project of cwd without creating or needing a captain row (server rule: worktrees belong to their repo's project). */
async function resolveProject(cwd = process.cwd()): Promise<Project> {
  return api<Project>('GET', `/api/projects/resolve?cwd=${encodeURIComponent(cwd)}`, undefined, { agentId: null });
}

/**
 * Project-only commands (captains, captain resume, card list/show) never create or require a captain: an identified call
 * goes through identify(); when register answers 409 (ambiguous plain shell) or there is no identity signal at all, the
 * project comes from the server's cwd resolution. `meId` is null for the unidentified call.
 */
async function projectScope(ctx: Ctx, opts: { quietShell?: boolean } = {}): Promise<{ project: Project; meId: string | null }> {
  if (ctx.me && ctx.project) return { project: ctx.project, meId: ctx.me.id };
  if (opts.quietShell && !hasIdentitySignal()) return { project: await resolveProject(), meId: null };
  try {
    const { me, project } = await self(ctx);
    return { project, meId: me.id };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409 || process.env.SPARROW_AGENT_ID) throw e;
    ctx.agentId = null; ctx.captain = false; ctx.me = null;
    return { project: await resolveProject(), meId: null };
  }
}

/** `all` = archived and phantom (no title, no team) captains too. */
const captainsPath = (project: Project, all: boolean) =>
  `/api/captains?project=${encodeURIComponent(project.id)}${all ? '&archived=1&all=1' : ''}`;

/** Best effort: the captain's resume lines for whoami / start output. */
async function captainDetail(ctx: Ctx, id: string): Promise<CaptainDetail | null> {
  try { return await api<CaptainDetail>('GET', `/api/captains/${encodeURIComponent(id)}`, undefined, { agentId: ctx.agentId, retries: 0, timeoutMs: 5000 }); } catch { return null; }
}

// ---------------------------------------------------------------- arg helpers

type Opts = NonNullable<ParseArgsConfig['options']>;

/**
 * Split argv into declared flags (+ their values) and positionals BEFORE parseArgs, so text that starts with
 * "-" ("- fixed the bug", "-5 tests pass", "--force push to main") is accepted as text. Rules:
 *   - everything after a literal `--` is positional; a lone `-` is positional (= stdin)
 *   - `--name`, `--name=v`, `-x` for DECLARED options are flags; string options take the next token as value
 *   - an undeclared token shaped exactly like a flag (`--bogus`, `-q`, no spaces) is a usage error
 *   - anything else (spaces, digits after "-", "- ") is positional text
 */
export function splitArgs(args: string[], options: Opts): { flags: string[]; positionals: string[]; unknown: string | null } {
  const flags: string[] = [];
  const positionals: string[] = [];
  const shorts = new Map<string, string>();
  for (const [name, o] of Object.entries(options)) if (o.short) shorts.set(o.short, name);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positionals.push(...args.slice(i + 1)); break; }
    let name: string | undefined;
    let inlineValue = false;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = a.slice(2, eq === -1 ? undefined : eq);
      inlineValue = eq !== -1;
    } else if (/^-[A-Za-z]$/.test(a)) name = shorts.get(a[1]) ?? a.slice(1);
    if (name !== undefined && Object.hasOwn(options, name)) {
      // `--name=value` form, so parseArgs accepts values that start with "-" ("--details '- bullet'").
      if (options[name].type === 'string' && !inlineValue && i + 1 < args.length) flags.push(`--${name}=${args[++i]}`);
      else flags.push(a);
      continue;
    }
    if (/^--?[A-Za-z][\w-]*(=\S*)?$/.test(a)) return { flags, positionals, unknown: a };
    positionals.push(a);
  }
  return { flags, positionals, unknown: null };
}

function parse(cmd: string, args: string[], options: Opts = {}): { values: Record<string, any>; positionals: string[] } {
  const all: Opts = { ...options, help: { type: 'boolean', short: 'h' } };
  const split = splitArgs(args, all);
  if (split.unknown)
    throw new UsageError(cmd, `unknown option '${split.unknown}' (if this is text, put it after -- or pass it with - and a heredoc)`);
  try {
    const r = parseArgs({ args: [...split.flags, '--', ...split.positionals], options: all, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, any>, positionals: r.positionals };
  } catch (e) {
    throw new UsageError(cmd, (e as Error).message.split('. To specify')[0]);
  }
}

let stdinCache: string | null = null;
/** stdin with exactly one trailing newline removed (heredocs add one); nothing else is touched. */
async function readStdin(): Promise<string> {
  if (stdinCache === null) stdinCache = (await Bun.stdin.text()).replace(/\r?\n$/, '');
  return stdinCache;
}

/** Text argument: positionals joined by spaces; a single `-` reads stdin. Never trimmed (only checked for emptiness). */
async function textArg(cmd: string, parts: string[], what: string, required = true): Promise<string> {
  const text = parts.length === 1 && parts[0] === '-' ? await readStdin() : parts.join(' ');
  if (!text.trim()) {
    if (required) throw new UsageError(cmd, `missing ${what}`);
    return '';
  }
  return text;
}

function intArg(cmd: string, v: string | undefined, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (v === undefined) return undefined;
  const s = v.replace(/^#/, '');
  if (!/^\d+$/.test(s)) throw new UsageError(cmd, `${what} must be a number, got "${v}"`);
  const n = Number(s);
  if (n < min || n > max) throw new UsageError(cmd, `${what} must be between ${min} and ${max}`);
  return n;
}

function handleArg(v: string): string {
  const h = v.trim();
  return h.startsWith('@') ? h : '@' + h;
}

function cardState(cmd: string, v: string): CardState {
  const s = v.trim().toLowerCase().replace(/[- ]/g, '_');
  const alias: Record<string, CardState> = { inprogress: 'in_progress', doing: 'in_progress', to_do: 'todo' };
  const st = (alias[s] ?? s) as CardState;
  if (!CARD_STATES.includes(st)) throw new UsageError(cmd, `unknown card state "${v}" (one of: ${CARD_STATES.join(', ')})`);
  return st;
}

function cardIdArg(cmd: string, value: string, what = '<N>'): number {
  const id = parseCardRef(value);
  if (id == null) throw new UsageError(cmd, `${what} must be 12, #12 or PLU-12 (got "${value}")`);
  return id;
}

const cardCreateOptions: Opts = {
  context: { type: 'string' }, problem: { type: 'string' }, approach: { type: 'string' },
  check: { type: 'string', multiple: true }, category: { type: 'string' }, tag: { type: 'string', multiple: true },
  urgent: { type: 'boolean' }, impact: { type: 'string' }, return: { type: 'string' }, effort: { type: 'string' },
  estimate: { type: 'string' }, details: { type: 'string' }, blocked: { type: 'string' },
};

const cardEditOptions: Opts = {
  ...cardCreateOptions,
  urgent: { type: 'string' }, later: { type: 'string' },
  title: { type: 'string' },
};

const flagValues = (v: unknown): string[] => v === undefined ? [] : Array.isArray(v) ? v as string[] : [v as string];
const flagText = async (v: string) => v === '-' ? readStdin() : v;

async function cardFields(values: Record<string, any>, mode: 'create' | 'edit' = 'create'): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  for (const f of ['title', 'context', 'problem', 'approach', 'details'] as const) {
    if (values[f] !== undefined) body[f] = await flagText(String(values[f]));
  }
  if (values.category !== undefined) body.category = mode === 'edit' && String(values.category).toLowerCase() === 'none' ? null : await flagText(String(values.category));
  if (values.check !== undefined) body.checks = await Promise.all(flagValues(values.check).map(flagText));
  if (values.tag !== undefined) body.tags = flagValues(values.tag);
  const impact = values.return ?? values.impact;
  if (impact !== undefined) body.impact = mode === 'edit' && String(impact).toLowerCase() === 'none' ? null : impact;
  if (values.effort !== undefined) body.effort = mode === 'edit' && String(values.effort).toLowerCase() === 'none' ? null : values.effort;
  if (values.estimate !== undefined) body.estimate_min = mode === 'edit' && String(values.estimate).toLowerCase() === 'none' ? null : values.estimate;
  if (values.blocked !== undefined) body.blocked_on = mode === 'edit' && String(values.blocked).toLowerCase() === 'off' ? null : values.blocked;
  if (mode === 'create' && values.urgent) body.urgent = true;
  if (mode === 'edit') {
    for (const field of ['urgent', 'later'] as const) if (values[field] !== undefined) {
      const value = String(values[field]).toLowerCase();
      if (!['on', 'off'].includes(value)) throw new UsageError('card', `--${field} must be on or off`);
      body[field] = value === 'on';
    }
  }
  return body;
}

// ---------------------------------------------------------------- commands

type Handler = (ctx: Ctx, args: string[]) => Promise<Out | number>;

const commands: Record<string, Handler> = {
  async stop(ctx, args) {
    const { values } = parse('stop', args, { sandbox: { type: 'boolean' } });
    const refusal = lifecycleRefusal('stop', !!values.sandbox);
    if (refusal) throw new Error(refusal);
    const { stopServer } = await import('./lifecycle');
    const text = await stopServer();
    return { raw: { ok: true, message: text }, text };
  },
  async captain(ctx, args) {
    const sub = args[0];
    if (sub === 'resume' || sub === 'adopt') {
      const { positionals } = parse('captain', args.slice(1));
      if (positionals.length !== 1) throw new UsageError('captain', `captain ${sub} takes exactly one <@handle>${sub === 'resume' ? ' or id' : ''}`);
      const target = positionals[0];
      if (sub === 'adopt') {
        if (!detectHarness().session_id)
          throw new Error('no harness session id here; run `sparrow captain adopt` inside the captain session you want to bind (Claude Code / Codex / OpenCode).');
        const res = await register(ctx, { adopt: handleArg(target).slice(1), captain_id: undefined });
        const c = res.agent.captain;
        return { raw: res, text: `This session is now @${res.agent.handle}${c?.title ? ` — ${c.title}` : ''} (project ${res.project.id}). Its team and inbox are yours again.` };
      }
      let id = target;
      if (!target.startsWith('ag_')) {
        const { project } = await projectScope(ctx, { quietShell: true });
        const list = await api<CaptainSummary[]>('GET', captainsPath(project, true), undefined, { agentId: null });
        const h = handleArg(target).slice(1).toLowerCase();
        const hit = list.find((c) => c.agent.handle === h);
        if (!hit) throw new Error(`no captain @${h} in ${project.id}${list.length ? ` (${list.map((c) => '@' + c.agent.handle).join(', ')})` : ''}`);
        id = hit.agent.id;
      }
      const res = await api<CaptainStartRes>('POST', `/api/captains/${encodeURIComponent(id)}/resume`, undefined, { agentId: null });
      return { raw: res, text: captainStartText(res, await captainDetail(ctx, res.agent_id ?? id), 'Resumed') };
    }
    const { values, positionals } = parse('captain', args, {
      cwd: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    });
    if (positionals.length) throw new UsageError('captain', `unexpected argument "${positionals[0]}" (subcommands: resume, adopt)`);
    if (inAgentWindow()) throw new Error('agents hire teammates (sparrow hire); only the user starts captains. Run `sparrow captain` from your own shell.');
    let cwd = process.cwd();
    if (values.cwd !== undefined) {
      cwd = resolve(values.cwd as string);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new UsageError('captain', `--cwd ${cwd} is not a directory`);
    }
    const body: CaptainStartReq = { cwd };
    if (values.name) body.name = String(values.name).replace(/^@/, '');
    if (values.title !== undefined) body.title = (await flagText(String(values.title))).trim();
    if (values.model) body.model = values.model;
    if (values.effort) body.effort = values.effort;
    const res = await api<CaptainStartRes>('POST', '/api/captain/start', body, { agentId: null });
    return { raw: res, text: captainStartText(res, res.agent_id ? await captainDetail(ctx, res.agent_id) : null, 'Captain') };
  },

  async captains(ctx, args) {
    const { values, positionals } = parse('captains', args, { all: { type: 'boolean' } });
    if (positionals.length) throw new UsageError('captains', 'unexpected positional argument');
    const { project, meId } = await projectScope(ctx, { quietShell: true });
    const list = await call<CaptainSummary[]>(ctx, 'GET', captainsPath(project, !!values.all));
    return { raw: list, text: captainsTable(list, project.id, meId, !!values.all) };
  },

  async title(ctx, args) {
    const { positionals } = parse('title', args);
    const title = (await textArg('title', positionals, '"<what you work on>"')).trim();
    await identify(ctx);
    if (!ctx.captain || !ctx.me) throw new Error('only a human captain has a title; agents are named by their resume and task.');
    const res = await call<{ agent: Agent }>(ctx, 'PATCH', `/api/captains/${encodeURIComponent(ctx.me.id)}`, { title });
    return { raw: res, text: `@${res.agent.handle} now works on: ${res.agent.captain?.title ?? title}` };
  },

  async whoami(ctx, args) {
    parse('whoami', args);
    const r = await self(ctx);
    const lines = [
      agentSummary(r.me),
      `  project ${r.project.id} (${r.project.root}) · parent ${r.parent ? '@' + r.parent.handle : '-'}`,
      `  can hire: ${r.me.can_hire.length ? r.me.can_hire.join(', ') : 'nobody'}`,
    ];
    if (ctx.captain) lines.push('  mode: human captain (no SPARROW_AGENT_ID)');
    const detail = await captainDetail(ctx, r.me.fleet_id ?? r.me.id);
    lines.push(...captainSelf(r.me, detail));
    return { raw: { ...r, ...(detail ? { fleet: detail.summary } : {}) }, text: lines.join('\n') };
  },

  async resumes(ctx, args) {
    parse('resumes', args);
    const list = await call<ResumeView[]>(ctx, 'GET', '/api/resumes');
    return { raw: list, text: resumesDirectory(list) + '\n\nHire: sparrow hire <slug> "<task>"' };
  },

  async roster(ctx, args) {
    const { values } = parse('roster', args, { all: { type: 'boolean' } });
    const { me, project } = await self(ctx);
    const all = await call<Agent[]>(ctx, 'GET', `/api/agents?project=${encodeURIComponent(project.id)}`);
    const byId = new Map(all.map((a) => [a.id, a]));
    const shown = all.filter((a) => values.all || a.state !== 'retired');
    // hierarchy order: roots first, then each agent's hires (oldest first)
    const ordered: Agent[] = [];
    const shownIds = new Set(shown.map((a) => a.id));
    const parentKey = (a: Agent) => (a.parent_id && shownIds.has(a.parent_id) ? a.parent_id : null);
    const kids = (pid: string | null) =>
      shown.filter((a) => parentKey(a) === pid).sort((a, b) => a.created_at - b.created_at);
    const walk = (pid: string | null) => { for (const a of kids(pid)) { ordered.push(a); walk(a.id); } };
    walk(null);
    for (const a of shown) if (!ordered.includes(a)) ordered.push(a);
    const display = ordered.map((a) => (a.id === me.id ? { ...a, handle: a.handle + ' (you)' } : a));
    const hidden = all.length - shown.length;
    const text = `Project ${project.id} — ${shown.length} agent${shown.length === 1 ? '' : 's'}${hidden ? ` (${hidden} retired hidden; --all)` : ''}\n` +
      rosterTable(display, byId);
    return { raw: all, text };
  },

  async hire(ctx, args) {
    const { values, positionals } = parse('hire', args, {
      name: { type: 'string' }, cwd: { type: 'string' }, 'tmux-session': { type: 'string' },
      'tmux-window': { type: 'string' }, card: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    });
    const [resume, ...rest] = positionals;
    if (!resume) throw new UsageError('hire', 'missing <resume> (see: sparrow resumes)');
    const task = await textArg('hire', rest, '"<task>"');
    let cwd = process.cwd();
    if (values.cwd !== undefined) {
      cwd = resolve(values.cwd as string);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new UsageError('hire', `--cwd ${cwd} is not a directory`);
    }
    const body: Record<string, unknown> = { resume, task, cwd };
    if (values.name) body.name = String(values.name).replace(/^@/, '');
    if (values['tmux-session']) body.tmux_session = values['tmux-session'];
    if (values['tmux-window']) body.tmux_window = values['tmux-window'];
    const card = values.card === undefined ? undefined : cardIdArg('hire', values.card as string, '--card');
    if (card !== undefined) body.card_id = card;
    if (values.model) body.model = values.model;
    if (values.effort) body.effort = values.effort;
    await identify(ctx);
    const res = await call<HireRes>(ctx, 'POST', '/api/hire', body);
    const a = res.agent;
    const state = a.state === 'queued'
      ? 'queued (max_running reached; starts when a slot frees)'
      : a.state;
    const override = res.message.meta.override as Partial<Record<'model' | 'effort', { resume: string | null; used: string }>> | undefined;
    const text = [
      `Hired @${a.handle} — ${a.title} (${a.resume}) · ${[a.harness, [a.model, a.effort].filter(Boolean).join('/')].filter(Boolean).join(' ')} · ${state}`,
      ...(['model', 'effort'] as const).flatMap((field) => override?.[field]
        ? [`Override: ${field} ${override[field]!.used} (resume says ${override[field]!.resume ?? 'default'}).`]
        : []),
      ...((res.message.meta.skills_warnings as string[] | undefined) ?? []).map((w) => `Skills: ${w}.`),
      `  id ${a.id} · cwd ${a.cwd}`,
      `  watch: ${tmuxAttach(a)}`,
      `  Its result arrives in your inbox (sparrow inbox --wait 600). Talk to it: sparrow send @${a.handle} "…"`,
    ].join('\n');
    return { raw: res, text };
  },

  async send(ctx, args) {
    const { values, positionals } = parse('send', args, { card: { type: 'string' } });
    const [target, ...rest] = positionals;
    if (!target) throw new UsageError('send', 'missing <@handle>');
    if (isGroup(target)) throw new UsageError('send', GROUP_REMOVED);
    const to = handleArg(target);
    const text = await textArg('send', rest, '"<text>"');
    const body: Record<string, unknown> = { to, text };
    const card = values.card === undefined ? undefined : cardIdArg('send', values.card as string, '--card');
    if (card !== undefined) body.card_id = card;
    await identify(ctx);
    const res = await call<MessageRes>(ctx, 'POST', '/api/send', body);
    return { raw: res, text: `Sent to ${to}.` };
  },

  async update(ctx, args) {
    const { values, positionals } = parse('update', args, { card: { type: 'string' } });
    const text = await textArg('update', positionals, '"<text>"');
    const body: Record<string, unknown> = { text };
    const card = values.card === undefined ? undefined : cardIdArg('update', values.card as string, '--card');
    if (card !== undefined) body.card_id = card;
    await identify(ctx);
    const res = await call<MessageRes>(ctx, 'POST', '/api/update', body);
    return { raw: res, text: 'Update posted.' };
  },

  async ask(ctx, args) {
    const { positionals } = parse('ask', args);
    const question = await textArg('ask', positionals, '"<question>"');
    await identify(ctx);
    return endCall(ctx, await call<EndCallRes>(ctx, 'POST', '/api/ask', { question }), 'Question sent to your parent', 'ask');
  },

  async done(ctx, args) {
    const { values, positionals } = parse('done', args, { status: { type: 'string' } });
    const summary = await textArg('done', positionals, '"<summary>"');
    const status = (values.status as string | undefined)?.toLowerCase();
    if (status && !['ok', 'blocked', 'failed'].includes(status))
      throw new UsageError('done', `--status must be ok, blocked or failed (got "${values.status}")`);
    const body: Record<string, unknown> = { summary };
    if (status) body.status = status as DoneStatus;
    await identify(ctx);
    return endCall(ctx, await call<EndCallRes>(ctx, 'POST', '/api/done', body), 'Result sent to your parent', 'done');
  },

  async wait(ctx, args) {
    const { positionals } = parse('wait', args);
    const reason = await textArg('wait', positionals, 'reason', false);
    await identify(ctx);
    return endCall(ctx, await call<EndCallRes>(ctx, 'POST', '/api/wait', reason ? { reason } : {}), 'Waiting', 'wait');
  },

  async inbox(ctx, args) {
    // parseArgs has no optional string value, so normalize `--last [N]` to its explicit form.
    const normalized: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--last') {
        const next = args[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) normalized.push(`--last=${args[++i]}`);
        else normalized.push('--last=10');
      } else normalized.push(args[i]);
    }
    const { values, positionals } = parse('inbox', normalized, { wait: { type: 'string' }, last: { type: 'string' } });
    if (positionals.length) throw new UsageError('inbox', 'unexpected positional argument');
    const wait = intArg('inbox', values.wait as string | undefined, '--wait', 0, 600);
    const last = intArg('inbox', values.last as string | undefined, '--last', 1, 50);
    await identify(ctx, { noInbox: last !== undefined });
    if (last !== undefined) {
      const res = await call<InboxRes>(ctx, 'GET', `/api/inbox?last=${last}`);
      return {
        raw: res,
        text: ctx.inbox.length ? undefined : 'No previously delivered messages.',
        trailer: teamDigest(res.team ?? []),
        alreadyDelivered: true,
      };
    }
    // Captain mode: register already piggybacked (and consumed) pending messages. If one of them wakes, show them now
    // without long-polling. Quiet ones alone (updates, FYI notices) must not end the wait: they print with what arrives.
    if (ctx.inbox.some(wakes)) return { raw: { inbox: ctx.inbox } };
    const path = wait ? `/api/inbox?wait=${wait}` : '/api/inbox';
    const res = await call<InboxRes>(ctx, 'GET', path, undefined, { timeoutMs: ((wait ?? 0) + 30) * 1000 });
    if (res.superseded) return {
      raw: res,
      text: 'Stopped: a newer `sparrow inbox --wait` took over. Nothing was taken from your inbox.',
    };
    const digest = teamDigest(res.team ?? []);
    return {
      raw: res,
      text: ctx.inbox.length ? undefined : `No new messages${wait ? ` (waited ${wait}s)` : ''}.`,
      trailer: digest ? (ctx.inbox.length ? '\n' : '') + digest : undefined,
    };
  },

  async log(ctx, args) {
    const { values, positionals } = parse('log', args, { n: { type: 'string', short: 'n' } });
    const n = intArg('log', values.n as string | undefined, '-n', 1, 10_000) ?? 30;
    const target = positionals[0];
    if (positionals.length > 1) throw new UsageError('log', 'at most one target (@handle)');
    if (isGroup(target)) throw new UsageError('log', 'group chat was removed; use sparrow log @<handle> (or no target for everything)');
    const { project } = await self(ctx);
    const all: MessageView[] = [];
    let after = 0;
    for (let page = 0; page < 1000; page++) {
      const q = `/api/messages?project=${encodeURIComponent(project.id)}&after=${after}&limit=100`;
      const batch = await call<MessageView[]>(ctx, 'GET', q);
      if (!batch.length) break;
      all.push(...batch);
      const last = batch[batch.length - 1].seq;
      if (batch.length < 100 || last <= after) break;
      after = last;
    }
    let msgs = all;
    if (target) {
      const h = handleArg(target).slice(1).toLowerCase();
      msgs = all.filter((m) => m.from_handle === h || m.to_handles.includes(h));
    }
    msgs = msgs.sort((a, b) => a.seq - b.seq).slice(-n);
    const head = `Log ${target ? handleArg(target) : 'all'} · project ${project.id} · last ${msgs.length}`;
    return { raw: msgs, text: `${head}\n${logLines(msgs)}` };
  },

  async propose(ctx, args) {
    const { values, positionals } = parse('propose', args, cardCreateOptions);
    const title = await textArg('propose', positionals, '"<title>"');
    const body: Record<string, unknown> = { title, ...await cardFields(values) };
    await identify(ctx);
    const res = await call<{ card: Card }>(ctx, 'POST', '/api/propose', body);
    return { raw: res, text: `Proposed ${cardKey(res.card)} "${res.card.title}" (proposed). A captain decides whether to take it.` };
  },

  async card(ctx, args) {
    const [sub = 'list', ...rest] = args[0]?.startsWith('-') && args[0] !== '-' ? ['list', ...args] : args;
    // Read-only subcommands (list, show) work from an ambiguous shell too; the rest need a captain identity.
    const handles = async (readOnly = false) => {
      const { project } = readOnly ? await projectScope(ctx) : await self(ctx);
      const agents = await call<Agent[]>(ctx, 'GET', `/api/agents?project=${encodeURIComponent(project.id)}`);
      return { project, handles: new Map(agents.map((a) => [a.id, a.handle])) };
    };
    switch (sub) {
      case 'list': case 'ls': {
        const { values } = parse('card', rest, {
          state: { type: 'string' }, sort: { type: 'string' }, category: { type: 'string' },
          urgent: { type: 'boolean' }, blocked: { type: 'boolean' }, all: { type: 'boolean' },
        });
        const { project, handles: hs } = await handles(true);
        const all = await call<Card[]>(ctx, 'GET', `/api/cards?project=${encodeURIComponent(project.id)}`);
        let cards = all.filter((c) => values.all || c.state !== 'dropped');
        if (values.state) {
          const state = cardState('card', values.state as string);
          cards = cards.filter((c) => c.state === state);
        }
        if (values.category) cards = cards.filter((c) => c.category === String(values.category).trim().toLowerCase());
        if (values.urgent) cards = cards.filter((c) => c.urgent);
        if (values.blocked) cards = cards.filter((c) => !!c.blocked_on);
        const sort = String(values.sort ?? 'manual').toLowerCase();
        if (!CARD_SORTS.some((x) => x.id === sort)) throw new UsageError('card', `--sort must be one of ${CARD_SORTS.map((x) => x.id).filter((x) => x !== 'manual').join(', ')}`);
        cards = sortCardsBy(cards, sort as any);
        return { raw: all, text: `Board · project ${project.id}\n${cardBoard(cards, hs)}` };
      }
      case 'show': {
        const { positionals } = parse('card', rest);
        if (positionals.length !== 1) throw new UsageError('card', 'card show <N>');
        const id = cardIdArg('card', positionals[0]);
        const { handles: hs } = await handles(true);
        const card = await call<Card>(ctx, 'GET', `/api/cards/${id}`);
        return { raw: card, text: cardDetail(card, hs) };
      }
      case 'pick': {
        const { positionals } = parse('card', rest);
        if (positionals.length !== 1) throw new UsageError('card', 'card pick <N>');
        const id = cardIdArg('card', positionals[0]);
        await identify(ctx);
        const res = await call<{ card: Card }>(ctx, 'PATCH', `/api/cards/${id}`, { assignee: 'me', state: 'in_progress' });
        const { handles: hs } = await handles();
        const key = cardKey(res.card);
        return { raw: res, text: `${cardBriefText(res.card, hs)}\n\nNext: work it; when the build is done run \`sparrow card move ${key} review\`. Never move it to done yourself; the user does that after review.` };
      }
      case 'add': {
        const { values, positionals } = parse('card', rest, { ...cardCreateOptions, state: { type: 'string' }, assignee: { type: 'string' } });
        const title = await textArg('card', positionals, '"<title>"');
        const body: Record<string, unknown> = { title, ...await cardFields(values) };
        if (values.state) body.state = cardState('card', values.state as string);
        if (values.assignee) body.assignee = String(values.assignee).toLowerCase() === 'me' ? 'me' : handleArg(values.assignee as string);
        await identify(ctx);
        const res = await call<{ card: Card }>(ctx, 'POST', '/api/cards', body);
        return { raw: res, text: `Added ${cardKey(res.card)} ${res.card.title} (${res.card.state}).` };
      }
      case 'edit': {
        const { values, positionals } = parse('card', rest, cardEditOptions);
        const [idArg, ...extra] = positionals;
        if (!idArg) throw new UsageError('card', 'card edit <N> [--title t] [ticket fields]');
        if (extra.length) throw new UsageError('card', 'card edit takes one card reference; use --title to change its title');
        const id = cardIdArg('card', idArg);
        const body = await cardFields(values, 'edit');
        if (!Object.keys(body).length) throw new UsageError('card', 'card edit needs at least one field flag');
        await identify(ctx);
        const res = await call<{ card: Card }>(ctx, 'PATCH', `/api/cards/${id}`, body);
        return { raw: res, text: `Edited ${cardKey(res.card)} ${res.card.title} (${res.card.state}).` };
      }
      case 'move': case 'assign': case 'note': case 'comment': case 'block': case 'unblock': case 'later': case 'urgent': case 'check': {
        const opts: Opts = ['later', 'urgent', 'check'].includes(sub) ? { undo: { type: 'boolean' } } : {};
        const { values, positionals } = parse('card', rest, opts);
        const [idArg, ...more] = positionals;
        if (!idArg) throw new UsageError('card', `missing <N> for card ${sub}`);
        const id = cardIdArg('card', idArg);
        const body: Record<string, unknown> = {};
        if (sub === 'move') {
          if (more.length !== 1) throw new UsageError('card', 'card move <N> <state>');
          body.state = cardState('card', more[0]);
        } else if (sub === 'assign') {
          if (more.length !== 1) throw new UsageError('card', 'card assign <N> <@h|none>');
          body.assignee = ['none', '-', 'nobody'].includes(more[0].toLowerCase()) ? null : more[0].toLowerCase() === 'me' ? 'me' : handleArg(more[0]);
        } else if (sub === 'note' || sub === 'comment') {
          body.note = await textArg('card', more, '"<text>"');
        } else if (sub === 'block') {
          body.blocked_on = await textArg('card', more, '"<who/what>"');
        } else if (sub === 'unblock') {
          if (more.length) throw new UsageError('card', 'card unblock <N>');
          body.blocked_on = null;
        } else if (sub === 'later' || sub === 'urgent') {
          if (more.length) throw new UsageError('card', `card ${sub} <N> [--undo]`);
          body[sub] = !values.undo;
        } else {
          if (more.length !== 1) throw new UsageError('card', 'card check <N> <i> [--undo]');
          const index = intArg('card', more[0], '<i>', 1);
          body.check = { index: index! - 1, done: !values.undo };
        }
        await identify(ctx);
        const res = await call<{ card: Card }>(ctx, 'PATCH', `/api/cards/${id}`, body);
        const labels: Record<string, string> = { move: 'Moved', assign: 'Assigned', note: 'Noted', comment: 'Commented', block: 'Blocked', unblock: 'Unblocked', later: values.undo ? 'Restored' : 'Shelved', urgent: values.undo ? 'Cleared urgent' : 'Marked urgent', check: values.undo ? 'Unchecked' : 'Checked' };
        return { raw: res, text: `${labels[sub]} ${cardKey(res.card)} ${res.card.title} (${res.card.state}).` };
      }
      default:
        throw new UsageError('card', `unknown subcommand "${sub}"`);
    }
  },

  async release(ctx, args) {
    const { positionals } = parse('release', args);
    if (positionals.length !== 1) throw new UsageError('release', 'release exactly one <@handle>');
    const target = positionals[0].startsWith('ag_') ? positionals[0] : handleArg(positionals[0]);
    await identify(ctx);
    const res = await call<{ agent: Agent }>(ctx, 'POST', '/api/release', { agent: target });
    return { raw: res, text: `Released @${res.agent.handle} (retired; its window is closed and it will not wake again).` };
  },

  async status(ctx, args) {
    parse('status', args);
    let health: { ok: boolean; version: string; pid: number; started_at: number };
    try {
      health = await api('GET', '/api/health', undefined, { retries: 0, timeoutMs: 3000, agentId: null });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        if (ctx.json) { console.log(JSON.stringify({ ok: false, url: SERVER_URL, port: PORT, log: LOG_FILE, pid: null }, null, 2)); return 1; }
        console.log(`Sparrow server: not running at ${SERVER_URL} · port ${PORT} · log ${LOG_FILE}\nStart it: sparrow`);
        return 1;
      }
      throw e;
    }
    const projects = await api<(Project & { agents: number; working: number; cards: number })[]>('GET', '/api/projects', undefined, { agentId: null });
    const agents: Agent[] = [];
    for (const p of projects) {
      if (!p.agents) continue;
      agents.push(...(await api<Agent[]>('GET', `/api/agents?project=${encodeURIComponent(p.id)}`, undefined, { agentId: null })));
    }
    const working = agents.filter((a) => a.state === 'working');
    const queued = agents.filter((a) => a.state === 'queued');
    const lines = [
      `Sparrow server: up · ${SERVER_URL} · pid ${health.pid} · v${health.version} · started ${hhmm(health.started_at)} (${age(health.started_at)})`,
      `Home: ${SPARROW_HOME} · port ${PORT} · log ${LOG_FILE} · UI: ${SERVER_URL}`,
      `Projects: ${projects.length ? projects.map((p) => `${p.id} (${p.working}/${p.agents} working, ${p.cards} cards)`).join(', ') : 'none yet'}`,
    ];
    if (working.length) {
      lines.push(`Working (${working.length}):`);
      for (const a of working) {
        lines.push(`  @${a.handle} [${a.project_id}] ${a.resume} · ${a.harness}${a.last_update ? ` · "${oneLine(a.last_update, 50)}" ${age(a.last_update_at)}` : ''}`);
        lines.push(`    ${tmuxAttach(a)}`);
      }
    } else lines.push('Working: none');
    if (queued.length) lines.push(`Queued (${queued.length}): ${queued.map((a) => `@${a.handle} [${a.project_id}]`).join(', ')}`);
    return { raw: { health, port: PORT, log: LOG_FILE, projects, working, queued }, text: lines.join('\n') };
  },

  async up(ctx, args) {
    const { values } = parse('up', args, { port: { type: 'string' }, home: { type: 'string' }, 'max-running': { type: 'string' }, tmux: { type: 'boolean' }, sandbox: { type: 'boolean' } });
    const refusal = lifecycleRefusal('up', !!values.sandbox, process.env, values.port as string | undefined);
    if (refusal) throw new Error(refusal);
    // --home exists so the server's command line names its home in `ps`; it may only restate SPARROW_HOME.
    if (values.home !== undefined && !sameDir(values.home as string, SPARROW_HOME))
      throw new Error(`--home ${values.home} disagrees with SPARROW_HOME ${SPARROW_HOME}; set SPARROW_HOME instead of passing a different --home.`);
    if (inAgentWindow()) {
      // An allowed sandbox start must not inherit the starting agent's identity or its server's URL.
      for (const k of [...AGENT_ENV_VARS, 'SPARROW_URL']) delete process.env[k];
    }
    const port = intArg('up', values.port as string | undefined, '--port', 1, 65535) ?? PORT;
    const maxRunning = intArg('up', values['max-running'] as string | undefined, '--max-running', 1, 64);
    if (maxRunning !== undefined) {
      const prev = process.env.SPARROW_SETTINGS ? JSON.parse(process.env.SPARROW_SETTINGS) : {};
      process.env.SPARROW_SETTINGS = JSON.stringify({ ...prev, max_running: maxRunning });
    }
    process.env.SPARROW_PORT = String(port);
    if (values.tmux) return upInTmux(port);
    const running = await probeHealth(port);
    if (running) {
      const foreign = await foreignServer(running.pid, port);
      if (foreign) { console.error(`sparrow up: ${foreign}`); return 1; }
      console.log(`Sparrow server already running on http://127.0.0.1:${port} (pid ${running.pid}).`);
      return 0;
    }
    let mod: any;
    try {
      mod = await import('../server/main');
    } catch (e) {
      console.error(`sparrow up: cannot load the server (src/server/main.ts): ${(e as Error).message}`);
      return 1;
    }
    const { webDir, webBuilt } = await import('./install');
    const webDist = join(webDir(), 'dist');
    if (!webBuilt()) console.log('UI not built — run `sparrow install` (or `cd web && bun run build`)');
    const srv = await mod.startServer({ port, ...(existsSync(webDist) ? { webDist } : {}) });
    console.log(`Sparrow server on http://127.0.0.1:${srv.port} · home ${SPARROW_HOME} · pid ${process.pid}${maxRunning ? ` · max_running ${maxRunning}` : ''}. Ctrl-C to stop.`);
    return await new Promise<number>((done) => {
      const stop = async () => {
        try { await srv.stop(); } catch {}
        done(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  },

  async sandbox(ctx, args) {
    const { values, positionals } = parse('sandbox', args, { dir: { type: 'string' } });
    const sub = positionals[0];
    if (positionals.length !== 1 || (sub !== 'up' && sub !== 'down')) throw new UsageError('sandbox', 'expected `up` or `down`');
    const sb = await import('./sandbox');
    if (sub === 'up') {
      const r = await sb.sandboxUp(values.dir as string | undefined);
      return { raw: { ...r.info, reused: r.reused }, text: r.text };
    }
    const text = await sb.sandboxDown(values.dir as string | undefined);
    return { raw: { ok: true, message: text }, text };
  },

  async install(ctx, args) {
    const { values } = parse('install', args, { force: { type: 'boolean' } });
    const { runInstall } = await import('./install');
    const res = await runInstall({ force: !!values.force });
    return { raw: res, text: res.text };
  },
};

const NOT_SENT: Record<'done' | 'ask' | 'wait', string> = {
  done: 'Not sent: new messages arrived (above). Handle them, then run sparrow done again with your complete report.',
  ask: 'Not sent: new messages arrived (above). Handle them; if you still need an answer, run sparrow ask again.',
  wait: 'Not sent: new messages arrived (above). Handle them, then run sparrow wait again if you are still waiting.',
};

async function endCall(ctx: Ctx, res: EndCallRes, what: string, kind: 'done' | 'ask' | 'wait'): Promise<Out> {
  if (!res.ended) return { raw: res, trailer: NOT_SENT[kind] };
  const text = ctx.captain
    ? `${what}. Recorded. Run \`sparrow inbox --wait 600\` to receive replies.`
    : 'Reported. This session will now close — stop here; you will be resumed with full memory when someone messages you.';
  return { raw: res, text };
}

/** Best effort: the project's agents, so inbox group headers can name each sender's resume. Never piggybacks. */
async function projectAgents(ctx: Ctx): Promise<Agent[]> {
  if (!ctx.project) return [];
  try {
    return await api<Agent[]>('GET', `/api/agents?project=${encodeURIComponent(ctx.project.id)}`, undefined, { agentId: ctx.agentId, retries: 0, timeoutMs: 5000 });
  } catch {
    return [];
  }
}

const sameDir = (a: string, b: string) => {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
};

/** Why the server already answering on `port` is not this SPARROW_HOME's (refuse, don't adopt), or null. */
async function foreignServer(pid: number, port: number): Promise<string | null> {
  const { foreignServer: check } = await import('./lifecycle');
  return check(pid, `http://127.0.0.1:${port}`);
}

async function probeHealth(port: number): Promise<{ pid: number } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

function tmuxCmd(...args: string[]) {
  const sock = TMUX_SOCKET ? ['-L', TMUX_SOCKET] : [];
  const p = Bun.spawnSync(['tmux', ...sock, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function upInTmux(port: number): Promise<number> {
  const SESSION = 'sparrow';
  const WINDOW = 'server';
  const attach = `tmux ${TMUX_SOCKET ? `-L ${TMUX_SOCKET} ` : ''}attach -t ${SESSION} \\; select-window -t ${WINDOW}`;
  const hasSession = tmuxCmd('has-session', '-t', `=${SESSION}`).code === 0;
  const windows = hasSession ? tmuxCmd('list-windows', '-t', `=${SESSION}`, '-F', '#{window_name}').out.split('\n') : [];
  const hasWindow = windows.includes(WINDOW);
  const there = await probeHealth(port);
  if (there) {
    const foreign = await foreignServer(there.pid, port);
    if (foreign) { console.error(`sparrow up --tmux: ${foreign}`); return 1; }
    console.log(`Sparrow server already running on http://127.0.0.1:${port}${hasWindow ? ` (tmux: ${attach})` : ''}.`);
    return 0;
  }
  const env: string[] = [];
  for (const k of ['SPARROW_HOME', 'SPARROW_PORT', 'SPARROW_URL', 'SPARROW_TMUX_SOCKET', 'SPARROW_TMUX_PREFIX', 'SPARROW_SETTINGS', 'SPARROW_WEB_DIR', 'PATH']) {
    const v = process.env[k];
    if (v !== undefined) env.push('-e', `${k}=${v}`);
  }
  const cmd = `${shq(process.execPath)} ${shq(BIN)} up --home ${shq(SPARROW_HOME)} --port ${port}; echo; echo "[sparrow] server exited ($?). Restart: sparrow up --tmux"; read -r _`;
  let r;
  if (!hasSession) r = tmuxCmd('new-session', '-d', '-s', SESSION, '-n', WINDOW, '-c', REPO_ROOT, ...env, cmd);
  else if (hasWindow) {
    // The window exists but the port does not answer: give a starting server a moment, then respawn.
    for (let i = 0; i < 6 && !(await probeHealth(port)); i++) await Bun.sleep(500);
    const late = await probeHealth(port);
    if (late) {
      const foreign = await foreignServer(late.pid, port);
      if (foreign) { console.error(`sparrow up --tmux: ${foreign}`); return 1; }
      console.log(`Sparrow server already running on http://127.0.0.1:${port} (tmux: ${attach}).`);
      return 0;
    }
    r = tmuxCmd('respawn-window', '-k', '-t', `=${SESSION}:${WINDOW}`, '-c', REPO_ROOT, ...env, cmd);
  } else r = tmuxCmd('new-window', '-d', '-t', `=${SESSION}:`, '-n', WINDOW, '-c', REPO_ROOT, ...env, cmd);
  if (r.code !== 0) {
    console.error(`sparrow up --tmux: tmux failed: ${r.err.trim()}`);
    return 1;
  }
  for (let i = 0; i < 40; i++) {
    const h = await probeHealth(port);
    if (h) {
      const { webBuilt } = await import('./install');
      if (!webBuilt()) console.log('UI not built — run `sparrow install` (or `cd web && bun run build`)');
      console.log(`Sparrow server running on http://127.0.0.1:${port} (pid ${h.pid}) in tmux session '${SESSION}', window '${WINDOW}'.\n  watch: ${attach}`);
      return 0;
    }
    await Bun.sleep(250);
  }
  const screen = tmuxCmd('capture-pane', '-p', '-t', `=${SESSION}:${WINDOW}`).out.trim().split('\n').slice(-15).join('\n');
  console.error(`sparrow up --tmux: server did not answer on port ${port} within 10s. Window output:\n${screen}`);
  return 1;
}

// ---------------------------------------------------------------- entry

export async function main(argv: string[]): Promise<number> {
  // `--json` is global and may appear anywhere before a literal `--` (after it, it is text).
  const dd = argv.indexOf('--');
  const head = dd === -1 ? argv : argv.slice(0, dd);
  const tail = dd === -1 ? [] : argv.slice(dd);
  const json = head.includes('--json');
  const [cmd, ...args] = [...head.filter((a) => a !== '--json'), ...tail];
  const flagArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  if (!cmd) {
    const refusal = lifecycleRefusal('up', false);
    if (refusal) { console.error(`sparrow: ${refusal}`); return 1; }
    try {
      const { openUi } = await import('./lifecycle');
      const r = await openUi({ say: json ? undefined : (l) => console.log(l) });
      console.log(json ? JSON.stringify(r, null, 2) : `Sparrow: ${r.url} (pid ${r.health.pid})\nLog: ${r.log}`);
      return 0;
    } catch (e) { console.error(`sparrow: ${(e as Error).message}`); return 1; }
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    if (cmd && args[0] && USAGE[args[0]]) console.log('usage: ' + USAGE[args[0]]);
    else console.log(fullUsage());
    return cmd ? 0 : 2;
  }
  if (cmd === '--version' || cmd === 'version') {
    console.log('sparrow 0.1.0');
    return 0;
  }

  if (cmd === 'hook') {
    const [kind, ...rest] = args;
    if (!kind) { console.error('usage: ' + USAGE.hook); return 2; }
    let mod: any;
    try {
      mod = await import('./hook');
    } catch (e) {
      // Hooks must never break a harness: report on stderr, exit 0.
      console.error(`sparrow hook: hook module unavailable (src/cli/hook.ts): ${(e as Error).message}`);
      return 0;
    }
    return await mod.runHook(kind, rest);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`sparrow: unknown command "${cmd}"\n\n${fullUsage()}`);
    return 2;
  }
  if (flagArgs.includes('--help') || flagArgs.includes('-h')) {
    console.log('usage: ' + USAGE[cmd]);
    return 0;
  }

  const ctx: Ctx = { json, agentId: null, captain: false, me: null, project: null, inbox: [], notices: [] };
  try {
    const out = await handler(ctx, args);
    if (typeof out === 'number') return out;
    if (json) {
      const raw = out.raw && typeof out.raw === 'object' && !Array.isArray(out.raw)
        ? { ...(out.raw as object), inbox: ctx.inbox }
        : out.raw;
      console.log(JSON.stringify(raw, null, 2));
      return 0;
    }
    for (const n of ctx.notices) console.log(n);
    if (out.text) console.log(out.text);
    if (ctx.inbox.length) {
      let handle = ctx.me?.handle ?? null;
      if (!handle) {
        try { handle = (await self(ctx)).me.handle; } catch {}
      }
      if (out.text) console.log('');
      console.log(inboxBlock(ctx.inbox, handle, await projectAgents(ctx), { alreadyDelivered: out.alreadyDelivered }));
    }
    if (out.trailer) console.log(out.trailer);
    return 0;
  } catch (e) {
    const usage = e instanceof UsageError;
    const msg = (e as Error).message;
    if (e instanceof UsageError) console.error(`sparrow ${e.cmd}: ${msg}\nusage: ${USAGE[e.cmd] ?? fullUsage()}`);
    else console.error(`sparrow ${cmd}: ${msg}`);
    if (!json) for (const n of ctx.notices) console.log(n);
    // Never lose messages that earlier requests of this command already marked delivered.
    if (json) console.log(JSON.stringify({ error: msg, inbox: ctx.inbox }, null, 2));
    else if (ctx.inbox.length) console.log(inboxBlock(ctx.inbox, ctx.me?.handle ?? null));
    return usage ? 2 : 1;
  }
}
