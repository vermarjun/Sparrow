import { type MouseEvent, type ReactNode } from 'react'
import { ArrowUpFromLine, Check, MessageSquareText, Moon, X } from 'lucide-react'
import type { Agent, Card } from '@shared/types'
import { cardKey, cardTimings, isQuickWin } from '@shared/cards'
import { ago, fullDate } from '@/lib/format'
import { isShelved } from '@/lib/boardFilter'
import { commentCount } from '@/lib/activity'
import { originLabel } from '@/lib/timingView'
import { previewOf, whoName } from '@/lib/cardText'
import type { Density } from '@/lib/boardPrefs'
import { cn } from '@/lib/utils'
import { Assignee, BlockedFlag, CategoryChip, ChecksProgress, DoneMark, Estimate, LaterFlag, Meter, QuickWinFlag, TagChip, Tip, UrgentFlag } from './markers'

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
    <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-px rounded-md bg-white/95 p-0.5 opacity-0 shadow-sm ring-1 ring-zinc-200 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100" data-quick-actions>
      {card.state === 'proposed' && <HoverButton label="Accept to To do" tone="good" onClick={() => act.accept(card)}><Check /></HoverButton>}
      {canShelve && (shelved
        ? <HoverButton label="Bring back from Later" onClick={() => act.bringBack(card)}><ArrowUpFromLine /></HoverButton>
        : <HoverButton label="Move to Later" onClick={() => act.later(card)}><Moon /></HoverButton>)}
      {card.state === 'proposed' && <HoverButton label="Drop" tone="bad" onClick={() => act.drop(card)}><X /></HoverButton>}
    </div>
  )
}

export function CardFace({ card, agents, density, now, act, onOpen }: {
  card: Card; agents: Record<string, Agent>; density: Density; now: number; act: FaceActions; onOpen: () => void
}) {
  const assignee = card.assignee_id ? agents[card.assignee_id] : null
  const shelved = isShelved(card)
  const done = card.state === 'done'
  const dropped = card.state === 'dropped'
  const comments = commentCount(card)
  const quick = isQuickWin(card) && !done && !dropped
  const detailed = density === 'detailed'
  const preview = detailed ? previewOf(card) : ''
  const stamp = done ? (cardTimings(card, now).done_at ?? card.updated_at) : card.created_at
  const who = whoName(agents)
  const tip = done
    ? `Done ${fullDate(stamp)}`
    : `${originLabel(card)} ${fullDate(card.created_at)} by ${who(card.created_by)}`
  const hasMarkers = (card.urgent && !done) || quick || !!card.impact || !!card.effort || comments > 0 || !!assignee || (detailed && (!!card.estimate_min || card.checks?.length > 0))
  const accent = card.urgent && !done ? 'bg-red-500' : card.blocked_on && !done ? 'bg-orange-500' : done ? 'bg-emerald-400' : null

  return (
    <div
      onClick={onOpen}
      data-card-id={card.id}
      data-key={cardKey(card)}
      data-urgent={card.urgent || undefined}
      data-blocked={card.blocked_on ? '' : undefined}
      data-later={shelved || undefined}
      className={cn('relative flex min-w-0 cursor-pointer flex-col gap-1.5 py-2 pr-2.5 pl-3', shelved && 'text-slate-500', dropped && 'opacity-70')}
    >
      {accent && <span className={cn('absolute inset-y-0 left-0 w-[3px]', accent)} aria-hidden />}
      <div className="flex min-w-0 items-center gap-1.5">
        {done && <DoneMark className="-ml-0.5" />}
        <span className="font-mono text-[11px] tracking-tight text-zinc-400 tabular-nums">{cardKey(card)}</span>
        {card.category && <CategoryChip name={card.category} className={shelved ? 'opacity-70' : undefined} />}
        {shelved && <LaterFlag />}
        <Tip label={tip}>
          <span className="ml-auto shrink-0 text-[11px] text-zinc-400 tabular-nums">{done ? `done ${ago(stamp, now)}` : ago(card.created_at, now)}</span>
        </Tip>
      </div>
      <div className={cn('line-clamp-2 text-[13px] leading-snug font-medium text-zinc-900', shelved && 'text-slate-600', done && 'text-zinc-700')}>{card.title}</div>
      {preview && <div className="truncate text-[11.5px] text-zinc-500">{preview}</div>}
      {card.blocked_on && !done && <BlockedFlag on={card.blocked_on} className="w-full" />}
      {hasMarkers && <div className="flex min-h-4 flex-wrap items-center gap-x-2.5 gap-y-1">
        {card.urgent && !done && <UrgentFlag />}
        {quick && <QuickWinFlag short={!detailed} />}
        <Meter kind="return" level={card.impact} />
        <Meter kind="effort" level={card.effort} />
        {detailed && <Estimate min={card.estimate_min} />}
        {detailed && <ChecksProgress checks={card.checks} />}
        <span className="ml-auto flex items-center gap-2">
          {comments > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-zinc-400 tabular-nums" title={`${comments} comment${comments === 1 ? '' : 's'}`}>
              <MessageSquareText className="size-3" />{comments}
            </span>
          )}
          <Assignee agent={assignee} />
        </span>
      </div>}
      {detailed && card.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1">{card.tags.slice(0, 4).map((t) => <TagChip key={t} name={t} />)}{card.tags.length > 4 && <span className="text-[10.5px] text-zinc-400">+{card.tags.length - 4}</span>}</div>
      )}
      <QuickActions card={card} act={act} />
    </div>
  )
}
