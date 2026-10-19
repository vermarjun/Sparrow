// What a drop on the board means: one PATCH (or nothing). Pure so it can be tested without a browser.
import type { Card, CardPatchReq, CardState } from '@shared/types'
import type { CardSort } from '@shared/cards'
import { LATER_STATES, isShelved, sortApplies } from './boardFilter'
import { moveFor } from './format'

export type DragItem = { id: string; name: string; column: string; cardId: number; later?: boolean }

/** The droppable id of a column's Later line. */
export const laterZoneId = (state: CardState) => `later:${state}`
export const zoneState = (id: string | number | null | undefined): CardState | null =>
  typeof id === 'string' && id.startsWith('later:') && LATER_STATES.includes(id.slice(6) as CardState) ? (id.slice(6) as CardState) : null

/** Can cards in this column be reordered by hand under the current sort? Done and Dropped are ordered by time, never by hand. */
export const reorderable = (state: CardState, sort: CardSort) =>
  state !== 'done' && state !== 'dropped' && (!sortApplies(state) || sort === 'manual')

export function planDrop(a: {
  card: Card
  before: DragItem[]            // items when the drag started
  final: DragItem[]             // items after the drop was applied
  overId: string | number | null
  sort: CardSort
  cards: Record<number, Card>   // store snapshot at drag start
}): CardPatchReq | null {
  const { card, before, final, overId, sort, cards } = a
  const moved = final.find((i) => i.cardId === card.id)
  if (!moved) return null
  const toState = moved.column as CardState
  const sameState = toState === card.state
  const laterCapable = LATER_STATES.includes(toState)

  const overItem = final.find((i) => i.id === String(overId))
  const shelve = laterCapable && (zoneState(overId) === toState || !!overItem?.later)
  const wasShelved = isShelved(card)

  const positions = new Map(Object.values(cards).map((c) => [c.id, c.position]))
  const inColumn = (items: DragItem[]) => items.filter((i) => i.column === toState).map((i) => i.cardId)
  const endOfColumn = Math.max(0, ...Object.values(cards).filter((c) => c.state === toState && c.id !== card.id).map((c) => c.position)) + 1

  let patch: CardPatchReq | null = null
  if (zoneState(overId)) {
    // Dropped on the Later line itself: join the end of the shelf.
    if (!sameState || !wasShelved) patch = { ...(sameState ? {} : { state: toState }), position: endOfColumn }
  } else if (reorderable(toState, sort)) {
    patch = moveFor(card, toState, inColumn(final), positions, inColumn(before).filter((id) => before.find((i) => i.cardId === id)?.column === toState))
  } else if (!sameState) {
    patch = { state: toState, position: endOfColumn }
  }

  // Leaving for In progress / Review / Done needs no flag: the server clears Later when work starts.
  if (laterCapable && shelve !== wasShelved) patch = { ...(patch ?? {}), later: shelve }
  return patch
}
