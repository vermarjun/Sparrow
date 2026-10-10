// Plain-text renderers for the sparrow CLI. Models read this output, so keep it compact and stable.
import type { Agent, Card, CardState, MessageView, Resume } from '../shared/types';
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

/** One message as `[DM from @a · 14:02 · task · card #3] text`. */
export function messageLine(m: MessageView): string {
  const where = m.thread === 'group' ? 'group' : 'DM';
  const parts: string[] = [];
  if (m.from_id === 'system' || m.kind === 'system') parts.push('system');
  else parts.push(`${where} from @${m.from_handle}`);
  parts.push(hhmm(m.created_at));
  const tag = kindTag(m);
  if (tag) parts.push(tag);
  if (m.card_id != null) parts.push(`card #${m.card_id}`);
  return `[${parts.join(' · ')}] ${m.text.trim()}`;
}

export function inboxBlock(inbox: MessageView[], handle: string | null): string {
  if (!inbox.length) return '';
  const n = inbox.length;
  const who = handle ? ` for @${handle}` : '';
  const sorted = [...inbox].sort((a, b) => a.seq - b.seq);
  return [
    `━━ 📨 ${n} new message${n === 1 ? '' : 's'}${who} ━━`,
    ...sorted.map(messageLine),
    '━━ Act on these before you finish. ━━',
  ].join('\n');
}

/** Log view: `#seq 14:02 group @a → @b [kind]: text` — one message per entry, full text. */
export function logLines(msgs: MessageView[]): string {
  if (!msgs.length) return 'No messages.';
  return msgs
    .map((m) => {
      const from = m.from_id === 'system' ? 'system' : `@${m.from_handle}`;
      const to = m.thread === 'group'
        ? `group${m.to_handles.length ? ` (→ ${m.to_handles.map((h) => '@' + h).join(' ')})` : ''}`
        : m.to_handles.map((h) => '@' + h).join(' ') || m.thread_label;
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

export function resumesDirectory(resumes: Resume[]): string {
  if (!resumes.length) return 'No resumes. Run: sparrow install';
  const sorted = [...resumes].sort((a, b) => a.slug.localeCompare(b.slug));
  return sorted
    .map((r) => {
      const h = [r.harness, [r.model, r.effort].filter(Boolean).join('/')].filter(Boolean).join(' · ');
      const lines = [`${r.slug} — ${r.title} [${h}]`, `  ${oneLine(r.description, 160)}`];
      if (r.can_hire.length) lines.push(`  can hire: ${r.can_hire.join(', ')}`);
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
