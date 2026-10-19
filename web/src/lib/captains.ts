// Pure logic for the Captains UI (docs/plans/multi-captain.md §7): hues, names, status grouping and filters,
// the fleet tree and strip, and the Activity feed (day groups, update policy, per-agent filter).
// Unit-tested in web/test/captains.test.ts; components only render what these return.
import type { Agent, AgentState, CaptainStatus, CaptainSummary, MessageView } from '@shared/types'

// ---------------------------------------------------------------- hue

/** 10 OKLCH hue angles spaced for distinctness; lightness/chroma come from CSS (--cap-l / --cap-c per theme). */
export const HUES = [25, 55, 85, 135, 165, 195, 230, 265, 300, 335] as const

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** Deterministic hue angle for a captain (or any agent) id. */
export const hueOf = (id: string): number => HUES[hash(id) % HUES.length]

// ---------------------------------------------------------------- names

type CapLike = Pick<Agent, 'handle' | 'captain'>

/** What the captain works on: its title, else its branch, else @handle. */
export function captainName(a: CapLike): string {
  return a.captain?.title?.trim() || a.captain?.branch || `@${a.handle}`
}

/** True when captainName() fell back (no title): the UI can show it muted / offer to name it. */
export const isUntitled = (a: CapLike) => !a.captain?.title?.trim()

/** Avatar letter: first letter of the handle after a `cap-` prefix (cap-orion → O, captain → C). */
export function captainInitial(handle: string): string {
  const h = handle.replace(/^cap-/, '')
  return (h[0] ?? '?').toUpperCase()
}

/** The muted second line in lists: `@cap-orion · feat/login-rate-limit` (branch omitted when it is the title fallback). */
export function captainSubline(a: CapLike): string {
  const parts = [`@${a.handle}`]
  if (a.captain?.branch && !isUntitled(a)) parts.push(a.captain.branch)
  return parts.join(' · ')
}

/** `/Users/x/Desktop/plutus-feat1` → `~/Desktop/plutus-feat1`. */
export const tildePath = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

/** `7f3a9c21-8d4e-…` → `7f3a9c21`; short ids stay. */
export const shortSession = (sid: string | null | undefined) => (!sid ? '' : sid.length > 12 ? `${sid.replace(/^ses_/, '').slice(0, 8)}…` : sid)

// ---------------------------------------------------------------- status

export const STATUS_META: Record<CaptainStatus, { label: string; group: string; order: number }> = {
  attention: { label: 'Needs you', group: 'Needs you', order: 0 },
  working: { label: 'Working', group: 'Working', order: 1 },
  idle: { label: 'Idle', group: 'Idle', order: 2 },
  archived: { label: 'Archived', group: 'Archived', order: 3 },
}

/** One-word reason for "Needs you": a question beats unread results beats a stuck agent. */
export function attentionReason(s: Pick<CaptainSummary, 'status' | 'questions' | 'unread' | 'fleet'>): string | null {
  if (s.status !== 'attention') return null
  if (s.questions > 0) return s.questions === 1 ? '1 question' : `${s.questions} questions`
  if (s.unread > 0) return s.unread === 1 ? '1 unread' : `${s.unread} unread`
  if (s.fleet.crashed > 0) return s.fleet.crashed === 1 ? '1 crashed' : `${s.fleet.crashed} crashed`
  return 'waiting on you'
}

/** Status line shown on rows/pills: "Working · 3", "Needs you · 1 question", "Idle", "Archived". */
export function statusLabel(s: Pick<CaptainSummary, 'status' | 'questions' | 'unread' | 'fleet'>): string {
  if (s.status === 'working') {
    const n = s.fleet.working + s.fleet.queued
    return n ? `Working · ${n}` : 'Working'
  }
  if (s.status === 'attention') return `Needs you · ${attentionReason(s)}`
  return STATUS_META[s.status].label
}

/** Sort inside a group: attention by (questions, unread) then recency; everything else by recency. */
export function compareCaptains(a: CaptainSummary, b: CaptainSummary): number {
  const o = STATUS_META[a.status].order - STATUS_META[b.status].order
  if (o) return o
  if (a.status === 'attention') {
    const q = (b.questions > 0 ? 1 : 0) - (a.questions > 0 ? 1 : 0)
    if (q) return q
  }
  return b.last_activity_at - a.last_activity_at || a.agent.handle.localeCompare(b.agent.handle)
}

export interface CaptainGroup { status: CaptainStatus; label: string; items: CaptainSummary[] }

