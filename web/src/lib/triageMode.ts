// Pure logic of Triage mode (the split view for clearing the Proposed backlog): the two queues, key → action mapping,
// the progress meter and the focus walk. Keys reuse the board's semantics from ./triage.
// (Unit-tested in web/test/triageMode.test.ts; the DOM wiring lives in components/board/TriageView.tsx.)
import type { Card, CardPatchReq } from '@shared/types'
import { isShelved } from './boardFilter'
import { type KeyLike, triageAction } from './triage'

/** Which list Triage is walking: the live Proposed cards, or the shelved ones ("Review Later"). */
export type TriagePass = 'inbox' | 'later'

/** Newest first is the default: recent proposals are dealt with first. */
export type TriageOrder = 'newest' | 'oldest'
export const DEFAULT_ORDER: TriageOrder = 'newest'
export const parseOrder = (v: unknown): TriageOrder => (v === 'oldest' || v === 'newest' ? v : DEFAULT_ORDER)

/** Ties by id so the order never flickers; `sign` flips the direction. */
const byAge = (age: (c: Card) => number, order: TriageOrder) => (a: Card, b: Card) => {
  const d = age(a) - age(b) || a.id - b.id
  return order === 'newest' ? -d : d
}

/** The first pass: Proposed, not shelved, newest (or oldest) proposal first. */
export function inboxQueue(cards: Card[], order: TriageOrder = DEFAULT_ORDER): Card[] {
  return cards.filter((c) => c.state === 'proposed' && !isShelved(c)).sort(byAge((c) => c.created_at, order))
}

/** The second pass: Proposed cards parked under Later, most recently (or longest) parked first. */
export function laterQueue(cards: Card[], order: TriageOrder = DEFAULT_ORDER): Card[] {
  return cards.filter((c) => c.state === 'proposed' && isShelved(c)).sort(byAge((c) => c.later_at ?? 0, order))
}

export const queueOf = (cards: Card[], pass: TriagePass, order: TriageOrder = DEFAULT_ORDER): Card[] => (pass === 'inbox' ? inboxQueue(cards, order) : laterQueue(cards, order))

export type TriageCommand =
  | { kind: 'step'; dir: 1 | -1 }
  | { kind: 'pane' }
  | { kind: 'exit' }
  | { kind: 'undo' }
  | { kind: 'accept' }
  | { kind: 'later' }
  | { kind: 'bringBack' }
  | { kind: 'drop' }
  | { kind: 'block' }
  | { kind: 'unblock' }
  | { kind: 'patch'; body: CardPatchReq }

/**
 * What a key press means in Triage (null = ignore). Same keys as the board (a l d u 1-3 ⇧1-3, j/k), plus `b` (blocked: asks
 * "Blocked on…", or unblocks a blocked card) and `z` (undo the last action). In the Later pass `l` brings the card back.
 */
export function triageCommand(e: KeyLike, card: Card | null, pass: TriagePass): TriageCommand | null {
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'z') return { kind: 'undo' }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'b') return card ? (card.blocked_on ? { kind: 'unblock' } : { kind: 'block' }) : null
  const a = triageAction(e, card)
  if (!a) return null
  switch (a.kind) {
    case 'step': return a
    case 'clear': return { kind: 'exit' }
    case 'open': return { kind: 'pane' }
    case 'later': return pass === 'later' ? { kind: 'bringBack' } : a
    default: return a
  }
}

/** The patch that puts back what `body` changed (so every key action can offer Undo). */
export function inversePatch(card: Card, body: CardPatchReq): CardPatchReq {
  const back: CardPatchReq = {}
  if ('urgent' in body) back.urgent = card.urgent
  if ('impact' in body) back.impact = card.impact
  if ('effort' in body) back.effort = card.effort
  if ('blocked_on' in body) back.blocked_on = card.blocked_on
  return back
}

/** Toast text for a patch key ("marked urgent", "return set to high"). */
export function patchVerb(body: CardPatchReq): string {
  if ('urgent' in body) return body.urgent ? 'marked urgent' : 'no longer urgent'
  if ('impact' in body) return `return set to ${body.impact}`
  if ('effort' in body) return `effort set to ${body.effort}`
  if ('blocked_on' in body) return body.blocked_on ? `blocked on ${body.blocked_on}` : 'unblocked'
  return 'updated'
}

export interface TriageProgress {
  left: number
  /** Size of the pile at its fullest this session (cards that arrive mid-session grow it). */
  total: number
  /** 0..1 of the pile cleared. */
  done: number
}

/** `peak` is the highest `left` seen so far in this pass; the bar never goes backwards past an arrival, it just rescales. */
export function progressOf(left: number, peak: number): TriageProgress {
  const total = Math.max(left, peak)
  return { left, total, done: total === 0 ? 1 : (total - left) / total }
}

export function headerText(pass: TriagePass, left: number): string {
  const name = pass === 'inbox' ? 'Triage' : 'Review Later'
  return `${name} · ${left === 0 ? 'all clear' : `${left} left`}`
}

/**
 * The cards that left the queue between two renders (accepted, shelved, dropped, even from another tab), with the index they
 * had, so the row can animate out. Cards that are still queued are not ghosts.
 */
export function departed(prev: Card[], next: Card[]): { card: Card; index: number }[] {
  const now = new Set(next.map((c) => c.id))
  const out: { card: Card; index: number }[] = []
  prev.forEach((card, index) => { if (!now.has(card.id)) out.push({ card, index }) })
  return out
}

/** Queue rows with the still-fading ghosts spliced back at the place they left from. */
export function withGhosts(queue: Card[], ghosts: { card: Card; index: number }[]): { card: Card; ghost: boolean }[] {
  const rows = queue.map((card) => ({ card, ghost: false }))
  const live = new Set(queue.map((c) => c.id))
  for (const g of [...ghosts].filter((g) => !live.has(g.card.id)).sort((a, b) => a.index - b.index)) {
    rows.splice(Math.min(g.index, rows.length), 0, { card: g.card, ghost: true })
  }
  return rows
}

/** Where the focus goes when `current` has left the queue: the next card that was behind it and is still queued, else the one before. */
export function focusAfterDeparture(prev: Card[], next: Card[], current: number): number | null {
  const i = prev.findIndex((c) => c.id === current)
  const still = new Set(next.map((c) => c.id))
  if (i < 0) return next[0]?.id ?? null
  for (let j = i + 1; j < prev.length; j++) if (still.has(prev[j].id)) return prev[j].id
  for (let j = i - 1; j >= 0; j--) if (still.has(prev[j].id)) return prev[j].id
  return null
}
