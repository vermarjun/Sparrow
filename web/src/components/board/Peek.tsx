// The peek: hover a card for 600ms (or press Space on the keyboard-focused card) for the detail the face leaves out.
import { cloneElement, useState, type ReactElement } from 'react'
import { HoverCard } from 'radix-ui'
import { Check, Circle } from 'lucide-react'
import type { Agent, Card } from '@shared/types'
import { formatEstimate } from '@shared/cards'
import { ago, fullDate } from '@/lib/format'
import { originLabel } from '@/lib/timingView'
import { whoName } from '@/lib/cardText'
import { payoffSentence } from '@/lib/faceA'
import { cn } from '@/lib/utils'
import { Swatch } from './swatch'

export const PEEK_DELAY_MS = 600

/** The brief in a few lines: problem, else context, else the legacy details. */
function briefOf(c: Pick<Card, 'problem' | 'context' | 'details'>): string {
  return (c.problem?.trim() || c.context?.trim() || c.details?.trim() || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/[#*`]/g, '').replace(/\s+/g, ' ').slice(0, 320)
}

export function PeekBody({ card, agents, now }: { card: Card; agents: Record<string, Agent>; now: number }) {
  const who = whoName(agents)
  const brief = briefOf(card)
  const payoff = payoffSentence(card)
  const checks = card.checks ?? []
  const open = checks.filter((c) => !c.done)
  const assignee = card.assignee_id ? agents[card.assignee_id] : null
  const done = card.state === 'done'
  return (
    <div className="flex flex-col gap-2 text-xs" data-peek={card.id}>
      <p className={cn('line-clamp-5 text-[12.5px] leading-relaxed', brief ? 'text-foreground/80' : 'text-muted-foreground/70')}>{brief || 'No description yet.'}</p>
      {!done && card.urgent && <p className="flex items-center gap-1.5 font-medium text-red-600 dark:text-red-300"><Swatch kind="urgent" />Urgent</p>}
      {!done && card.blocked_on && (
        <p className="flex items-start gap-1.5 font-medium text-orange-700 dark:text-orange-300"><Swatch kind="blocked" className="mt-px" /><span>Blocked on {card.blocked_on}{card.blocked_at ? ` · ${ago(card.blocked_at, now)}` : ''}</span></p>
      )}
      {(payoff || card.estimate_min) && (
        <p className="text-muted-foreground">
          {payoff}{payoff && card.estimate_min ? ' · ' : ''}{card.estimate_min ? `~${formatEstimate(card.estimate_min)}` : ''}
        </p>
      )}
      {checks.length > 0 && (
        <div className="flex flex-col gap-0.5" data-peek-checks>
          <p className="text-muted-foreground"><span className="font-medium tabular-nums">{checks.length - open.length}/{checks.length}</span> done when</p>
          {open.slice(0, 3).map((c, i) => <p key={i} className="flex items-start gap-1.5 text-muted-foreground"><Circle className="mt-[3px] size-2.5 shrink-0" /><span className="line-clamp-1">{c.text}</span></p>)}
          {open.length === 0 && <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"><Check className="size-3" />All checks done</p>}
          {open.length > 3 && <p className="pl-4 text-muted-foreground/70">+{open.length - 3} more</p>}
        </div>
      )}
      <p className="border-t border-border/50 pt-1.5 text-[11px] text-muted-foreground/70">
        {originLabel(card)} {fullDate(card.created_at)} by {who(card.created_by)}{assignee ? ` · @${assignee.handle}` : ''}
      </p>
    </div>
  )
}

/** Wraps the card face: hovering it for 600ms opens the peek; `pinned` opens it from the keyboard (Space). */
export function Peek({ card, agents, now, pinned, onPinnedClose, disabled, children }: {
  card: Card
  agents: Record<string, Agent>
  now: number
  pinned?: boolean
  onPinnedClose?: () => void
  /** No peek at all (while a drag is in flight). */
  disabled?: boolean
  children: ReactElement<{ onPointerDown?: () => void }>
}) {
  const [hover, setHover] = useState(false)
  if (disabled) return children
  return (
    <HoverCard.Root openDelay={PEEK_DELAY_MS} closeDelay={80} open={hover || !!pinned} onOpenChange={(o) => { setHover(o); if (!o) onPinnedClose?.() }}>
      {/* A press (click, or the start of a drag) dismisses the peek. */}
      <HoverCard.Trigger asChild>{cloneElement(children, { onPointerDown: () => { setHover(false); onPinnedClose?.() } })}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          className="z-50 w-72 rounded-lg bg-background p-3 shadow-lg ring-1 ring-border outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <PeekBody card={card} agents={agents} now={now} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}
