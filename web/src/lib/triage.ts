// Pure triage logic: board-order focus walking, keyboard → action mapping, and the per-column planning stats shown in headers.
// (Unit-tested in web/test/triage.test.ts; the DOM wiring lives in pages/Board.tsx.)
import type { Card, CardLevel, CardPatchReq, CardState } from '@shared/types'
import { cardKey } from '@shared/cards'
import { LATER_STATES, type ColumnView, isLive, isShelved } from './boardFilter'

export const STALE_DAYS = 14
const DAY_MS = 86_400_000

// ---------------------------------------------------------------- column stats

export interface ColumnStats {
  /** Sum of estimate_min over the visible, non-shelved cards (0 = nothing estimated). */
  estimate: number
  urgent: number
  blocked: number
  /** Proposed only: cards proposed more than STALE_DAYS days ago. */
  stale: number
}

export function columnStats(state: CardState, active: Card[], now: number): ColumnStats {
  let estimate = 0, urgent = 0, blocked = 0, stale = 0
  for (const c of active) {
    if (isShelved(c)) continue
    estimate += c.estimate_min ?? 0
    if (isLive(c)) {
      if (c.urgent) urgent++
      if (c.blocked_on) blocked++
    }
    if (state === 'proposed' && now - c.created_at > STALE_DAYS * DAY_MS) stale++
  }
  return { estimate, urgent, blocked, stale }
}

// ---------------------------------------------------------------- focus order

/** The cards of the board in the order j/k walks them: column by column, active first, then the open Later zone. */
export function boardOrder(groups: Record<CardState, ColumnView>, columns: { id: CardState }[], laterOpen: { proposed: boolean; todo: boolean }): Card[] {
  const out: Card[] = []
  for (const col of columns) {
    const g = groups[col.id]
    out.push(...g.active)
    if (LATER_STATES.includes(col.id) && laterOpen[col.id as 'proposed' | 'todo']) out.push(...g.later)
  }
  return out
}

/** The card after a `j` / before a `k`. Nothing focused (or the focus left the board) starts at the first / last card; the ends do not wrap. */
export function stepFocus(order: Card[], current: number | null, dir: 1 | -1): number | null {
  if (!order.length) return null
  const i = current === null ? -1 : order.findIndex((c) => c.id === current)
  if (i < 0) return (dir === 1 ? order[0] : order[order.length - 1]).id
  return order[Math.min(order.length - 1, Math.max(0, i + dir))].id
}

/** Where the focus goes once `current` leaves its place (accepted, dropped, shelved): the next card, else the previous one. */
export function focusAfterRemoval(order: Card[], current: number): number | null {
  const i = order.findIndex((c) => c.id === current)
  if (i < 0) return null
  return (order[i + 1] ?? order[i - 1])?.id ?? null
}

// ---------------------------------------------------------------- keys

export type TriageAction =
  | { kind: 'step'; dir: 1 | -1 }
  | { kind: 'open' }
  | { kind: 'clear' }
  | { kind: 'accept' }
  | { kind: 'later' }
  | { kind: 'drop' }
  | { kind: 'patch'; body: CardPatchReq }

export interface KeyLike { key: string; code?: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }

const LEVELS: Record<string, CardLevel> = { Digit1: 'low', Digit2: 'medium', Digit3: 'high' }

/** What a key press means for the focused card (null = not a triage key, or not allowed for this card). */
export function triageAction(e: KeyLike, card: Card | null): TriageAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const k = e.key
  if (k === 'j' || k === 'ArrowDown') return { kind: 'step', dir: 1 }
  if (k === 'k' || k === 'ArrowUp') return { kind: 'step', dir: -1 }
  if (k === 'Escape') return { kind: 'clear' }
  if (!card) return null
  if (k === 'Enter') return { kind: 'open' }
  const live = isLive(card)
  const shelvable = LATER_STATES.includes(card.state)
  if (k === 'a') return card.state === 'proposed' ? { kind: 'accept' } : null
  if (k === 'l') return shelvable ? { kind: 'later' } : null
  if (k === 'd') return shelvable ? { kind: 'drop' } : null
  if (k === 'u') return live ? { kind: 'patch', body: { urgent: !card.urgent } } : null
  // Digits: shift+digit types `!`/`@`/`#`, so read the physical key.
  const level = e.code ? LEVELS[e.code] : undefined
  if (level && live) return { kind: 'patch', body: e.shiftKey ? { effort: level } : { impact: level } }
  return null
}

// ---------------------------------------------------------------- undo

/** The toast text and the PATCH body that reverts a key action on `card` (null = the body changes nothing we can undo). */
export function patchUndo(card: Card, body: CardPatchReq): { label: string; undo: CardPatchReq } | null {
  const key = cardKey(card)
  if (body.urgent !== undefined) return { label: `${key} ${body.urgent ? 'marked urgent' : 'no longer urgent'}`, undo: { urgent: card.urgent } }
  if (body.impact !== undefined) return { label: `${key} return ${body.impact ?? 'cleared'}`, undo: { impact: card.impact } }
  if (body.effort !== undefined) return { label: `${key} effort ${body.effort ?? 'cleared'}`, undo: { effort: card.effort } }
  return null
}

// ---------------------------------------------------------------- shortcut sheet

export interface ShortcutGroup { title: string; keys: [string, string][] }

/** Every key the board and Triage mode answer to, as the `?` sheet lists them. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { title: 'Board', keys: [
    ['/', 'Search'],
    ['n', 'New ticket'],
    ['t', 'Triage the Proposed tickets'],
    ['?', 'This sheet'],
  ] },
  { title: 'Move around', keys: [
    ['j / ↓', 'Next card'],
    ['k / ↑', 'Previous card'],
    ['Enter', 'Open the ticket'],
    ['Esc', 'Clear the focus'],
  ] },
  { title: 'Act on the focused card', keys: [
    ['a', 'Accept to To do'],
    ['l', 'Later: shelve or bring back'],
    ['d', 'Drop'],
    ['u', 'Toggle urgent'],
    ['1 2 3', 'Return: low / medium / high'],
    ['⇧1 ⇧2 ⇧3', 'Effort: low / medium / high'],
  ] },
  { title: 'In Triage', keys: [
    ['j / k', 'Next / previous ticket'],
    ['a  l  d  u  b', 'Accept, Later, Drop, Urgent, Blocked'],
    ['1-3  ⇧1-3', 'Return, effort'],
    ['Esc', 'Back to the board'],
  ] },
]
