// The board card face: one face, title is the hero. Return x effort is one plain-word payoff label; urgent / blocked are the left
// rail (same swatches as the toolbar legend); done is a green check; Later is muted. No pills, no tags, no signal bars.
import { type MouseEvent, type ReactNode } from 'react'
import { ArrowUpFromLine, Check, MessageSquareText, Moon, X } from 'lucide-react'
import type { Agent, Card } from '@shared/types'
import { cardKey, cardTimings } from '@shared/cards'
import { ago, fullDate } from '@/lib/format'
import { isShelved } from '@/lib/boardFilter'
import { commentCount } from '@/lib/activity'
import { originLabel } from '@/lib/timingView'
import { whoName } from '@/lib/cardText'
import { payoffOf, railOf, railTip, type Rail } from '@/lib/faceA'
import { cn } from '@/lib/utils'
import { Avatar, CategoryLabel, PayoffLabel, Tip } from './markers'
import { Peek } from './Peek'
import { railStyle } from '@/lib/swatchStyle'

export interface FaceActions {
  accept: (c: Card) => void
  later: (c: Card) => void
  bringBack: (c: Card) => void
  drop: (c: Card) => void
}

function HoverButton({ label, onClick, children, tone }: { label: string; onClick: () => void; children: ReactNode; tone?: 'good' | 'bad' }) {
  const handle = (e: MouseEvent) => { e.stopPropagation(); onClick() }
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        data-action={label}
        onClick={handle}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          'inline-flex size-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&_svg]:size-3.5',
          tone === 'good' && 'hover:bg-emerald-50 hover:text-emerald-700',
          tone === 'bad' && 'hover:bg-red-50 hover:text-red-600',
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

/** Accept / Later / Drop on Proposed, Later on To do. Appears on hover and when focus is inside the card. */
function QuickActions({ card, act }: { card: Card; act: FaceActions }) {
  const shelved = isShelved(card)
  const canShelve = card.state === 'proposed' || card.state === 'todo'
  if (card.state !== 'proposed' && !canShelve) return null
  return (
    <div className="absolute top-1 right-1.5 z-10 flex items-center gap-px rounded-md bg-white/95 p-0.5 opacity-0 shadow-sm ring-1 ring-zinc-200 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100" data-quick-actions>
      {card.state === 'proposed' && <HoverButton label="Accept to To do" tone="good" onClick={() => act.accept(card)}><Check /></HoverButton>}
      {canShelve && (shelved
        ? <HoverButton label="Bring back from Later" onClick={() => act.bringBack(card)}><ArrowUpFromLine /></HoverButton>
        : <HoverButton label="Move to Later" onClick={() => act.later(card)}><Moon /></HoverButton>)}
      {card.state === 'proposed' && <HoverButton label="Drop" tone="bad" onClick={() => act.drop(card)}><X /></HoverButton>}
    </div>
  )
}

export interface FaceProps {
  card: Card; agents: Record<string, Agent>; now: number; act: FaceActions; onOpen: () => void
  /** The peek is held open from the keyboard (Space on the focused card). */
  peekPinned?: boolean
  onPeekClose?: () => void
  /** A drag is in flight: no peek. */
  peekDisabled?: boolean
}

/** The 4px left rail: solid red (urgent), hatched orange (blocked) or both stacked. A wider invisible hit zone carries the tooltip. */
function RailBar({ rail, lines }: { rail: Exclude<Rail, null>; lines: string[] }) {
  const bar = (
    <span className="absolute inset-y-0 left-0 flex w-2.5 cursor-help" data-rail={rail}>
      <span className="flex h-full w-1 flex-col" aria-hidden>
        {rail !== 'blocked' && <span className="min-h-0 flex-1" style={railStyle('urgent')} />}
        {rail !== 'urgent' && <span className="min-h-0 flex-1" style={railStyle('blocked')} />}
      </span>
    </span>
  )
  return <Tip side="right" label={<span className="flex flex-col">{lines.map((l) => <span key={l}>{l}</span>)}</span>}>{bar}</Tip>
}

export function CardFace({ card, agents, now, act, onOpen, peekPinned, onPeekClose, peekDisabled }: FaceProps) {
  const assignee = card.assignee_id ? agents[card.assignee_id] : null
  const shelved = isShelved(card)
  const done = card.state === 'done'
  const dropped = card.state === 'dropped'
  const comments = commentCount(card)
  const rail = railOf(card)
  const stamp = done ? (cardTimings(card, now).done_at ?? card.updated_at) : card.created_at
  const who = whoName(agents)
  const ageTip = done ? `Done ${fullDate(stamp)}` : `${originLabel(card)} ${fullDate(card.created_at)} by ${who(card.created_by)}`
  const facePayoff = !done && !dropped && !!payoffOf(card)?.face
  const hasFooter = facePayoff || comments > 0 || !!assignee

  return (
    <Peek card={card} agents={agents} now={now} pinned={peekPinned} onPinnedClose={onPeekClose} disabled={peekDisabled}>
      <div
        onClick={onOpen}
        data-card-id={card.id}
        data-key={cardKey(card)}
        data-urgent={card.urgent || undefined}
        data-blocked={card.blocked_on ? '' : undefined}
        data-later={shelved || undefined}
        className={cn(
          'relative flex min-w-0 cursor-pointer flex-col gap-1.5 overflow-hidden rounded-[7px] py-2.5 pr-3 pl-3.5',
          rail === 'urgent' || rail === 'both' ? 'bg-linear-to-r from-red-50/70 to-transparent to-45%' : rail === 'blocked' && 'bg-linear-to-r from-orange-50/70 to-transparent to-45%',
          shelved && 'text-slate-500',
          dropped && 'opacity-70',
        )}
      >
        {rail && <RailBar rail={rail} lines={railTip(card, now)} />}
        <div className="flex min-w-0 items-center gap-1.5">
          {done && <Check className="-ml-0.5 size-3.5 shrink-0 text-emerald-600" strokeWidth={3} aria-label="Done" />}
          <span className={cn('shrink-0 font-mono text-[11px] tracking-tight tabular-nums', done ? 'text-emerald-700' : 'text-zinc-400')}>{cardKey(card)}</span>
          {card.category && <CategoryLabel name={card.category} className={cn('max-w-[7rem]', shelved && 'opacity-70')} />}
          {shelved && (
            <Tip label="Later: parked">
              <Moon className="size-3 shrink-0 text-slate-400" data-flag="later" aria-label="Later" />
            </Tip>
          )}
          <Tip label={ageTip}>
            <span className={cn('shrink-0 text-[11px] tabular-nums', done ? 'text-emerald-700/70' : 'text-zinc-400')} data-age>
              <span aria-hidden className="mr-1.5 text-zinc-300">·</span>{done ? `done ${ago(stamp, now)}` : ago(card.created_at, now)}
            </span>
          </Tip>
        </div>
        <div className={cn('line-clamp-2 text-[14px] leading-snug font-medium text-zinc-900', shelved && 'text-slate-600', done && 'text-zinc-500')}>{card.title}</div>
        {hasFooter && (
          <div className="flex min-h-[18px] min-w-0 items-center gap-2.5">
            {facePayoff && <PayoffLabel card={card} face className={shelved ? 'opacity-80' : undefined} />}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {comments > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[11px] text-zinc-400 tabular-nums" title={`${comments} comment${comments === 1 ? '' : 's'}`}>
                  <MessageSquareText className="size-3" aria-hidden />{comments}
                </span>
              )}
              {assignee && <Avatar agent={assignee} />}
            </span>
          </div>
        )}
        <QuickActions card={card} act={act} />
      </div>
    </Peek>
  )
}
