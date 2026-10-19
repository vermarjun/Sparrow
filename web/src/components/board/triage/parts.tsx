// Small pieces of Triage mode: the key hint strip and the "Blocked on…" prompt.
import { useState } from 'react'
import type { Card } from '@shared/types'
import { cardKey } from '@shared/cards'
import type { TriagePass } from '@/lib/triageMode'

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 py-px font-sans text-[10px] font-medium text-zinc-600">{children}</kbd>
)

export function Hints({ pass }: { pass: TriagePass }) {
  const items: [string, string][] = pass === 'inbox'
    ? [['a', 'accept'], ['l', 'later'], ['d', 'drop'], ['u', 'urgent'], ['b', 'blocked'], ['1-3', 'return'], ['⇧1-3', 'effort'], ['z', 'undo']]
    : [['l', 'bring back'], ['d', 'drop'], ['a', 'accept'], ['u', 'urgent'], ['b', 'blocked'], ['z', 'undo']]
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-100 bg-zinc-50/80 px-3 py-2 text-[10.5px] text-zinc-500" data-triage-hints>
      {items.map(([k, what]) => <span key={k} className="inline-flex items-center gap-0.5"><Kbd>{k}</Kbd>{what}</span>)}
    </div>
  )
}

/** Enter blocks the card on what was typed; Esc cancels. The window key handler ignores keys while this input has focus. */
export function BlockedPrompt({ card, onSubmit, onCancel }: { card: Card; onSubmit: (on: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  return (
    <div className="shrink-0 border-t border-orange-200 bg-orange-50 px-3.5 py-2.5" data-triage-block>
      <label className="mb-1 block text-[11px] font-semibold text-orange-800">Blocked on… <span className="font-normal text-orange-700/80">({cardKey(card)})</span></label>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSubmit(text) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        placeholder="Who or what are we waiting on? e.g. IT: sandbox access"
        className="h-8 w-full rounded-md border border-orange-300 bg-white px-2.5 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-orange-400/50"
      />
      <p className="mt-1 text-[10.5px] text-orange-700/80">Enter to block · Esc to cancel</p>
    </div>
  )
}