/** Sidebar groups: Needs you · Working · Idle (non-empty only), plus Archived last (also when empty, for the "(n)" row). */
export function groupCaptains(list: CaptainSummary[]): CaptainGroup[] {
  const sorted = [...list].sort(compareCaptains)
  const order: CaptainStatus[] = ['attention', 'working', 'idle', 'archived']
  return order
    .map((status) => ({ status, label: STATUS_META[status].group, items: sorted.filter((s) => s.status === status) }))
    .filter((g) => g.items.length > 0 || g.status === 'archived')
}

export type CaptainFilter = 'all' | 'working' | 'attention' | 'idle' | 'archived'
export const CAPTAIN_FILTERS: { id: CaptainFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'working', label: 'Working' }, { id: 'attention', label: 'Needs you' },
  { id: 'idle', label: 'Idle' }, { id: 'archived', label: 'Archived' },
]

/** Free-text match over title, branch, handle, folder and session id. */
export function captainMatches(s: CaptainSummary, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const a = s.agent
  const hay = [a.captain?.title ?? '', a.captain?.branch ?? '', a.handle, `@${a.handle}`, a.cwd, tildePath(a.cwd), a.session_id ?? ''].join('\n').toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/** 'all' hides archived (they have their own filter). */
export function filterCaptains(list: CaptainSummary[], f: CaptainFilter, q = ''): CaptainSummary[] {
  return list
    .filter((s) => (f === 'all' ? s.status !== 'archived' : s.status === f))
    .filter((s) => captainMatches(s, q))
    .sort(compareCaptains)
}

export function filterCounts(list: CaptainSummary[]): Record<CaptainFilter, number> {
  const c: Record<CaptainFilter, number> = { all: 0, working: 0, attention: 0, idle: 0, archived: 0 }
  for (const s of list) { c[s.status]++; if (s.status !== 'archived') c.all++ }
  return c
}

/** Project home subtitle: `8 captains · 3 agents working · 2 need you` (archived not counted). */
export function projectLine(list: CaptainSummary[]): string {
  const live = list.filter((s) => s.status !== 'archived')
  const working = live.reduce((n, s) => n + s.fleet.working, 0)
  const need = live.filter((s) => s.status === 'attention').length
  const parts = [`${live.length} captain${live.length === 1 ? '' : 's'}`, `${working} agent${working === 1 ? '' : 's'} working`]
  if (need) parts.push(`${need} need${need === 1 ? 's' : ''} you`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------- fleet

/** Order hires show in: live work first, retired last. */
export const STATE_ORDER: Record<AgentState, number> = { working: 0, queued: 1, waiting: 2, crashed: 3, idle: 4, retired: 5 }

export interface StripSegment { id: string; state: AgentState }
/** Fleet strip: one segment per hire (captain excluded), working first; > max → the first `max` plus `more`. */
export function fleetStrip(agents: Agent[], captainId: string, max = 24): { segments: StripSegment[]; more: number } {
  const hires = agents
    .filter((a) => a.fleet_id === captainId && a.id !== captainId)
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.created_at - b.created_at)
  return { segments: hires.slice(0, max).map((a) => ({ id: a.id, state: a.state })), more: Math.max(0, hires.length - max) }
}

export interface FleetNode { agent: Agent; children: FleetNode[]; depth: number }

/** The fleet as a tree rooted at the captain (hires by parent_id, oldest first). Orphans hang off the root. */
export function fleetTree(agents: Agent[], captainId: string): FleetNode | null {
  const fleet = agents.filter((a) => a.fleet_id === captainId || a.id === captainId)
  const root = fleet.find((a) => a.id === captainId)
  if (!root) return null
  const ids = new Set(fleet.map((a) => a.id))
  const kids = new Map<string, Agent[]>()
  for (const a of fleet) {
    if (a.id === captainId) continue
    const p = a.parent_id && ids.has(a.parent_id) ? a.parent_id : captainId
    kids.set(p, [...(kids.get(p) ?? []), a])
  }
  const build = (a: Agent, depth: number, seen: Set<string>): FleetNode => {
    seen.add(a.id)
    const children = (kids.get(a.id) ?? []).filter((c) => !seen.has(c.id)).sort((x, y) => x.created_at - y.created_at)
    return { agent: a, depth, children: children.map((c) => build(c, depth + 1, seen)) }
  }
  return build(root, 0, new Set())
}

export interface FleetRow {
  agent: Agent
  depth: number
  /** For each ancestor level 1..depth-1: true when a vertical guide continues through this row. */
  guides: boolean[]
  /** Last child of its parent (└ instead of ├). */
  last: boolean
  childCount: number
}

/** Flatten a tree for rendering with connector lines (depth-first). The root comes first with depth 0. */
export function flattenFleet(root: FleetNode | null): FleetRow[] {
  if (!root) return []
  const rows: FleetRow[] = []
  const walk = (n: FleetNode, guides: boolean[], last: boolean) => {
    rows.push({ agent: n.agent, depth: n.depth, guides, last, childCount: n.children.length })
    n.children.forEach((c, i) => {
      const isLast = i === n.children.length - 1
      walk(c, n.depth === 0 ? [] : [...guides, !last], isLast)
    })
  }
  walk(root, [], true)
  return rows
}

/** Every agent id in the fleet (captain included). */
export const fleetIds = (agents: Agent[], captainId: string) =>
  new Set(agents.filter((a) => a.fleet_id === captainId || a.id === captainId).map((a) => a.id))

// ---------------------------------------------------------------- activity

export const threadIds = (thread: string) => (thread.startsWith('dm:') ? thread.slice(3).split(':') : [])

/** A message belongs to a fleet when its dm thread has a fleet member on either side (§5 `?fleet=`). */
export const inFleet = (m: Pick<MessageView, 'thread'>, ids: Set<string>) => threadIds(m.thread).some((id) => ids.has(id))

export type UpdatePolicy = 'recent' | 'all' | 'none'
export const RECENT_UPDATES = 20

export interface ActivityOpts {
  /** Only threads with this agent on one side (the filter chips); null = everyone. */
  agent?: string | null
  /** 'recent' (default) keeps the last 20 updates, 'all' keeps every update, 'none' hides them. */
  updates?: UpdatePolicy
}

/** Filtered, oldest → newest, deduped by seq. */
export function activityMessages(list: MessageView[], opts: ActivityOpts = {}): MessageView[] {
  const policy = opts.updates ?? 'recent'
  const seen = new Set<number>()
  let msgs = [...list].sort((a, b) => a.seq - b.seq).filter((m) => (seen.has(m.seq) ? false : (seen.add(m.seq), true)))
  if (opts.agent) msgs = msgs.filter((m) => threadIds(m.thread).includes(opts.agent!))
  if (policy === 'none') return msgs.filter((m) => m.kind !== 'update')
  if (policy === 'recent') {
    const updates = msgs.filter((m) => m.kind === 'update')
    const keep = new Set(updates.slice(-RECENT_UPDATES).map((m) => m.seq))
    return msgs.filter((m) => m.kind !== 'update' || keep.has(m.seq))
  }
  return msgs
}

/** How many updates the 'recent' policy hides (for the "Show N earlier updates" toggle). */
export function hiddenUpdates(list: MessageView[], agent?: string | null): number {
  const n = list.filter((m) => m.kind === 'update' && (!agent || threadIds(m.thread).includes(agent))).length
  return Math.max(0, n - RECENT_UPDATES)
}

const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime() }

/** Today / Yesterday / Monday (this week) / Oct 12 (this year) / Oct 12, 2025. */
export function dayLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(at)
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'long' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export interface DayGroup { key: number; label: string; items: MessageView[] }

/** Group (already ordered) messages by local day. */
export function groupByDay(list: MessageView[], now = Date.now()): DayGroup[] {
  const out: DayGroup[] = []
  for (const m of list) {
    const key = startOfDay(m.created_at)
    const g = out.at(-1)
    if (g && g.key === key) g.items.push(m)
    else out.push({ key, label: dayLabel(m.created_at, now), items: [m] })
  }
  return out
}

/** Fleet agents that appear in the activity, for the filter chips (captain excluded, oldest hire first). */
export function activityAgents(agents: Agent[], captainId: string): Agent[] {
  return agents.filter((a) => a.fleet_id === captainId && a.id !== captainId).sort((a, b) => a.created_at - b.created_at)
}

/** Result status from a message's meta (defaults to ok). */
export function resultStatus(m: Pick<MessageView, 'meta'>): 'ok' | 'blocked' | 'failed' {
  const s = m.meta?.status
  return s === 'blocked' || s === 'failed' ? s : 'ok'
}

/** The last non-update message as a one-liner for rows: glyph, sender, first meaningful line. */
export function lastMessageLine(m: MessageView | null): { glyph: string; tone: 'ok' | 'blocked' | 'failed' | 'question' | 'muted'; from: string; text: string } | null {
  if (!m) return null
  const line = m.text.split('\n').map((l) => l.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim()).find((l) => l && !/^(result|evidence|files|next)$/i.test(l)) ?? ''
  const from = m.from_handle === 'system' ? 'system' : `@${m.from_handle}`
  if (m.kind === 'result') {
    const s = resultStatus(m)
    return { glyph: s === 'ok' ? '✓' : s === 'blocked' ? '!' : '✕', tone: s, from, text: line }
  }
  if (m.kind === 'question') return { glyph: '?', tone: 'question', from, text: line }
  if (m.kind === 'task') return { glyph: '→', tone: 'muted', from, text: line }
  return { glyph: '·', tone: 'muted', from, text: line }
}
