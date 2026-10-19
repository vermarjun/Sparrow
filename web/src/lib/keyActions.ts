// Key actions that write a card and say how to take it back: one PATCH, then a toast with Undo (PATCH back the previous values).
// accept / later / drop already do this in cardActions.ts (quickMove, setLater); this covers urgent, return and effort.
import { toast } from 'sonner'
import type { Card, CardPatchReq } from '@shared/types'
import { patchCard } from './cardActions'
import { patchUndo } from './triage'

export async function patchWithUndo(card: Card, body: CardPatchReq): Promise<void> {
  const u = patchUndo(card, body)
  const done = await patchCard(card.id, body)
  if (done && u) toast(u.label, { action: { label: 'Undo', onClick: () => void patchCard(card.id, u.undo) } })
}
