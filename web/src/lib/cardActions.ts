// UI-side card writes: optimistic store update, one PATCH, revert + toast on error. The board only ever PATCHes / POSTs cards.
import { toast } from 'sonner'
import type { Card, CardCreateReq, CardPatchReq } from '@shared/types'
import { cardKey } from '@shared/cards'
import { api } from './api'
import { applyPatch } from './cardPatch'
import { useStore } from './store'

const put = (card: Card) => useStore.setState((s) => ({ cards: { ...s.cards, [card.id]: card } }))

/** Returns the server's card, or null when the write failed (the optimistic change is rolled back). */
export async function patchCard(id: number, body: CardPatchReq): Promise<Card | null> {
  const before = useStore.getState().cards[id]
  if (before) put(applyPatch(before, body))
  try {
    const { card } = await api.patchCard(id, body)
    put(card)
    return card
  } catch (e) {
    if (before) put(before)
    toast.error(`Could not update ${before ? cardKey(before) : `#${id}`}: ${(e as Error).message}`)
    return null
  }
}

/** Position that puts a card last in `state` (used by quick actions and by drops where order is not by hand). */
export function endPosition(state: Card['state'], exceptId?: number): number {
  const ps = Object.values(useStore.getState().cards).filter((c) => c.state === state && c.id !== exceptId).map((c) => c.position)
  return Math.max(0, ...ps) + 1
}

/** Hover actions and sheet buttons: one PATCH plus a toast with Undo. */
export async function quickMove(card: Card, to: Card['state'], verb: string): Promise<void> {
  const from = card.state
  const was = card.position
  const done = await patchCard(card.id, { state: to, position: endPosition(to, card.id) })
  if (done) toast(`${cardKey(card)} ${verb}`, { action: { label: 'Undo', onClick: () => void patchCard(card.id, { state: from, position: was }) } })
}

export async function setLater(card: Card, later: boolean): Promise<void> {
  const done = await patchCard(card.id, { later })
  if (done) toast(`${cardKey(card)} ${later ? 'shelved under Later' : 'back from Later'}`, { action: { label: 'Undo', onClick: () => void patchCard(card.id, { later: !later }) } })
}

/** POST a new ticket and put it in the store (the SSE event would also deliver it). Null + toast on error. */
export async function createCard(project: string, body: CardCreateReq): Promise<Card | null> {
  try {
    const { card } = await api.createCard(project, body)
    put(card)
    return card
  } catch (e) {
    toast.error(`Could not create the ticket: ${(e as Error).message}`)
    return null
  }
}
