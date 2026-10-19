// The property sentence: `High return · Low effort → Quick win · ~30m · security · @james · proposed by @captain 5d ago · tags`.
// Every token is click-to-edit (a popover); an unset one is a quiet "+ return". Urgent and Later are words here only when set.
import { type ReactElement, type ReactNode } from 'react'
import { Flame, Moon } from 'lucide-react'
import type { Card } from '@shared/types'
import { formatEstimate } from '@shared/cards'
import { Avatar, CategoryLabel, PayoffLabel, Tip } from '@/components/board/markers'
import { patchCard } from '@/lib/cardActions'
import { whoName } from '@/lib/cardText'
import { agoLabel, fullDate } from '@/lib/format'
import { payoffOf } from '@/lib/faceA'
import { originLabel } from '@/lib/timingView'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { AssigneePopover, CategoryPopover, EstimatePopover, focusRing, LevelPopover, TagsPopover } from './pickers'

const token = cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13.5px] whitespace-nowrap transition-colors hover:bg-foreground/[0.06] data-[state=open]:bg-foreground/[0.06]', focusRing)
const unset = 'text-muted-foreground/70 hover:text-muted-foreground'

export function PropertySentence({ card, now, categories }: { card: Card; now: number; categories?: string[] }) {
  const cards = useStore((s) => s.cards)
  const agents = useStore((s) => s.agents)
  const who = whoName(agents)
  const assignee = card.assignee_id ? agents[card.assignee_id] : undefined
  const author = card.created_by === 'user' ? 'you' : who(card.created_by)
  const payoff = payoffOf(card)
  const level = (v: Card['impact'], noun: string) => (v ? `${v[0].toUpperCase()}${v.slice(1)} ${noun}` : `+ ${noun}`)
  const live = card.state !== 'done' && card.state !== 'dropped'

  const parts: { key: string; lead?: 'arrow'; node: ReactNode }[] = []
  if (card.urgent && live) {
    parts.push({ key: 'urgent', node: (
      <Tip label="Urgent: someone is waiting on this. Click to clear">
        <button type="button" data-prop="urgent" onClick={() => void patchCard(card.id, { urgent: false })} className={cn(token, 'gap-0.5 font-semibold text-red-600 dark:text-red-300 hover:text-red-700')}><Flame className="size-3.5" aria-hidden />Urgent</button>
      </Tip>
    ) })
  }
  if (card.later_at) {
    parts.push({ key: 'later', node: <span data-prop="later" className="inline-flex items-center gap-1 px-1.5 text-[13.5px] text-muted-foreground"><Moon className="size-3.5" aria-hidden />Later</span> })
  }
  parts.push({ key: 'return', node: (
    <LevelPopover label="Return" value={card.impact} onChange={(impact) => void patchCard(card.id, { impact })}>
      <button type="button" data-prop="return" aria-label="Return" className={cn(token, card.impact ? 'text-foreground/80' : unset)}>{level(card.impact, 'return')}</button>
    </LevelPopover>
  ) })
  parts.push({ key: 'effort', node: (
    <LevelPopover label="Effort" value={card.effort} onChange={(effort) => void patchCard(card.id, { effort })}>
      <button type="button" data-prop="effort" aria-label="Effort" className={cn(token, card.effort ? 'text-foreground/80' : unset)}>{level(card.effort, 'effort')}</button>
    </LevelPopover>
  ) })
  if (payoff) parts.push({ key: 'payoff', lead: 'arrow', node: <span className="px-1.5"><PayoffLabel card={card} className="text-[13.5px]" /></span> })
  parts.push({ key: 'estimate', node: (
    <EstimatePopover minutes={card.estimate_min} onSave={(estimate_min) => void patchCard(card.id, { estimate_min })}>
      <button type="button" data-prop="estimate" aria-label="Estimate" className={cn(token, 'tabular-nums', card.estimate_min ? 'text-foreground/80' : unset)}>{card.estimate_min ? `~${formatEstimate(card.estimate_min)}` : '+ estimate'}</button>
    </EstimatePopover>
  ) })
  parts.push({ key: 'category', node: (
    <CategoryPopover category={card.category} cards={Object.values(cards)} projectId={card.project_id} known={categories} onSave={(category) => void patchCard(card.id, { category })}>
      <button type="button" data-prop="category" aria-label="Category" className={cn(token, !card.category && unset)}>
        {card.category ? <CategoryLabel name={card.category} className="text-[13.5px] text-foreground/80" /> : '+ category'}
      </button>
    </CategoryPopover>
  ) })
  parts.push({ key: 'assignee', node: (
    <AssigneePopover assigneeId={card.assignee_id} agents={agents} onSave={(assignee) => void patchCard(card.id, { assignee })}>
      <button type="button" data-prop="assignee" aria-label="Assignee" className={cn(token, 'gap-1.5', !assignee && unset)}>
        {assignee ? <><Avatar agent={assignee} /><span className="text-foreground/80">@{assignee.handle}</span></> : 'Unassigned'}
      </button>
    </AssigneePopover>
  ) })
  const meta: typeof parts = []
  meta.push({ key: 'origin', node: (
    <Tip label={<span className="tabular-nums">{fullDate(card.created_at)} · updated {agoLabel(card.updated_at, now)}</span>}>
      <span data-prop="origin" className="px-1.5 text-[13px] text-muted-foreground/70">{originLabel(card).toLowerCase()} by {author} {agoLabel(card.created_at, now)}</span>
    </Tip>
  ) })
  meta.push({ key: 'tags', node: (
    <TagsPopover tags={card.tags} onSave={(tags) => void patchCard(card.id, { tags })}>
      <button type="button" data-prop="tags" aria-label="Tags" className={cn(token, 'gap-1.5 text-[13px]', card.tags.length ? 'text-muted-foreground/70' : unset)}>
        {card.tags.length ? card.tags.map((t) => <span key={t}>#{t}</span>) : '+ tags'}
      </button>
    </TagsPopover>
  ) })

  return (
    <div className="-mx-1.5 space-y-0.5" data-properties>
      <Line parts={parts} />
      <Line parts={meta} />
    </div>
  )
}

/** One run of tokens joined by quiet dots (the arrow before the payoff word). */
function Line({ parts }: { parts: { key: string; lead?: 'arrow'; node: ReactNode }[] }) {
  return (
    <div className="flex flex-wrap items-center">
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex items-center">
          {i > 0 && <Sep arrow={p.lead === 'arrow'} />}
          {p.node as ReactElement}
        </span>
      ))}
    </div>
  )
}

function Sep({ arrow }: { arrow?: boolean }) {
  return <span className={cn('select-none', arrow ? 'px-0.5 text-muted-foreground/70' : 'px-px text-muted-foreground/45')} aria-hidden>{arrow ? '→' : '·'}</span>
}
