// Pure helpers behind the board columns: the Done cap, the Later line, and the count tooltips.
import type { Card, CardState } from '@shared/types'
import { cardTimings, formatEstimate } from '@shared/cards'
import type { ColumnView } from './boardFilter'
import { summarizeInsights } from './insights'
import { ago } from './format'
import { columnStats, STALE_DAYS } from './triage'

export const DONE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** When a done card was finished (older cards have no history: their updated date is the best we have). */
export function doneAtOf(card: Card, now: number): number {
  return card.history?.length ? (cardTimings(card, now).done_at ?? card.updated_at) : card.updated_at
}

/** The Done column shows the last 7 days; `older` is how many finished cards are folded behind the "N older" link. */
export function capDone(groups: Record<CardState, ColumnView>, now: number): { groups: Record<CardState, ColumnView>; older: number } {
  const cutoff = now - DONE_DAYS * DAY_MS
  const recent = groups.done.active.filter((c) => doneAtOf(c, now) >= cutoff)
  return { groups: { ...groups, done: { ...groups.done, active: recent } }, older: groups.done.active.length - recent.length }
}

/** "oldest 21d": how long the longest-parked Later card has been parked ('' when nothing is shelved). */
export function oldestShelved(later: Card[], now: number): string {
  if (!later.length) return ''
  const since = Math.min(...later.map((c) => c.later_at ?? c.updated_at))
  return `oldest ${ago(since, now)}`
}

/** "4 done this week · est 0.8× median" (null until something is done). */
export function doneInsight(cards: Card[], now: number): string | null {
  const s = summarizeInsights(cards, now)
  if (!s.completedCount) return null
  const ratio = s.medianEstimateRatio != null ? ` · est ${s.medianEstimateRatio.toFixed(1)}× median` : ''
  return `${s.doneLast7Days} done this week${ratio}`
}

const n = (count: number, word: string) => `${count} ${word}`

/** Lines for the column count's tooltip: what the header used to say with glyphs. */
export function columnTip(state: CardState, active: Card[], later: Card[], now: number, insight: string | null): string[] {
  const st = columnStats(state, active, now)
  const lines = [n(active.length + later.length, active.length + later.length === 1 ? 'ticket' : 'tickets') + (later.length ? ` (${later.length} in Later)` : '')]
  if (st.estimate > 0) lines.push(`~${formatEstimate(st.estimate)} of work`)
  if (st.urgent > 0) lines.push(n(st.urgent, 'urgent'))
  if (st.blocked > 0) lines.push(n(st.blocked, 'blocked'))
  if (st.stale > 0) lines.push(`${st.stale} proposed over ${STALE_DAYS} days ago`)
  if (state === 'done' && insight) lines.push(insight)
  return lines
}
