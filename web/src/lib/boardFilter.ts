// Pure board logic: search + filters, column grouping, summary line (unit-tested in web/test/boardFilter.test.ts).
import type { Card, CardState } from '@shared/types'
import { cardKey, cardTimings, isQuickWin, parseCardRef, sortCardsBy, type CardSort } from '@shared/cards'

export interface BoardFilters {
  q: string
  urgent: boolean
  blocked: boolean
  quick: boolean
  /** Lowercase category names; empty = any. A card matches when its category is one of them. */
  categories: string[]
  /** Agent id, 'none' (unassigned) or null (anyone). */
  assignee: string | null
  /** Only this column's tickets (set by the Done column's "N older" link; never persisted, like `q`). */
  state: CardState | null
}

export const NO_FILTERS: BoardFilters = { q: '', urgent: false, blocked: false, quick: false, categories: [], assignee: null, state: null }

export const hasFilters = (f: BoardFilters) =>
  !!f.q.trim() || f.urgent || f.blocked || f.quick || f.categories.length > 0 || f.assignee !== null || f.state !== null

/** How many of the Filter popover's four settings are on (category, assignee, quick wins, show dropped): the badge on its button. */
export const popoverFilterCount = (f: BoardFilters, showDropped: boolean) =>
  (f.categories.length ? 1 : 0) + (f.assignee ? 1 : 0) + (f.quick ? 1 : 0) + (showDropped ? 1 : 0)

/** The text a search runs over: key, title, every section, checks, tags, category. */
export function searchText(c: Card): string {
  return [
    cardKey(c), `#${c.id}`, c.title, c.context, c.problem, c.approach, c.details,
    ...(c.checks ?? []).map((k) => k.text), ...(c.tags ?? []), c.category ?? '',
  ].join('\n').toLowerCase()
}

/** Urgent and Blocked only mean something while the ticket is open: Done and Dropped never count (filter, chip, face and summary agree). */
export const isLive = (c: Pick<Card, 'state'>) => c.state !== 'done' && c.state !== 'dropped'

/**
 * A query that is exactly a ticket key or number, without spaces (`SPA-3`, `#3`, `3`), matches that ticket only, not SPA-30..39.
 * Anything else: every whitespace-separated term has to appear (AND).
 */
export function matchesQuery(c: Card, q: string): boolean {
  // `SPA 3` also parses as a ref, but "sprint 3" is more likely a phrase: only the unspaced forms are exact.
  const ref = /\s/.test(q.trim()) ? null : parseCardRef(q)
  if (ref !== null) return c.id === ref
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = searchText(c)
  return terms.every((t) => hay.includes(t))
}

export function cardMatches(c: Card, f: BoardFilters): boolean {
  if (f.urgent && !(c.urgent && isLive(c))) return false
  if (f.blocked && !(c.blocked_on && isLive(c))) return false
  if (f.quick && !(isQuickWin(c) && isLive(c))) return false
  if (f.state && c.state !== f.state) return false
  if (f.categories.length && !(c.category && f.categories.includes(c.category.toLowerCase()))) return false
  if (f.assignee === 'none' && c.assignee_id) return false
  if (f.assignee && f.assignee !== 'none' && c.assignee_id !== f.assignee) return false
  return matchesQuery(c, f.q)
}

export const filterCards = (cards: Card[], f: BoardFilters) => (hasFilters(f) ? cards.filter((c) => cardMatches(c, f)) : cards)

/** Distinct categories (original casing of the first spelling), sorted. */
export function categoriesOf(cards: Card[]): string[] {
  const seen = new Map<string, string>()
  for (const c of cards) if (c.category && !seen.has(c.category.toLowerCase())) seen.set(c.category.toLowerCase(), c.category)
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

// ---------------------------------------------------------------- columns

/** Shelved under the Later line: only the Proposed and To do columns have one. */
export const LATER_STATES: CardState[] = ['proposed', 'todo']
export const isShelved = (c: Pick<Card, 'state' | 'later_at'>) => !!c.later_at && LATER_STATES.includes(c.state)

/** Does the toolbar sort apply to this column? In progress / Review stay manual; Done is newest-done first. */
export const sortApplies = (state: CardState) => state === 'proposed' || state === 'todo'

export function doneAt(c: Card): number {
  return cardTimings(c).done_at ?? c.updated_at
}

/** Cards of one column in display order. */
export function orderColumn(state: CardState, cards: Card[], sort: CardSort): Card[] {
  if (state === 'done') return [...cards].sort((a, b) => doneAt(b) - doneAt(a) || b.id - a.id)
  if (state === 'dropped') return sortCardsBy(cards, 'updated')
  return sortCardsBy(cards, sortApplies(state) ? sort : 'manual')
}

export interface ColumnView { active: Card[]; later: Card[] }

export function groupColumns(cards: Card[], sort: CardSort): Record<CardState, ColumnView> {
  const out = {} as Record<CardState, ColumnView>
  for (const s of ['proposed', 'todo', 'in_progress', 'review', 'done', 'dropped'] as CardState[]) {
    const inState = cards.filter((c) => c.state === s)
    out[s] = {
      active: orderColumn(s, inState.filter((c) => !isShelved(c)), sort),
      later: orderColumn(s, inState.filter(isShelved), sort),
    }
  }
  return out
}

// ---------------------------------------------------------------- summary

export interface Summary { total: number; shown: number; urgent: number; blocked: number; later: number }

/** `visible` = what passes the filters (and the dropped toggle); `all` = every ticket of the same scope without filters. */
export function summarize(visible: Card[], all: Card[]): Summary {
  return {
    total: all.length, shown: visible.length,
    urgent: visible.filter((c) => c.urgent && isLive(c)).length,
    blocked: visible.filter((c) => !!c.blocked_on && isLive(c)).length,
    later: visible.filter(isShelved).length,
  }
}

/** `33 tickets · 4 urgent · 2 blocked · 7 later`, `12 of 33 tickets · …` when filtered; zero parts are left out. */
export function summaryText(s: Summary): string {
  const head = s.shown === s.total ? `${s.total} ticket${s.total === 1 ? '' : 's'}` : `${s.shown} of ${s.total} tickets`
  return [head, s.urgent && `${s.urgent} urgent`, s.blocked && `${s.blocked} blocked`, s.later && `${s.later} later`].filter(Boolean).join(' · ')
}

/**
 * The numbers behind the title line. The urgent / blocked / later counts ignore the urgent and blocked toggles themselves
 * (so switching one on does not zero the others); they still follow search, category, assignee, quick wins and state.
 */
export function summaryCounts(scope: Card[], f: BoardFilters): Summary {
  const base = filterCards(scope, { ...f, urgent: false, blocked: false })
  return { ...summarize(base, base), total: scope.length, shown: filterCards(base, { ...NO_FILTERS, urgent: f.urgent, blocked: f.blocked }).length }
}
