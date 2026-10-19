// Small visual vocabulary shared by the card face, list rows and the ticket sheet.
// Colour is never alone: every marker carries an icon, text or a pattern.
import { type ReactNode } from 'react'
import { Anchor, ArrowDown, Ban, Equal, Flame, Gem, Minus, Moon, Mountain, Rocket, Zap, type LucideIcon } from 'lucide-react'
import type { Agent, Card, CardState } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COLUMN_BY_STATE, categoryClass } from '@/lib/boardStyle'
import { AVATAR_TONE, assigneeTip, categoryDot, initials, partialOf, payoffOf, payoffTip, type PayoffId, type PayoffTone } from '@/lib/faceA'
import { cn } from '@/lib/utils'
import { QUICK_COLOR } from '@/lib/swatchStyle'

export function Tip({ label, children, side }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={4}>{label}</TooltipContent>
    </Tooltip>
  )
}

export function CategoryChip({ name, className }: { name: string; className?: string }) {
  return <span className={cn('inline-flex max-w-[9rem] items-center truncate rounded-md px-1.5 py-px text-[11px] leading-4 font-medium', categoryClass(name), className)}>{name}</span>
}

export function StatePill({ state, className }: { state: CardState; className?: string }) {
  const s = COLUMN_BY_STATE[state]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[11px] leading-4 font-medium whitespace-nowrap', s.pill, className)}>
      <span className={cn('size-1.5 rounded-full', s.dot)} />
      {s.name}
    </span>
  )
}

const PAYOFF_ICON: Record<PayoffId, LucideIcon> = { quick: Zap, worth: Gem, bet: Rocket, steady: Equal, heavy: Mountain, filler: Minus, lowvalue: ArrowDown, pit: Anchor }
const PAYOFF_TEXT: Record<PayoffTone, string> = {
  good: 'text-emerald-700 dark:text-emerald-300',
  invest: 'text-indigo-700 dark:text-indigo-300',
  neutral: 'text-muted-foreground',
  costly: 'text-amber-900/65',
  dim: 'text-muted-foreground/70',
}

/** Return x effort as one plain word with a small icon ("Quick win", "Big bet"). `face`: only the words that change a decision (the board card); otherwise every word, and a quiet grey half-answer when only one of the two is set. */
export function PayoffLabel({ card, face, className }: { card: Pick<Card, 'impact' | 'effort' | 'estimate_min'>; face?: boolean; className?: string }) {
  const payoff = payoffOf(card)
  const partial = payoff ? null : partialOf(card)
  if (face ? !payoff?.face : !payoff && !partial) return null
  if (!payoff) {
    return <Tip label={payoffTip(card)}><span className={cn('shrink-0 text-[11px] text-muted-foreground/70', className)} data-payoff="partial">{partial}</span></Tip>
  }
  const Icon = PAYOFF_ICON[payoff.id]
  return (
    <Tip label={payoffTip(card)}>
      <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold whitespace-nowrap', PAYOFF_TEXT[payoff.tone], className)} data-payoff={payoff.id}>
        {payoff.id === 'quick' ? <Zap className="size-3" style={{ color: QUICK_COLOR, fill: `${QUICK_COLOR}40` }} aria-hidden /> : <Icon className="size-3" aria-hidden />}
        {payoff.label}
      </span>
    </Tip>
  )
}

/** Category as a coloured dot and quiet lowercase text. */
export function CategoryLabel({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground lowercase', className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', categoryDot(name))} aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** Neutral initials avatar with a green corner dot while the agent works. */
export function Avatar({ agent, className }: { agent: Agent; className?: string }) {
  return (
    <Tip label={assigneeTip(agent)}>
      <span
        className={cn('relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[8.5px] leading-none font-semibold tracking-tight', AVATAR_TONE, agent.kind === 'human' && 'ring-1 ring-ring', className)}
        data-avatar={agent.handle}
        aria-label={`@${agent.handle}`}
      >
        {initials(agent.handle)}
        {agent.state === 'working' && <span className="absolute -right-px -bottom-px size-[7px] rounded-full bg-emerald-500 ring-[1.5px] ring-white" aria-hidden />}
      </span>
    </Tip>
  )
}

export function UrgentFlag({ short, className }: { short?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-semibold text-red-600 dark:text-red-300', className)} data-flag="urgent">
      <Flame className="size-3.5" />
      {!short && 'Urgent'}
    </span>
  )
}

export function BlockedFlag({ on, short, className }: { on?: string | null; short?: boolean; className?: string }) {
  const el = (
    <span className={cn('inline-flex min-w-0 items-center gap-0.5 text-[11px] font-semibold text-orange-600 dark:text-orange-300', className)} data-flag="blocked">
      <Ban className="size-3.5 shrink-0" />
      {!short && <span className="min-w-0 truncate">Blocked{on ? <span className="font-medium text-orange-700/90"> · {on}</span> : null}</span>}
    </span>
  )
  return on ? <Tip label={`Blocked on ${on}`}>{el}</Tip> : el
}

export function QuickWinFlag({ short, className }: { short?: boolean; className?: string }) {
  return (
    <Tip label="Quick win: good return for low effort">
      <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-semibold text-green-700 dark:text-green-300', className)} data-flag="quick">
        <Zap className="size-3.5 fill-green-600/20" />
        {!short && 'Quick win'}
      </span>
    </Tip>
  )
}

export function LaterFlag({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground', className)} data-flag="later">
      <Moon className="size-3" />Later
    </span>
  )
}

/** A segmented toggle (density, view). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; icon?: ReactNode }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-7 items-center gap-px rounded-lg bg-muted-foreground/15 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          data-seg={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
            value === o.id && 'bg-background text-foreground shadow-sm',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
