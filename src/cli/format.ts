// Plain-text renderers for the sparrow CLI. Models read this output, so keep it compact and stable.
import { renderResumeText } from '../server/resumes';
import type { Agent, Card, CardState, MessageView, Resume, ResumeView, TeamStatus } from '../shared/types';
import { TMUX_SOCKET } from '../shared/config';

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
    const bits = [`@${handle}`, resume, `done ${String((result.meta as any)?.status ?? 'ok')}`, typeof ms === 'number' ? `call ${duration(ms)}` : null];
    return `── ${bits.filter(Boolean).join(' · ')} ──`;
  }
  if (group.every((m) => m.kind === 'chat' || m.kind === 'task' || m.kind === 'question')) return `── @${handle} (DM) ──`;
  return `── @${handle}${resume ? ` · ${resume}` : ''} ──`;
}

/** New messages grouped by the agent they are about (sender, or meta.about for notices), seq order inside each group. */
export function inboxBlock(inbox: MessageView[], handle: string | null, agents: Agent[] = []): string {
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
  const lines = [`━━ 📨 ${n} new message${n === 1 ? '' : 's'}${who} ━━`];
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
      lines.push(`  status: ${status}${unusable ? ' — UNUSABLE: do not hire' : ''}${view.status_detail ? ` · ${view.status_detail}` : ''}`);
      lines.push(`  can hire: ${r.can_hire.length ? r.can_hire.join(', ') : 'nobody'}`);
      return lines.join('\n');
    })
    .join('\n');
}

// ---------- cards

export const STATE_TITLES: Record<CardState, string> = {
  proposed: 'Proposed', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done', dropped: 'Dropped',
};

export function cardLine(c: Card, handles: Map<string, string>): string {
  const bits = [`#${c.id} ${c.title}`];
  if (c.category) bits.push(`[${c.category}]`);
  if (c.assignee_id) bits.push('@' + (handles.get(c.assignee_id) ?? c.assignee_id));
  if (c.notes?.length) bits.push(`· ${c.notes.length} note${c.notes.length === 1 ? '' : 's'}`);
  return bits.join(' ');
}

export function cardBoard(cards: Card[], handles: Map<string, string>): string {
  if (!cards.length) return 'No cards.';
  const out: string[] = [];
  for (const state of Object.keys(STATE_TITLES) as CardState[]) {
    const col = cards.filter((c) => c.state === state).sort((a, b) => a.position - b.position || a.id - b.id);
    if (!col.length) continue;
    out.push(`${STATE_TITLES[state]} (${col.length})`);
    for (const c of col) out.push('  ' + cardLine(c, handles));
  }
  return out.join('\n');
}

export function cardDetail(c: Card, handles: Map<string, string>): string {
  const lines = [`#${c.id} ${c.title} — ${STATE_TITLES[c.state] ?? c.state}${c.assignee_id ? ` · @${handles.get(c.assignee_id) ?? c.assignee_id}` : ''}`];
  if (c.details) lines.push(`  ${oneLine(c.details, 200)}`);
  const last = c.notes?.[c.notes.length - 1];
  if (last) lines.push(`  last note: ${oneLine(last.text, 120)}`);
  return lines.join('\n');
}
