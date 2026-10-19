// The ticket timeline: comments as blocks, server events as compact lines (unit-tested).
import type { Card, CardNote } from '@shared/types'

export const noteKind = (n: CardNote) => n.kind ?? 'comment'

export type EventIcon = 'move' | 'assign' | 'urgent' | 'blocked' | 'later' | 'edit' | 'check' | 'report' | 'other'

/** Pick the small icon for an event line from the server's wording (moved…, assigned to…, marked urgent, …). */
export function eventIcon(text: string): EventIcon {
  const t = text.trim().toLowerCase()
  if (/^moved\b|→/.test(t) && !/reported/.test(t)) return 'move'
  if (/reported (done|blocked|failed)/.test(t)) return 'report'
  if (/^(assigned to|unassigned)/.test(t)) return 'assign'
  if (/urgent/.test(t)) return 'urgent'
  if (/^(blocked|unblocked)/.test(t)) return 'blocked'
  if (/later/.test(t)) return 'later'
  if (/^(checked|unchecked)/.test(t)) return 'check'
  if (/^edited\b/.test(t)) return 'edit'
  return 'other'
}

/** Oldest first; `commentsOnly` drops the events. Stable for equal times. */
export function timeline(card: Pick<Card, 'notes'>, commentsOnly: boolean): CardNote[] {
  const list = (card.notes ?? []).map((n, i) => ({ n, i })).filter(({ n }) => !commentsOnly || noteKind(n) === 'comment')
  return list.sort((a, b) => a.n.at - b.n.at || a.i - b.i).map(({ n }) => n)
}

export const commentCount = (card: Pick<Card, 'notes'>) => (card.notes ?? []).filter((n) => noteKind(n) === 'comment').length
