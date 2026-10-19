// Pure logic for the captain page (docs/plans/multi-captain.md §7.3): stats, meta line, resume lines per harness,
// which questions are still waiting, the cards of a fleet, an agent's thread, open-call timing, and the update-run spacing.
// Unit-tested in web/test/captainPage.test.ts; components only render what these return.
import type { Agent, CaptainInfo, CaptainSummary, Call, CallEndReason, Card, CardState, MessageView } from '@shared/types'
import { agoLabel, tmuxAttach } from './format'
import { threadIds } from './captains'

// ---------------------------------------------------------------- stats

export interface StatItem {
  key: 'agents' | 'working' | 'done' | 'blocked' | 'failed' | 'unread'
  label: string
  value: number
  /** warn = amber number, bad = red number (only when > 0), default = foreground. */
  tone: 'default' | 'warn' | 'bad'
  note?: string
}

/** Agents · Working · Done · (Blocked) · Failed · Unread. Blocked only appears when there is one. */
export function captainStats(s: Pick<CaptainSummary, 'fleet' | 'results' | 'unread'>): StatItem[] {
  const out: StatItem[] = [
    { key: 'agents', label: 'Agents', value: s.fleet.total, tone: 'default' },
    { key: 'working', label: 'Working', value: s.fleet.working + s.fleet.queued, tone: 'default' },
    { key: 'done', label: 'Done', value: s.results.ok, tone: 'default' },
  ]
  if (s.results.blocked > 0) out.push({ key: 'blocked', label: 'Blocked', value: s.results.blocked, tone: 'warn' })
  out.push({ key: 'failed', label: 'Failed', value: s.results.failed, tone: s.results.failed > 0 ? 'bad' : 'default' })
  out.push({
    key: 'unread', label: 'Unread', value: s.unread, tone: s.unread > 0 ? 'warn' : 'default',
    ...(s.unread > 0 ? { note: "the captain hasn't read these yet" } : {}),
  })
  return out
}

// ---------------------------------------------------------------- meta line

/** `online` while seen in the last 15 min (server-side flag), else `seen 2m ago`. */
export function seenLabel(s: Pick<CaptainSummary, 'online' | 'agent'>, now = Date.now()): { online: boolean; text: string } {
  if (s.online) return { online: true, text: 'online' }
  const at = s.agent.last_seen_at
  return { online: false, text: at ? `seen ${agoLabel(at, now)}` : 'never seen' }
}

export const originLabel = (o: CaptainInfo['origin'] | undefined) => (o === 'sparrow' ? 'launched by Sparrow' : 'started in a terminal')

export const HARNESS_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', fake: 'fake', unknown: 'unknown harness' }

// ---------------------------------------------------------------- resume lines

/** Single-quote a path for a shell line (always quoted, like the server's resume command). */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The exact line to reopen an agent's own session by hand; null without a session id or for the fake harness. */
export function agentResumeCommand(a: Pick<Agent, 'harness' | 'cwd' | 'session_id'>): string | null {
  if (!a.session_id) return null
  const cd = `cd ${shellQuote(a.cwd)} && `
  switch (a.harness) {
    case 'claude': return `${cd}claude --resume ${a.session_id}`
    case 'codex': return `${cd}codex resume ${a.session_id}`
    case 'opencode': return `${cd}opencode -s ${a.session_id}`
    default: return null
  }
}

/** The tmux attach line while an agent has a window open, else null. */
export const agentAttach = (a: Pick<Agent, 'tmux_session' | 'tmux_window' | 'tmux_window_id'>): string | null =>
  a.tmux_window_id ? tmuxAttach(a) : null

// ---------------------------------------------------------------- activity

/** Seqs of `question` messages that are still the newest message of their thread: nobody answered yet. */
export function waitingQuestions(list: MessageView[]): Set<number> {
  const newest = new Map<string, number>()
  for (const m of list) if (m.seq > (newest.get(m.thread) ?? -1)) newest.set(m.thread, m.seq)
  return new Set(list.filter((m) => m.kind === 'question' && newest.get(m.thread) === m.seq).map((m) => m.seq))
}

