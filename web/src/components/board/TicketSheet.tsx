// The ticket sheet: the detail panel a card opens into. Read it, fix it, hand it to an agent.
import { useRef } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { cardKey } from '@shared/cards'
import { useNow } from '@/components/sparrow/bits'
import { useStore } from '@/lib/store'
import { Activity } from './sheet/activity'
import { SheetFooter } from './sheet/footer'
import { BlockedBanner, Properties, SheetHeader } from './sheet/header'
import { Brief } from './sheet/sections'
import { Timing } from './sheet/timing'

/** `categories` (optional) are the names the board already knows; the combobox also learns them from the store. */
export function TicketSheet({ cardId, onClose, categories }: { cardId: number | null; onClose: () => void; categories?: string[] }) {
  const raw = useStore((s) => (cardId != null ? s.cards[cardId] : undefined))
  // A card from before v2 may lack the list fields entirely; every part below can assume arrays.
  const card = raw && { ...raw, checks: raw.checks ?? [], tags: raw.tags ?? [], notes: raw.notes ?? [], history: raw.history ?? [] }
  const now = useNow(30_000)
  const content = useRef<HTMLDivElement>(null)
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
        className="gap-0 bg-zinc-50 p-0 data-[side=right]:w-[min(720px,100vw)] data-[side=right]:sm:max-w-[720px]"
      >
        {card && (
          <>
            <SheetTitle className="sr-only">{cardKey(card)} {card.title}</SheetTitle>
            <SheetDescription className="sr-only">Ticket details. Every field can be edited in place.</SheetDescription>
            <SheetHeader card={card} now={now} onClose={onClose} />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-sheet-body>
              <div key={card.id} className="space-y-3 px-6 py-5">
                <BlockedBanner card={card} now={now} />
                <Properties card={card} categories={categories} />
                <Brief card={card} />
                <Timing card={card} now={now} />
                <div className="pt-2"><Activity card={card} now={now} /></div>
              </div>
            </div>
            <SheetFooter card={card} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
