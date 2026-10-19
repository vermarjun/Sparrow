// Small visual vocabulary shared by the card face, list rows and the ticket sheet.
// Colour is never alone: every marker carries an icon or text.
import { type ReactNode } from 'react'
import { Ban, Check, CheckCircle2, Flame, Moon, Zap } from 'lucide-react'
import type { Agent, Card, CardLevel, CardState } from '@shared/types'
import { formatEstimate } from '@shared/cards'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StateDot } from '@/components/sparrow/bits'
import { COLUMN_BY_STATE, categoryClass } from '@/lib/boardStyle'
import { cn } from '@/lib/utils'

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

export function TagChip({ name }: { name: string }) {
  return <span className="inline-flex items-center rounded-md border border-zinc-300/80 bg-white/70 px-1.5 py-px text-[10.5px] leading-4 text-zinc-600">{name}</span>
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

const LEVEL_RANK: Record<CardLevel, number> = { low: 1, medium: 2, high: 3 }
const LEVEL_WORD: Record<CardLevel, string> = { low: 'low', medium: 'medium', high: 'high' }

/** The three-bar signal glyph (rank 0-3). */
export function Bars({ rank, className }: { rank: number; className?: string }) {
  return (
    <span className={cn('flex items-end gap-px', className)} aria-hidden>
      {[1, 2, 3].map((i) => (
        <span key={i} className={cn('w-[3px] rounded-[1px]', i === 1 ? 'h-1.5' : i === 2 ? 'h-2' : 'h-2.5', i <= rank ? 'bg-zinc-700' : 'bg-zinc-300')} />
      ))}
    </span>
  )
}

/** Three-bar signal glyph with an R / E label. Empty level renders nothing on the face (`showEmpty` for the list/sheet). */
export function Meter({ kind, level, showEmpty, className }: { kind: 'return' | 'effort'; level: CardLevel | null; showEmpty?: boolean; className?: string }) {
  if (!level && !showEmpty) return null
  const rank = level ? LEVEL_RANK[level] : 0
  const letter = kind === 'return' ? 'R' : 'E'
  const label = `${kind === 'return' ? 'Return' : 'Effort'}: ${level ? LEVEL_WORD[level] : 'not set'}`
  return (
    <Tip label={label}>
      <span className={cn('inline-flex items-center gap-1 text-[10.5px] font-semibold text-zinc-500', !level && 'opacity-50', className)} aria-label={label} data-meter={kind} data-level={level ?? ''}>
        <span className="tracking-wide">{letter}</span>
        <Bars rank={rank} />
      </span>
    </Tip>
  )
}

export function UrgentFlag({ short, className }: { short?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-semibold text-red-600', className)} data-flag="urgent">
      <Flame className="size-3.5" />
      {!short && 'Urgent'}
    </span>
  )
}

export function BlockedFlag({ on, short, className }: { on?: string | null; short?: boolean; className?: string }) {
  const el = (
    <span className={cn('inline-flex min-w-0 items-center gap-0.5 text-[11px] font-semibold text-orange-600', className)} data-flag="blocked">
      <Ban className="size-3.5 shrink-0" />
      {!short && <span className="min-w-0 truncate">Blocked{on ? <span className="font-medium text-orange-700/90"> · {on}</span> : null}</span>}
    </span>
  )
  return on ? <Tip label={`Blocked on ${on}`}>{el}</Tip> : el
}

export function QuickWinFlag({ short, className }: { short?: boolean; className?: string }) {
  return (
    <Tip label="Quick win: good return for low effort">
      <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-semibold text-green-700', className)} data-flag="quick">
        <Zap className="size-3.5 fill-green-600/20" />
        {!short && 'Quick win'}
      </span>
    </Tip>
  )
}

export function LaterFlag({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium text-slate-500', className)} data-flag="later">
      <Moon className="size-3" />Later
    </span>
  )
}

export function DoneMark({ className }: { className?: string }) {
  return <CheckCircle2 className={cn('size-3.5 text-emerald-600', className)} aria-label="Done" />
}

export function Estimate({ min, className }: { min: number | null; className?: string }) {
  if (!min) return null
  return <span className={cn('text-[11px] text-zinc-500 tabular-nums', className)} title="Estimate">~{formatEstimate(min)}</span>
}

export function ChecksProgress({ checks, className }: { checks: Card['checks']; className?: string }) {
  if (!checks?.length) return null
  const done = checks.filter((c) => c.done).length
  const all = done === checks.length
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] tabular-nums', all ? 'text-emerald-700' : 'text-zinc-500', className)} title={`${done} of ${checks.length} done-when checks`}>
      <Check className="size-3" />{done}/{checks.length}
    </span>
  )
}

export function Assignee({ agent, className }: { agent: Agent | null | undefined; className?: string }) {
  if (!agent) return null
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium text-zinc-700', className)}>
      <StateDot state={agent.kind === 'human' ? 'human' : agent.state} />@{agent.handle}
    </span>
  )
}

/** A segmented toggle (density, view). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; icon?: ReactNode }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-7 items-center gap-px rounded-lg bg-zinc-200/70 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          data-seg={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
            value === o.id && 'bg-white text-zinc-900 shadow-sm',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
