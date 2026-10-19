// Shared visual atoms of the Captains UI (§7.6): captain avatar on its hue, status glyph, agent state dot,
// fleet strip, unread pill. Colour is information only: state colours + captain hues. Both builders use these;
// change them only through @ui-lead so the sidebar, home and captain page stay one language.
import type { CSSProperties } from 'react'
import type { Agent, AgentState, CaptainStatus } from '@shared/types'
import { captainInitial, hueOf, type StripSegment } from '@/lib/captains'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const hueStyle = (id: string): CSSProperties => ({ ['--h' as string]: hueOf(id) })

const AVATAR_SIZE = { xs: 'size-4 text-[9px] rounded-[5px]', sm: 'size-5 text-[10px] rounded-md', md: 'size-7 text-xs rounded-lg', lg: 'size-10 text-base rounded-xl' }

/** Letter on the captain's own hue. `soft` = tinted background (lists), solid otherwise (headers). */
export function CaptainAvatar({ id, handle, size = 'sm', soft = true, className }: { id: string; handle: string; size?: keyof typeof AVATAR_SIZE; soft?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      style={hueStyle(id)}
      className={cn('inline-grid shrink-0 select-none place-items-center font-semibold leading-none', soft ? 'cap-soft' : 'cap-bg text-white dark:text-black/80', AVATAR_SIZE[size], className)}
    >
      {captainInitial(handle)}
    </span>
  )
}

/** Agent avatar: neutral circle with its initial (agents are not hued; only captains are). */
export function AgentAvatar({ handle, size = 'sm', className }: { handle: string; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  const s = size === 'xs' ? 'size-4 text-[9px]' : size === 'sm' ? 'size-5 text-[10px]' : 'size-7 text-xs'
  return (
    <span aria-hidden className={cn('inline-grid shrink-0 select-none place-items-center rounded-full bg-muted font-medium uppercase leading-none text-muted-foreground', s, className)}>
      {handle[0] ?? '?'}
    </span>
  )
}

export const STATE_DOT: Record<AgentState, string> = {
  working: 'bg-ok',
  queued: 'bg-ok/40',
  waiting: 'bg-warn',
  crashed: 'bg-bad',
  idle: 'bg-zinc-300 dark:bg-zinc-600',
  retired: 'bg-zinc-200 dark:bg-zinc-700',
}

export const STATE_LABEL: Record<AgentState, string> = {
  working: 'Working', queued: 'Queued', waiting: 'Waiting', crashed: 'Crashed', idle: 'Idle', retired: 'Retired',
}

/** 6–8 px dot for an agent state; working breathes. */
export function StateDot({ state, className }: { state: AgentState; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', STATE_DOT[state], state === 'working' && 'sp-breathe', className)} />
}

/** Captain status glyph for lists: green breathing dot (working), amber dot (needs you), nothing for idle/archived. */
export function StatusGlyph({ status, className }: { status: CaptainStatus; className?: string }) {
  if (status === 'working') return <span aria-label="Working" className={cn('inline-block size-2 shrink-0 rounded-full bg-ok sp-breathe', className)} />
  if (status === 'attention') return <span aria-label="Needs you" className={cn('inline-block size-2 shrink-0 rounded-full bg-warn', className)} />
  return null
}

/** Small count pill (unread results / questions). */
export function CountPill({ n, tone = 'warn', className }: { n: number; tone?: 'warn' | 'neutral'; className?: string }) {
  if (n <= 0) return null
  return (
    <span className={cn(
      'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular',
      tone === 'warn' ? 'bg-warn/20 text-amber-800 dark:text-amber-200' : 'bg-muted text-muted-foreground',
      className,
    )}>
      {n > 99 ? '99+' : n}
    </span>
  )
}

const SEG: Record<AgentState, string> = {
  working: 'bg-ok sp-shimmer',
  queued: 'bg-ok/35',
  waiting: 'bg-warn',
  crashed: 'bg-bad',
  idle: 'bg-zinc-300 dark:bg-zinc-600',
  retired: 'bg-zinc-200 dark:bg-zinc-800',
}

/** One rounded segment per hire, coloured by state; working ones shimmer (§7.2). Fixed height: never shifts layout.
 *  Each segment has a tooltip (`@handle · state`); its hit area is taller than the 6 px bar. */
export function FleetStrip({ segments, more, className }: { segments: StripSegment[]; more: number; className?: string }) {
  if (!segments.length) return <span className={cn('inline-flex h-1.5 items-center text-[11px] leading-none text-muted-foreground/60', className)}>no team yet</span>
  return (
    <span className={cn('inline-flex h-1.5 items-center', className)} aria-label={`${segments.length + more} hires`}>
      {segments.map((s) => (
        <Tooltip key={s.id}>
          <TooltipTrigger asChild>
            <span className="inline-flex py-2 pr-[3px]" aria-label={`@${s.handle} · ${STATE_LABEL[s.state]}`}>
              <span className={cn('h-1.5 w-2.5 rounded-full', SEG[s.state])} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">@{s.handle} · {STATE_LABEL[s.state].toLowerCase()}</TooltipContent>
        </Tooltip>
      ))}
      {more > 0 && <span className="ml-1 text-[10px] leading-none text-muted-foreground tabular">+{more}</span>}
    </span>
  )
}

/** Result status chip colours. */
export const RESULT_TONE = {
  ok: { rail: 'border-l-ok', chip: 'bg-ok/12 text-emerald-700 dark:text-emerald-300', label: 'Done' },
  blocked: { rail: 'border-l-warn', chip: 'bg-warn/15 text-amber-700 dark:text-amber-300', label: 'Blocked' },
  failed: { rail: 'border-l-bad', chip: 'bg-bad/12 text-red-700 dark:text-red-300', label: 'Failed' },
} as const

/** Harness as a quiet text tag (claude / codex / opencode). */
export function HarnessTag({ harness, className }: { harness: Agent['harness'] | 'unknown'; className?: string }) {
  if (harness === 'human') return null
  return <span className={cn('font-mono text-[11px] text-muted-foreground', className)}>{harness}</span>
}
