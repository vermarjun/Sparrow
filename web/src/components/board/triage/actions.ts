// Triage writes: one PATCH per key, a toast with Undo, and the inverse handed back so `z` can undo it too.
import { toast } from 'sonner'
import type { Card, CardPatchReq } from '@shared/types'
import { cardKey } from '@shared/cards'
import { endPosition, patchCard } from '@/lib/cardActions'
import { inversePatch, patchVerb } from '@/lib/triageMode'

export type Undo = () => void

/** PATCH `body`, toast `${key} ${verb}` with Undo (which PATCHes `back`). Null when the write failed (patchCard already toasted). */
async function write(card: Card, body: CardPatchReq, verb: string, back: CardPatchReq): Promise<Undo | null> {
  const done = await patchCard(card.id, body)
  if (!done) return null
  const undo = () => { toast.dismiss(id); void patchCard(card.id, back) }
  // One toast at a time, bottom-left over the key hints: a stack at the default corner would cover the pane's footer buttons.
  toast.dismiss()
  const id = toast(`${cardKey(card)} ${verb}`, { position: 'bottom-left', action: { label: 'Undo', onClick: undo } })
  return undo
}

export const accept = (card: Card) =>
  write(card, { state: 'todo', position: endPosition('todo', card.id), ...(card.later_at ? { later: false } : {}) }, 'accepted to To do',
    { state: card.state, position: card.position, ...(card.later_at ? { later: true } : {}) })

export const shelve = (card: Card) => write(card, { later: true }, 'shelved under Later', { later: false })
export const bringBack = (card: Card) => write(card, { later: false }, 'back from Later', { later: true })

export const drop = (card: Card) =>
  write(card, { state: 'dropped', position: endPosition('dropped', card.id), ...(card.later_at ? { later: false } : {}) }, 'dropped',
    { state: card.state, position: card.position, ...(card.later_at ? { later: true } : {}) })

export const patch = (card: Card, body: CardPatchReq) => write(card, body, patchVerb(body), inversePatch(card, body))
