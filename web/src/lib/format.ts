// Pure helpers (unit-tested in web/test).
import type { Agent, Card, CardState } from '@shared/types'

export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '—'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return `${d}d`
}

export function clock(at: number | null | undefined, now = Date.now()): string {
  if (!at) return ''
  const d = new Date(at)
  const today = new Date(now)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === today.toDateString()) return hm
  const yest = new Date(now - 86400000)
  if (d.toDateString() === yest.toDateString()) return `yesterday ${hm}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Position for a card dropped between `prev` and `next` (either may be missing). */
export function midpoint(prev: number | undefined, next: number | undefined): number {
  if (prev !== undefined && next !== undefined) return (prev + next) / 2
  if (prev !== undefined) return prev + 1
  if (next !== undefined) return next - 1
  return 1
}

/**
 * Given the final ordering of card ids in the target column (including the moved card),
 * return the PATCH body for the move, or null when nothing changed.
 */
export function moveFor(
  card: Pick<Card, 'id' | 'state' | 'position'>,
  toState: CardState,
  columnIds: number[],
  positions: Map<number, number>,
  originalOrder: number[],
): { state?: CardState; position: number } | null {
  const idx = columnIds.indexOf(card.id)
  if (idx === -1) return null
  const sameState = toState === card.state
  if (sameState && originalOrder.join(',') === columnIds.join(',')) return null
  const prev = idx > 0 ? positions.get(columnIds[idx - 1]) : undefined
  const next = idx < columnIds.length - 1 ? positions.get(columnIds[idx + 1]) : undefined
  const position = midpoint(prev, next)
  return sameState ? { position } : { state: toState, position }
}

export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.position - b.position || a.id - b.id)
}

export interface TreeNode { agent: Agent; children: TreeNode[]; depth: number }

/** Parent → children forest. Roots: no parent, or parent not in the list. Human captains first. */
export function buildTree(agents: Agent[]): TreeNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const kids = new Map<string, Agent[]>()
  const roots: Agent[] = []
  for (const a of agents) {
    if (a.parent_id && byId.has(a.parent_id) && a.parent_id !== a.id) {
      const list = kids.get(a.parent_id) ?? []
      list.push(a)
      kids.set(a.parent_id, list)
    } else roots.push(a)
  }
  const order = (x: Agent, y: Agent) =>
    (x.kind === 'human' ? 0 : 1) - (y.kind === 'human' ? 0 : 1) || x.created_at - y.created_at
  const seen = new Set<string>()
  const make = (a: Agent, depth: number): TreeNode => {
    seen.add(a.id)
    const children = (kids.get(a.id) ?? []).filter((c) => !seen.has(c.id)).sort(order).map((c) => make(c, depth + 1))
    return { agent: a, children, depth }
  }
  return roots.sort(order).map((a) => make(a, 0))
}

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (n: TreeNode) => { out.push(n); n.children.forEach(walk) }
  nodes.forEach(walk)
  return out
}

export type Segment = { text: string; mention?: boolean }

/** Split text into plain / @mention segments. When `handles` is given, only those are highlighted. */
export function splitMentions(text: string, handles?: Set<string>): Segment[] {
  const out: Segment[] = []
  const re = /(^|[^\w@])@([a-z][a-z0-9-]{0,23})\b/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    const h = m[2].toLowerCase()
    if (handles && !handles.has(h) && h !== 'all') continue
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: `@${m[2]}`, mention: true })
    last = start + 1 + m[2].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** "dm @a ↔ @b" → "@a ↔ @b"; "group" → "Group". */
export function threadTitle(label: string, thread: string): string {
  if (thread === 'group') return 'Group'
  return label.replace(/^dm\s+/, '')
}

export function quietMinutes(a: Agent, now = Date.now()): number {
  const ref = a.last_seen_at ?? a.updated_at
  return Math.floor((now - ref) / 60000)
}

export function tmuxAttach(a: Pick<Agent, 'tmux_session' | 'tmux_window'>): string {
  return `tmux attach -t ${a.tmux_session} \\; select-window -t ${a.tmux_window}`
}

// Thread preview: first meaningful line, markdown markers stripped.
export const previewLine = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?|\|.*\|\s*$)/gm, '')
    .replace(/[`*]|~~/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)

/**
 * A system notice whose `meta.screen` is set embeds the screen in its text
 * ("…\nLast screen:\n<screen>\nSend @x a message…"). Return the notice without the
 * screen (the trailing line is kept); the UI shows the screen once, collapsed.
 */
export function systemNoticeText(text: string, screen: string | null | undefined): string {
  if (!screen) return text
  const marker = '\nLast screen:'
  const i = text.indexOf(marker)
  if (i === -1) return text
  const head = text.slice(0, i)
  let rest = text.slice(i + marker.length).replace(/^\n/, '')
  if (rest.startsWith(screen)) rest = rest.slice(screen.length)
  else rest = rest.split('\n').filter((l) => l.trim()).slice(-1).join('\n')
  const tail = rest.trim()
  return tail ? `${head}\n${tail}` : head
}

/** "now" or "17m ago". */
export function agoLabel(at: number | null | undefined, now = Date.now()): string {
  const a = ago(at, now)
  return a === 'now' || a === '—' ? a : `${a} ago`
}

/** Keep the start and the (more informative) end of a long path. */
export function middleTruncate(s: string, max = 40): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep * 0.35)
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`
}

export function tmuxSwitch(a: Pick<Agent, 'tmux_session' | 'tmux_window'>): string {
  return `tmux switch-client -t ${a.tmux_session}:${a.tmux_window}`
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
