// Plain-text renderers for the sparrow CLI. Models read this output, so keep it compact and stable.
import { renderResumeText } from '../server/resumes';
import type {
  Agent, Card, CardState, CaptainDetail, CaptainStartRes, CaptainSummary, MessageView, Project, Resume, ResumeView, TeamStatus,
} from '../shared/types';
import { TMUX_SOCKET } from '../shared/config';
import { cardBrief, cardKey, cardTimings, formatEstimate, formatSpan, isQuickWin } from '../shared/cards';

export function age(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '-';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function hhmmss(at: number): string {
  return `${hhmm(at)}:${String(new Date(at).getSeconds()).padStart(2, '0')}`;
}

/** Call length: 42s, 5m02s, 1h05m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** Coarse span for the team digest: 45s, 12m, 1h05m. */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function oneLine(text: string | null | undefined, max = 70): string {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function harnessLabel(a: { harness: string; model: string | null; effort: string | null }): string {
  const extra = [a.model, a.effort].filter(Boolean).join('/');
  return extra ? `${a.harness}·${extra}` : a.harness;
}

export function tmuxAttach(a: Pick<Agent, 'tmux_session' | 'tmux_window'>): string {
  const sock = TMUX_SOCKET ? `-L ${TMUX_SOCKET} ` : '';
  return `tmux ${sock}attach -t ${a.tmux_session} \\; select-window -t ${a.tmux_window}`;
}

/** Left-aligned table; the last column is not padded. */
export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n');
}

// ---------- messages

function kindTag(m: MessageView): string | null {
  switch (m.kind) {
    case 'task': return 'task';
    case 'question': return 'question';
    case 'result': return `result: ${String((m.meta as any)?.status ?? 'ok')}`;
    case 'update': return 'update';
    case 'system': return null;
    default: return null;
  }
}

const INDENT = '    ';
const indent = (text: string) => text.split('\n').map((l) => (l ? INDENT + l : ''));

/** Handles in a DM thread label ('dm @a ↔ @b') other than `me`. */
function peers(m: MessageView, me: string | null): string[] {
  return [...m.thread_label.matchAll(/@([a-z0-9-]+)/g)].map((x) => x[1]).filter((h) => h !== me);
}

/** The agent a message is about: its sender, or `meta.about` for system notices. */
function aboutOf(m: MessageView): string {
  return m.from_id === 'system' && typeof m.meta?.about === 'string' ? (m.meta.about as string) : m.from_id;
}

/** One message under its group header: `  14:02:10  update  text`; results and multi-line texts print as an indented block. */
function inboxEntry(m: MessageView): string[] {
  const card = m.card_id != null ? ` · card #${m.card_id}` : '';
  const text = m.text.trim();
  const tag = m.kind === 'result' ? `result (${String((m.meta as any)?.status ?? 'ok')})` : m.kind === 'chat' ? 'DM' : m.kind;
  const head = `  ${hhmmss(m.created_at)}  ${tag}${card}`;
  if (m.kind !== 'result' && !text.includes('\n')) return [`${head}  ${text}`];
  return [head, ...indent(text)];
}

/**
 * Group header. With a result: `── @james · builder · done ok · call 5m02s ──`. A pure conversation (DMs, tasks,
 * questions): `── @maya (DM) ──`. Otherwise (updates, notices): `── @james · builder ──`.
 */
function groupHeader(group: MessageView[], me: string | null, agents: Map<string, Agent>): string {
  const first = group[0];
  const a = agents.get(aboutOf(first));
  const handle = a?.handle ?? (first.from_id !== 'system' ? first.from_handle : peers(first, me)[0] ?? 'system');
  const resume = a && a.kind !== 'human' ? a.resume : null;
  const result = [...group].reverse().find((m) => m.kind === 'result');
  if (result) {
    const ms = (result.meta as any)?.call_ms;
    const bits = [`@${handle}`, resume, `done ${String((result.meta as any)?.status ?? 'ok')}`, typeof ms === 'number' ? `call ${duration(ms)}` : null,
      (result.meta as any)?.released ? 'released (one-shot)' : null];
    return `── ${bits.filter(Boolean).join(' · ')} ──`;
  }
  if (group.every((m) => m.kind === 'chat' || m.kind === 'task' || m.kind === 'question')) return `── @${handle} (DM) ──`;
  return `── @${handle}${resume ? ` · ${resume}` : ''} ──`;
}

/** Inbox messages grouped by the agent they are about (sender, or meta.about for notices), seq order inside each group. */
export function inboxBlock(inbox: MessageView[], handle: string | null, agents: Agent[] = [], opts: { alreadyDelivered?: boolean } = {}): string {
  if (!inbox.length) return '';
  const n = inbox.length;
  const who = handle ? ` for @${handle}` : '';
  const byId = new Map(agents.map((a) => [a.id, a]));
  const groups = new Map<string, MessageView[]>();
  for (const m of [...inbox].sort((a, b) => a.seq - b.seq)) {
    const k = aboutOf(m);
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }
  const description = opts.alreadyDelivered ? 'already delivered' : 'new';
  const lines = [`━━ 📨 ${n} ${description} message${n === 1 ? '' : 's'}${who} ━━`];
  for (const g of groups.values()) lines.push(groupHeader(g, handle, byId), ...g.flatMap(inboxEntry));
  lines.push('━━ Act on these before you finish. ━━');
  return lines.join('\n');
}

/** After `sparrow inbox`: each busy child with its latest update. Empty string when nobody is busy. */
export function teamDigest(team: TeamStatus[], now = Date.now()): string {
  if (!team.length) return '';
  const lines = team.map((t) => {
    const state = t.state === 'working' && t.call_started_at != null ? `working ${span(now - t.call_started_at)}` : t.state;
    // A working child's update from an earlier call says nothing about this one.
    const stale = t.state === 'working' && t.call_started_at != null && (t.last_update_at ?? 0) < t.call_started_at;
    const upd = t.last_update && !stale ? `last update ${age(t.last_update_at, now)}: ${oneLine(t.last_update, 100)}` : 'no update yet';
    return `  @${t.handle} · ${t.resume} · ${state} · ${upd}`;
  });
  return ['Still working:', ...lines].join('\n');
}

/** Log view: `14:02 @a → @b [kind]: text` — one message per entry, full text. */
export function logLines(msgs: MessageView[]): string {
  if (!msgs.length) return 'No messages.';
  return msgs
    .map((m) => {
      const from = m.from_id === 'system' ? 'system' : `@${m.from_handle}`;
      // Updates and notices have no woken recipient: show the other side of the DM thread.
      const to = (m.to_handles.length ? m.to_handles : peers(m, m.from_handle)).map((h) => '@' + h).join(' ') || m.thread_label;
      const tag = kindTag(m) ?? (m.kind === 'system' ? 'system' : '');
      const card = m.card_id != null ? ` card #${m.card_id}` : '';
      return `${hhmm(m.created_at)} ${from} → ${to}${tag ? ` [${tag}]` : ''}${card}: ${m.text.trim()}`;
    })
    .join('\n');
}

// ---------- agents

export function rosterTable(agents: Agent[], byId: Map<string, Agent>, now = Date.now()): string {
  if (!agents.length) return 'No agents.';
  const rows = [['HANDLE', 'RESUME', 'HARNESS', 'STATE', 'PARENT', 'LAST UPDATE']];
  for (const a of agents) {
    const parent = a.parent_id ? byId.get(a.parent_id) : null;
    const upd = a.last_update ? `${oneLine(a.last_update, 60)} (${age(a.last_update_at, now)})` : '-';
    rows.push([
      '@' + a.handle,
      a.resume,
      a.kind === 'human' ? 'human' : harnessLabel(a),
      a.kind === 'human' ? '-' : a.state,
      parent ? '@' + parent.handle : '-',
      upd,
    ]);
  }
  return table(rows);
}

export function agentSummary(a: Agent): string {
  return [
    `@${a.handle} — ${a.title} (${a.resume}) · ${a.kind === 'human' ? 'human captain' : harnessLabel(a)} · ${a.state}`,
    `  id ${a.id} · depth ${a.depth} · cwd ${a.cwd}`,
    a.kind === 'human' ? null : `  tmux ${a.tmux_session}:${a.tmux_window} · watch: ${tmuxAttach(a)}`,
  ].filter(Boolean).join('\n');
}

// ---------- captains

/** One-time line when a session becomes a new captain. */
export function captainHint(a: Agent, project: Pick<Project, 'id'>): string {
  return `You are @${a.handle}, a new captain in ${project.id}. Name your work: sparrow title "…"`;
}

/** What a captain row is called when it has no title yet. */
const captainTitle = (a: Agent) => a.captain?.title ?? (a.captain?.branch ? `(${a.captain.branch})` : '(untitled)');

function resumeLines(c: CaptainSummary['resume']): string[] {
  return [
    `resume: ${c.command ?? '(no session id yet)'}`,
    ...(c.attach ? [`attach: ${c.attach}`] : []),
  ];
}

/**
 * `sparrow captains`: one row per captain (handle, title, status, team working/total, last activity), the resume line(s)
 * indented under it. `meId` marks the caller "(you)"; null in a bare shell.
 */
export function captainsTable(list: CaptainSummary[], project: string, meId: string | null, all = false, now = Date.now(), hidden: { archived: number; empty: number } = { archived: 0, empty: 0 }): string {
  const parts = [hidden.archived ? `${hidden.archived} archived` : '', hidden.empty ? `${hidden.empty} empty` : ''].filter(Boolean);
  const note = all ? ' (incl. archived and empty)' : parts.length ? ` (${hidden.archived + hidden.empty} hidden: ${parts.join(', ')}; --all)` : '';
  const head = `Captains in ${project} — ${list.length}${note}`;
  if (!list.length) return `${head}\nNo captains yet. Start one: sparrow captain --title "…"`;
  const rows = list.map((s) => {
    const a = s.agent;
    const f = s.fleet;
    const team = f.total ? `${f.working}/${f.total} working${f.queued ? ` +${f.queued} queued` : ''}` : 'no team';
    const attn = s.status === 'attention' ? ` (${[s.questions ? `${s.questions} question${s.questions === 1 ? '' : 's'}` : '', s.unread ? `${s.unread} unread` : '', f.crashed ? `${f.crashed} crashed` : ''].filter(Boolean).join(', ') || 'needs you'})` : '';
    return ['@' + a.handle + (a.id === meId ? ' (you)' : ''), oneLine(captainTitle(a), 50), s.status + attn, team, age(s.last_activity_at, now)];
  });
  const lines = table(rows).split('\n');
  const out = [head];
  list.forEach((s, i) => out.push(lines[i], ...resumeLines(s.resume).map((l) => '    ' + l)));
  return out.join('\n');
}

/** `sparrow captain` / `captain resume`: handle, where it runs, how to watch and how to get back in. */
export function captainStartText(res: CaptainStartRes, detail: CaptainDetail | null, verb: 'Captain' | 'Resumed'): string {
  const a = detail?.summary.agent;
  const who = a ? `@${a.handle}${a.captain?.title ? ` — ${a.captain.title}` : ''} · ` : '';
  const lines = [`${verb} ${who}${res.cwd} · ${res.session}:${res.window}`, `  attach: ${res.attach}`];
  const command = detail?.summary.resume.command;
  if (command) lines.push(`  resume: ${command}`);
  if (a) lines.push(`  next: ${a.captain?.title ? 'it is already named' : `in its session run sparrow title "…"`}; \`sparrow captains\` lists all captains`);
  return lines.join('\n');
}

/** whoami lines for a captain (title, fleet, resume) or an agent (whose team it is on). `detail` is the captain's detail; null when unavailable. */
export function captainSelf(me: Agent, detail: CaptainDetail | null): string[] {
  if (!detail) return [];
  const s = detail.summary;
  const root = s.agent;
  if (me.kind !== 'human') return [`  fleet: @${root.handle}'s team${root.captain?.title ? ` — ${root.captain.title}` : ''}`];
  const c = root.captain;
  const f = s.fleet;
  return [
    `  captain: @${root.handle}${c?.title ? ` — ${c.title}` : ' — no title yet (sparrow title "…")'}${c?.branch ? ` · branch ${c.branch}` : ''}${c ? ` · ${c.origin}` : ''}`,
    `  fleet: ${root.id} · ${f.total} agent${f.total === 1 ? '' : 's'}${f.total ? ` (${f.working} working)` : ''}`,
    ...resumeLines(s.resume).map((l) => '  ' + l),
  ];
}

// ---------- resumes

export function resumesDirectory(resumes: (Resume | ResumeView)[]): string {
  if (!resumes.length) return 'No resumes. Run: sparrow install';
  const sorted = [...resumes].sort((a, b) => a.slug.localeCompare(b.slug));
  return sorted
    .map((r) => {
      const view = r as Partial<ResumeView>;
      const model = r.model ? `${r.model}${view.resolved_model && view.resolved_model !== r.model ? ` → ${view.resolved_model}` : ''}` : 'default';
      const h = `${r.harness} · ${model} · effort ${r.effort ?? 'default'}`;
      const status = view.status ?? 'unchecked';
      const unusable = !['ok', 'unchecked'].includes(status);
      const lines = [`${r.slug} — ${r.title} [${h}]`, `  ${oneLine(renderResumeText(r.description, r), 160)}`];
      const ph = view.provider_health;
      const degraded = ph?.degraded
        ? ` · DEGRADED: ${ph.errors} provider errors in a row on ${ph.provider}${ph.last_error ? ` (last: ${oneLine(ph.last_error, 80)}${ph.last_error_at ? `, ${age(ph.last_error_at)}` : ''})` : ''}; prefer another resume until one call succeeds`
        : '';
      lines.push(`  status: ${status}${unusable ? ' — UNUSABLE: do not hire' : ''}${view.status_detail ? ` · ${view.status_detail}` : ''}${degraded}`);
      lines.push(`  can hire: ${r.can_hire.length && !r.helper ? r.can_hire.join(', ') : 'nobody'}`);
      if (r.helper || r.one_shot) {
        lines.push(`  ${[r.helper ? 'helper (a leaf; hiring it does not make you a captain)' : null, r.one_shot ? 'one-shot (released right after its report; follow-ups need a new hire)' : null].filter(Boolean).join(' · ')}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

// ---------- cards

export const STATE_TITLES: Record<CardState, string> = {
  proposed: 'Proposed', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done', dropped: 'Dropped',
};

export function cardLine(c: Card, handles: Map<string, string>, now = Date.now()): string {
  const markers = [c.urgent ? '‼' : '', c.blocked_on ? `⛔ blocked on ${oneLine(c.blocked_on, 32)}` : '', isQuickWin(c) ? '★' : ''].filter(Boolean);
  const bits = [cardKey(c), ...markers, c.title];
  if (c.category) bits.push(`· ${c.category}`);
  if (c.impact || c.effort) bits.push(`· R ${c.impact ?? '—'}/E ${c.effort ?? '—'}`);
  if (c.estimate_min) bits.push(`· ~${formatEstimate(c.estimate_min)}`);
  bits.push(`· ${shortAge(c.created_at, now)}`);
  if (c.assignee_id) bits.push(`· @${handles.get(c.assignee_id) ?? c.assignee_id}`);
  return bits.join(' ');
}

function shortAge(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function cardBoard(cards: Card[], handles: Map<string, string>, now = Date.now()): string {
  if (!cards.length) return 'No cards.';
  const out: string[] = [];
  for (const state of Object.keys(STATE_TITLES) as CardState[]) {
    const col = cards.filter((c) => c.state === state);
    if (!col.length) continue;
    out.push(`${STATE_TITLES[state]} (${col.length})`);
    const active = col.filter((c) => !c.later_at);
    const later = col.filter((c) => !!c.later_at);
    for (const c of active) out.push('  ' + cardLine(c, handles, now));
    if (later.length) {
      out.push(`  · later · ${later.length}`);
      for (const c of later) out.push('    ' + cardLine(c, handles, now));
    }
  }
  return out.join('\n');
}

const timestamp = (at: number | null) => at == null ? '—' : new Date(at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const displayWho = (id: string, handles: Map<string, string>) => {
  if (id === 'user') return 'you';
  return `@${handles.get(id) ?? id.replace(/^@/, '')}`;
};

export function cardDetail(c: Card, handles: Map<string, string>, now = Date.now()): string {
  const timing = cardTimings(c, now);
  const build = timing.build_ms === 0 ? 'not started' : formatSpan(timing.build_ms);
  const lines = [cardBrief(c, (id) => displayWho(id, handles)), '', `Timing: proposed ${timestamp(c.created_at)} · started ${timestamp(timing.started_at)} · in review ${timestamp(timing.review_at)} · build ${build} · review ${formatSpan(timing.review_ms)}`];
  const estimate = c.estimate_min == null ? 'no estimate' : `est ${formatEstimate(c.estimate_min)}`;
  const ratio = timing.ratio == null ? '' : ` (${timing.ratio < 0.1 ? '<0.1' : timing.ratio.toFixed(1)}×)`;
  lines[2] += ` · ${estimate} → ${timing.build_ms === 0 ? 'not started' : `${formatSpan(timing.build_ms)} build${ratio}`}`;
  const events = (c.notes ?? []).filter((n) => n.kind === 'event').slice(-8);
  if (events.length) {
    lines.push('', '## Recent events');
    for (const n of events) lines.push(`- ${displayWho(n.by, handles)} · ${timestamp(n.at)}: ${n.text}`);
  }
  return lines.join('\n');
}

export function cardBriefText(c: Card, handles: Map<string, string>): string {
  return cardBrief(c, (id) => displayWho(id, handles));
}