/** `@james → @maya`: sender and the people it was addressed to (never the sender itself). */
export function routeLabel(m: Pick<MessageView, 'from_handle' | 'to_handles' | 'kind'>): { from: string; to: string[] } {
  const from = m.from_handle === 'system' ? 'system' : `@${m.from_handle}`
  return { from, to: m.to_handles.filter((h) => h !== m.from_handle).map((h) => `@${h}`) }
}

/** An update directly after another update: rendered closer together so runs read as one muted block. */
export function tightWithPrev(list: MessageView[], i: number): boolean {
  return i > 0 && list[i].kind === 'update' && list[i - 1].kind === 'update'
}

/** An agent's own conversation: every thread it is a member of; with a parent, only the thread with that parent. */
export function agentThread(list: MessageView[], agent: Pick<Agent, 'id' | 'parent_id'>): MessageView[] {
  return [...list]
    .filter((m) => {
      const ids = threadIds(m.thread)
      return ids.includes(agent.id) && (!agent.parent_id || ids.includes(agent.parent_id))
    })
    .sort((a, b) => a.seq - b.seq)
}

// ---------------------------------------------------------------- team / calls

/** Start of the open call (newest call without an end), else null. */
export function openCallStart(calls: Pick<Call, 'started_at' | 'ended_at'>[]): number | null {
  let best: number | null = null
  for (const c of calls) if (c.ended_at == null && (best == null || c.started_at > best)) best = c.started_at
  return best
}

export const END_REASON_LABEL: Record<CallEndReason, string> = {
  done: 'Reported done', ask: 'Asked a question', wait: 'Waiting for a message', unreported: 'Ended without reporting',
  provider_error: 'Provider error', crashed: 'Crashed', released: 'Released', server_restart: 'Server restarted',
}

/** Tone of a call's end reason (colour is information only). */
export const endReasonTone = (r: CallEndReason | null): 'ok' | 'warn' | 'bad' | 'muted' =>
  r === 'done' ? 'ok' : r === 'crashed' || r === 'provider_error' ? 'bad' : r === 'unreported' || r === 'ask' ? 'warn' : 'muted'

// ---------------------------------------------------------------- cards

const CARD_ORDER: Record<CardState, number> = { in_progress: 0, review: 1, todo: 2, proposed: 3, done: 4, dropped: 5 }
export const CARD_STATE_TONE: Record<CardState, 'working' | 'attention' | 'idle' | 'done'> = {
  in_progress: 'working', review: 'attention', todo: 'idle', proposed: 'idle', done: 'done', dropped: 'idle',
}

/** Cards assigned to, or proposed by, a fleet member: live work first, then newest. */
export function fleetCards(cards: Card[], ids: Set<string>): Card[] {
  return cards
    .filter((c) => (c.assignee_id != null && ids.has(c.assignee_id)) || ids.has(c.created_by))
    .sort((a, b) => CARD_ORDER[a.state] - CARD_ORDER[b.state] || b.updated_at - a.updated_at || b.id - a.id)
}

// ---------------------------------------------------------------- misc

/** Team rows / sheet: the model line `claude · opus · high` (omits empties). */
export function modelLine(a: Pick<Agent, 'harness' | 'model' | 'effort'>): string {
  return [a.harness, a.model, a.effort].filter(Boolean).join(' · ')
}

/** First line of a progress update, trimmed for one-line rows. */
export const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** Sender for the avatar column of a message: the captain's own row, an agent, or the system. */
export function senderKind(m: Pick<MessageView, 'from_id' | 'from_handle'>, captainId: string): 'captain' | 'system' | 'agent' {
  return m.from_handle === 'system' || m.from_id === 'system' ? 'system' : m.from_id === captainId ? 'captain' : 'agent'
}

/** `14:05` in the viewer's time zone (messages sit under a day label, so no date here). */
export const timeOfDay = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** The part of a resume line that identifies the session: `cd '/x' && claude --resume abc` → `claude --resume abc`. */
export const resumeTail = (command: string): string => command.replace(/^cd\s+(?:'(?:[^']|'\\'')*'|\S+)\s*&&\s*/, '')
