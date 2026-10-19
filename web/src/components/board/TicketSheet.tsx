// The ticket sheet: the detail panel a card opens into. Read it, fix it, hand it to an agent.
import { useRef, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import type { Card } from '@shared/types'
import { cardKey } from '@shared/cards'
import { useNow } from '@/components/sparrow/bits'
import { useStore } from '@/lib/store'
import { Activity } from './sheet/activity'
import { SheetFooter } from './sheet/footer'
import { BlockedBanner, SheetHeader, Title } from './sheet/header'
import { PropertySentence } from './sheet/properties'
import { Brief } from './sheet/sections'
import { Timing } from './sheet/timing'

type SheetCard = NonNullable<ReturnType<typeof normalise>>
function normalise(raw: Card | undefined) {
  // A card from before v2 may lack the list fields entirely; every part below can assume arrays.
  return raw && { ...raw, checks: raw.checks ?? [], tags: raw.tags ?? [], notes: raw.notes ?? [], history: raw.history ?? [] }
}

function SheetInner({ card, now, onClose, categories }: { card: SheetCard; now: number; onClose?: () => void; categories?: string[] }) {
  const [asking, setAsking] = useState(false)
  return (
    <>
      <SheetHeader card={card} onClose={onClose} onAskBlock={() => setAsking(true)} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-sheet-body>
        <div key={card.id} className="space-y-5 px-6 pt-5 pb-8">
          <div className="space-y-2.5">
            <Title card={card} />
            <PropertySentence card={card} now={now} categories={categories} />
          </div>
          <BlockedBanner card={card} now={now} asking={asking} onDoneAsking={() => setAsking(false)} />
          <Brief card={card} />
          <Timing card={card} now={now} />
          <Activity card={card} now={now} />
        </div>
      </div>
      <SheetFooter card={card} />
    </>
  )
}

/**
 * `categories` (optional) are the names the board already knows; the combobox also learns them from the store.
 * `mode` 'sheet' (default) is the right-hand overlay; 'pane' renders inline, filling its parent, with no overlay and no
 * close-on-outside (Triage mode hosts it).
 */
export function TicketSheet({ cardId, onClose, categories, mode = 'sheet' }: { cardId: number | null; onClose: () => void; categories?: string[]; mode?: 'sheet' | 'pane' }) {
  const raw = useStore((s) => (cardId != null ? s.cards[cardId] : undefined))
  const card = normalise(raw)
  const now = useNow(30_000)
  const content = useRef<HTMLDivElement>(null)
  if (mode === 'pane') {
    if (!card) return null
    return (
      <div data-ticket-sheet data-mode="pane" className="flex h-full min-h-0 w-full flex-col bg-background">
        <SheetInner key={card.id} card={card} now={now} categories={categories} />
      </div>
    )
  }
  return (
    <Sheet open={cardId != null && !!card} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        ref={content}
        showCloseButton={false}
        aria-describedby={undefined}
        data-ticket-sheet
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Esc inside a field cancels that edit (the field handles it); it must not also close the sheet.
        onEscapeKeyDown={(e) => {
          const a = document.activeElement
          if (a instanceof HTMLElement && (a.matches('input, textarea') || a.isContentEditable) && content.current?.contains(a)) e.preventDefault()
        }}
        className="gap-0 bg-background p-0 data-[side=right]:w-[min(720px,100vw)] data-[side=right]:sm:max-w-[720px]"
      >
        {card && (
          <>
            <SheetTitle className="sr-only">{cardKey(card)} {card.title}</SheetTitle>
            <SheetDescription className="sr-only">Ticket details. Every field can be edited in place.</SheetDescription>
            <SheetInner key={card.id} card={card} now={now} onClose={onClose} categories={categories} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
