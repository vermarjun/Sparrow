// Sticky header (key, state, copy actions, title, meta line) and the properties panel.
import { useState } from 'react'
import { toast } from 'sonner'
import { Ban, Check, ChevronDown, Copy, ClipboardCopy, Flame, Gauge, Moon, Tag, Terminal, Timer, UserRound, X, Layers } from 'lucide-react'
import type { Card, CardState } from '@shared/types'
import { CARD_STATES } from '@shared/types'
import { cardKey, isQuickWin, STATE_LABEL } from '@shared/cards'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { BlockedFlag, LaterFlag, QuickWinFlag, Tip, UrgentFlag } from '@/components/board/markers'
import { patchCard } from '@/lib/cardActions'
import { COLUMN_BY_STATE } from '@/lib/boardStyle'
import { briefFor, copyText, pickCommand, whoName } from '@/lib/cardText'
import { agoLabel, fullDate } from '@/lib/format'
import { originLabel } from '@/lib/timingView'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { AssigneeField, CategoryField, EstimateField, InlineText, LevelPicker, TagsField, ToggleChip } from './fields'

const focusRing = 'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'

function CopyAction({ label, icon, text, toastText, className, iconOnly }: { label: string; icon: React.ReactNode; text: () => string; toastText: string; className?: string; iconOnly?: boolean }) {
  const [done, setDone] = useState(false)
  const click = async () => {
    const ok = await copyText(text())
    if (!ok) { toast.error('Could not copy to the clipboard'); return }
    setDone(true)
    toast.success(toastText)
    setTimeout(() => setDone(false), 1400)
  }
  return (
    <Tip label={label}>
      <Button type="button" variant="outline" size={iconOnly ? 'icon-sm' : 'sm'} onClick={click} aria-label={label} className={cn('bg-white', iconOnly ? 'size-8' : 'h-8 gap-1.5 px-2.5 text-[12.5px] font-medium', className)}>
        {done ? <Check className="text-emerald-600" /> : icon}
        {!iconOnly && <span className="max-sm:hidden">{label}</span>}
      </Button>
    </Tip>
  )
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
      <DropdownMenuContent align="start" className="min-w-44">
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

export function SheetHeader({ card, now, onClose }: { card: Card; now: number; onClose: () => void }) {
  const agents = useStore((s) => s.agents)
  const who = whoName(agents)
  const key = cardKey(card)
  const origin = originLabel(card)
  const author = card.created_by === 'user' ? 'you' : who(card.created_by)
  return (
    <header className="relative shrink-0 border-b border-zinc-200 bg-white">
      <div className={cn('h-1 w-full', COLUMN_BY_STATE[card.state].dot)} aria-hidden />
      <div className="px-6 pt-3.5 pb-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-0.5">
            <span className="font-mono text-[13px] font-semibold tracking-tight whitespace-nowrap text-zinc-700" data-card-key>{key}</span>
            <KeyCopy text={key} />
          </span>
          <StateMenu card={card} />
          <span className="flex min-w-0 items-center gap-2.5 pl-1 whitespace-nowrap">
            {card.urgent && <UrgentFlag />}
            {card.blocked_on && <BlockedFlag />}
            {card.later_at && <LaterFlag />}
            {isQuickWin(card) && <QuickWinFlag short />}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <CopyAction label="Copy for agent" icon={<ClipboardCopy />} text={() => briefFor(card, agents)} toastText={`Copied ${key} as a brief for an agent`} />
            <CopyAction label="Copy pick command" iconOnly icon={<Terminal />} text={() => pickCommand(card)} toastText={`Copied: pick up ${key}`} />
            <Tip label="Close (Esc)">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="ml-0.5 text-zinc-500"><X /></Button>
            </Tip>
          </span>
        </div>
        <div className="mt-2.5">
          <InlineText value={card.title} label="title" onSave={(title) => patchCard(card.id, { title })} className="text-[22px] leading-[1.25] font-semibold tracking-tight text-zinc-900" placeholder="Untitled ticket" />
        </div>
        <p className="mt-1.5 text-[12.5px] text-zinc-500" data-meta>
          {origin} by <span className="font-medium text-zinc-700">{author}</span>
          <span className="mx-1.5 text-zinc-300">·</span>
          <Tip label="Proposed date and time"><span className="tabular-nums">{fullDate(card.created_at)}</span></Tip>
          <span className="text-zinc-400"> ({agoLabel(card.created_at, now)})</span>
          <span className="mx-1.5 text-zinc-300">·</span>
          updated {agoLabel(card.updated_at, now)}
        </p>
      </div>
    </header>
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

// ---------------------------------------------------------------- properties

function Prop({ icon, label, children, wide }: { icon: React.ReactNode; label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-zinc-500 uppercase [&_svg]:size-3">{icon}{label}</div>
      {children}
    </div>
  )
}

export function BlockedBanner({ card, now }: { card: Card; now: number }) {
  if (!card.blocked_on) return null
  const since = card.blocked_at ? agoLabel(card.blocked_at, now).replace(' ago', '') : null
  return (
    <div role="status" data-banner="blocked" className="flex items-center gap-3 rounded-xl border border-orange-300 bg-orange-50 px-4 py-2.5 text-orange-900">
      <Ban className="size-4 shrink-0 text-orange-600" aria-hidden />
      <div className="min-w-0 flex-1 text-[13px]">
        <span className="font-semibold">Blocked on </span>
        <span className="inline-block max-w-full align-bottom">
          <InlineText value={card.blocked_on} label="blocked on" allowEmpty onSave={(t) => patchCard(card.id, { blocked_on: t || null })} className="inline-block w-auto py-0 text-[13px] font-medium" />
        </span>
        {since && <span className="whitespace-nowrap text-orange-700/80"> · for {since}</span>}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => patchCard(card.id, { blocked_on: null })} className="h-7 border-orange-300 bg-white text-[12.5px] font-medium text-orange-800 hover:bg-orange-100">
        Unblock
      </Button>
    </div>
  )
}

export function Properties({ card, categories }: { card: Card; categories?: string[] }) {
  const cards = useStore((s) => s.cards)
  const agents = useStore((s) => s.agents)
  const [asking, setAsking] = useState(false)
  const blocked = !!card.blocked_on
  const toggleBlocked = () => { if (blocked) patchCard(card.id, { blocked_on: null }); else setAsking((a) => !a) }
  return (
    <div className="rounded-xl border border-zinc-200/90 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(24,24,27,0.04)]" data-properties>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleChip icon={<Flame />} label="Urgent" tone="red" active={card.urgent} onClick={() => patchCard(card.id, { urgent: !card.urgent })} title="Urgent: someone is waiting on this right now" />
        <ToggleChip icon={<Ban />} label="Blocked" tone="orange" active={blocked || asking} onClick={toggleBlocked} title="Blocked: waiting on a person or a thing" />
        <ToggleChip icon={<Moon />} label="Later" tone="slate" active={!!card.later_at} onClick={() => patchCard(card.id, { later: !card.later_at })} title="Later: shelve it under the Later line of its column" />
      </div>
      {asking && !blocked && (
        <div className="mt-2.5 flex items-center gap-2" data-blocked-input>
          <Ban className="size-4 shrink-0 text-orange-600" aria-hidden />
          <input
            autoFocus
            aria-label="Blocked on"
            placeholder="Blocked on… who or what are we waiting for?"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const v = e.currentTarget.value.trim()
                if (v) { patchCard(card.id, { blocked_on: v }); setAsking(false) }
              } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAsking(false) }
            }}
            className="h-8 min-w-0 flex-1 rounded-lg border border-orange-300 bg-orange-50/60 px-2.5 text-[13px] outline-none placeholder:text-orange-700/50 focus:ring-2 focus:ring-orange-200"
          />
          <span className="text-[11px] text-zinc-400">Enter to block</span>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3.5">
        <Prop icon={<Gauge />} label="Return">
          <LevelPicker label="Return" value={card.impact} onChange={(impact) => patchCard(card.id, { impact })} />
        </Prop>
        <Prop icon={<Gauge />} label="Effort">
          <LevelPicker label="Effort" value={card.effort} onChange={(effort) => patchCard(card.id, { effort })} />
        </Prop>
        <Prop icon={<Timer />} label="Estimate">
          <EstimateField key={card.estimate_min ?? 'none'} minutes={card.estimate_min} onSave={(estimate_min) => patchCard(card.id, { estimate_min })} />
        </Prop>
        <Prop icon={<UserRound />} label="Assignee">
          <AssigneeField assigneeId={card.assignee_id} agents={agents} onSave={(assignee) => patchCard(card.id, { assignee })} />
        </Prop>
        <Prop icon={<Layers />} label="Category">
          <CategoryField category={card.category} cards={Object.values(cards)} projectId={card.project_id} known={categories} onSave={(category) => patchCard(card.id, { category })} />
        </Prop>
        <Prop icon={<Tag />} label="Tags">
          <TagsField tags={card.tags ?? []} onSave={(tags) => patchCard(card.id, { tags })} />
        </Prop>
      </div>
    </div>
  )
}
