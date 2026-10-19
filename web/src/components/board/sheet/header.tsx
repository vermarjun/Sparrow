// Sheet header (key, state, copy split button, ⋯ menu, close), the title, and the blocked banner.
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Ban, Check, ChevronDown, ClipboardCopy, Copy, Ellipsis, Flame, Moon, Terminal, X } from 'lucide-react'
import type { Card, CardState } from '@shared/types'
import { CARD_STATES } from '@shared/types'
import { cardKey, STATE_LABEL } from '@shared/cards'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/board/markers'
import { patchCard, quickMove, setLater } from '@/lib/cardActions'
import { COLUMN_BY_STATE } from '@/lib/boardStyle'
import { briefFor, copyText, pickCommand } from '@/lib/cardText'
import { agoLabel } from '@/lib/format'
import { railStyle } from '@/lib/swatchStyle'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { InlineText } from './fields'
import { focusRing } from './pickers'

async function copyWithToast(text: string, toastText: string): Promise<boolean> {
  const ok = await copyText(text)
  if (ok) toast.success(toastText)
  else toast.error('Could not copy to the clipboard')
  return ok
}

function StateMenu({ card }: { card: Card }) {
  const s = COLUMN_BY_STATE[card.state]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`State: ${STATE_LABEL[card.state]}. Change state`}
          data-state-menu
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border pr-1.5 pl-2.5 text-[12.5px] font-semibold whitespace-nowrap transition-[filter] hover:brightness-95', s.pill, focusRing)}
        >
          <span className={cn('size-2 rounded-full', s.dot)} aria-hidden />
          {s.name}
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {CARD_STATES.map((st: CardState) => (
          <DropdownMenuItem key={st} data-state-item={st} onSelect={() => st !== card.state && patchCard(card.id, { state: st })}>
            <span className={cn('size-2 rounded-full', COLUMN_BY_STATE[st].dot)} aria-hidden />
            {STATE_LABEL[st]}
            {st === card.state && <Check className="ml-auto size-3.5 opacity-60" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** `Copy for agent` with a chevron that also offers the pick command. */
function CopySplit({ card }: { card: Card }) {
  const agents = useStore((s) => s.agents)
  const [done, setDone] = useState(false)
  const key = cardKey(card)
  const copyBrief = async () => {
    if (!(await copyWithToast(briefFor(card, agents), `Copied ${key} as a brief for an agent`))) return
    setDone(true)
    setTimeout(() => setDone(false), 1400)
  }
  const edge = 'h-8 border border-zinc-300 bg-white text-zinc-700 transition-colors hover:bg-zinc-50'
  return (
    <span className="inline-flex" data-copy-split>
      <button type="button" onClick={copyBrief} className={cn(edge, 'inline-flex items-center gap-1.5 rounded-l-lg px-2.5 text-[12.5px] font-medium', focusRing)}>
        {done ? <Check className="size-3.5 text-emerald-600" aria-hidden /> : <ClipboardCopy className="size-3.5" aria-hidden />}
        <span className="max-sm:hidden">Copy for agent</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More ways to copy" className={cn(edge, 'rounded-r-lg border-l-0 px-1.5', focusRing)}><ChevronDown className="size-3.5" aria-hidden /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => void copyBrief()}><ClipboardCopy />Copy for agent</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyWithToast(pickCommand(card), `Copied: pick up ${key}`)}><Terminal />Copy pick command</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** Urgent, Blocked…, Later, Drop: the signals are set here and show up once, in the sentence or the banner below. */
function MoreMenu({ card, onAskBlock }: { card: Card; onAskBlock: () => void }) {
  const asked = useRef(false)
  const live = card.state !== 'done' && card.state !== 'dropped'
  const canLater = card.state === 'proposed' || card.state === 'todo'
  if (!live && card.state === 'dropped') return null
  return (
    <DropdownMenu>
      <Tip label="More actions">
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More actions" data-more-menu className={cn('inline-flex size-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 data-[state=open]:bg-zinc-100', focusRing)}><Ellipsis className="size-4" aria-hidden /></button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="w-52"
        // Asking "blocked on…" focuses an input; the menu must not hand focus back to its trigger.
        onCloseAutoFocus={(e) => {
          if (!asked.current) return
          e.preventDefault()
          asked.current = false
          document.querySelector<HTMLInputElement>('[data-ticket-sheet] [data-blocked-input] input')?.focus()
        }}
      >
        {live && (
          <DropdownMenuItem data-menu="urgent" onSelect={() => void patchCard(card.id, { urgent: !card.urgent })}>
            <Flame className={card.urgent ? 'text-red-600' : undefined} />{card.urgent ? 'Remove urgent' : 'Mark urgent'}
          </DropdownMenuItem>
        )}
        {live && (
          <DropdownMenuItem data-menu="blocked" onSelect={() => { if (card.blocked_on) void patchCard(card.id, { blocked_on: null }); else { asked.current = true; onAskBlock() } }}>
            <Ban />{card.blocked_on ? 'Unblock' : 'Blocked…'}
          </DropdownMenuItem>
        )}
        {canLater && (
          <DropdownMenuItem data-menu="later" onSelect={() => void setLater(card, !card.later_at)}>
            <Moon />{card.later_at ? 'Bring back from Later' : 'Later'}
          </DropdownMenuItem>
        )}
        {(live || canLater) && <DropdownMenuSeparator />}
        <DropdownMenuItem data-menu="drop" variant="destructive" onSelect={() => void quickMove(card, 'dropped', 'dropped')}>
          <X />Drop
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function KeyCopy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Tip label={done ? 'Copied' : 'Copy key'}>
      <button
        type="button"
        aria-label="Copy key"
        onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1200) } }}
        className={cn('rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700', focusRing)}
      >
        {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      </button>
    </Tip>
  )
}

/** The one fixed bar: who this is, where it is, what to copy. `onClose` is omitted in pane mode (Triage mode owns Esc). */
export function SheetHeader({ card, onClose, onAskBlock }: { card: Card; onClose?: () => void; onAskBlock: () => void }) {
  const key = cardKey(card)
  return (
    <header className="shrink-0 border-b border-zinc-200/80 bg-white px-6 py-3">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-0.5">
          <span className="font-mono text-[13px] font-semibold tracking-tight whitespace-nowrap text-zinc-700" data-card-key>{key}</span>
          <KeyCopy text={key} />
        </span>
        <StateMenu card={card} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <CopySplit card={card} />
          <MoreMenu card={card} onAskBlock={onAskBlock} />
          {onClose && (
            <Tip label="Close (Esc)">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="size-8 text-zinc-500"><X /></Button>
            </Tip>
          )}
        </span>
      </div>
    </header>
  )
}

export function Title({ card }: { card: Card }) {
  return (
    <InlineText value={card.title} label="title" onSave={(title) => patchCard(card.id, { title })} className="text-[22px] leading-[1.25] font-semibold tracking-tight text-zinc-900" placeholder="Untitled ticket" />
  )
}

/** Orange banner with the hatched rail, only while blocked (or while being asked "blocked on…"). The one place "blocked" is written. */
export function BlockedBanner({ card, now, asking, onDoneAsking }: { card: Card; now: number; asking: boolean; onDoneAsking: () => void }) {
  if (!card.blocked_on && !asking) return null
  const shell = 'relative flex items-center gap-3 overflow-hidden rounded-lg border border-orange-200 bg-orange-50/70 py-2.5 pr-3 pl-5 text-orange-950'
  const rail = <span className="absolute inset-y-0 left-0 w-1.5" style={railStyle('blocked')} aria-hidden />
  if (!card.blocked_on) {
    return (
      <div className={shell} data-banner="blocked" data-blocked-input>
        {rail}
        <input
          aria-label="Blocked on"
          placeholder="Blocked on… who or what are we waiting for?"
          onBlur={(e) => { if (!e.currentTarget.value.trim()) onDoneAsking() }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const v = e.currentTarget.value.trim()
              if (v) { void patchCard(card.id, { blocked_on: v }); onDoneAsking() }
            } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDoneAsking() }
          }}
          className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-orange-800/50"
        />
        <span className="text-[11px] text-orange-800/70">Enter to block</span>
      </div>
    )
  }
  const since = card.blocked_at ? agoLabel(card.blocked_at, now).replace(' ago', '') : null
  return (
    <div role="status" data-banner="blocked" className={shell}>
      {rail}
      <div className="min-w-0 flex-1 text-[13.5px]">
        <span className="font-semibold">Blocked on </span>
        <span className="inline-block max-w-full align-bottom">
          <InlineText value={card.blocked_on} label="blocked on" allowEmpty onSave={(t) => patchCard(card.id, { blocked_on: t || null })} className="inline-block w-auto py-0 text-[13.5px] font-medium" />
        </span>
        {since && <span className="whitespace-nowrap text-orange-800/70"> · {since}</span>}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => patchCard(card.id, { blocked_on: null })} className="h-7 border-orange-300 bg-white text-[12.5px] font-medium text-orange-800 hover:bg-orange-100">
        Unblock
      </Button>
    </div>
  )
}
