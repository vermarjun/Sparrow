import { Fragment, useEffect, useMemo, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { ChevronRight, Clock, Moon } from 'lucide-react'
import type { Agent, Card, CardState } from '@shared/types'
import { type CardSort, formatEstimate } from '@shared/cards'
import { type DragEndEvent, KanbanBoard, KanbanCard, KanbanCards, KanbanHeader, KanbanProvider } from '@/components/kibo-ui/kanban'
import { type ColumnView, LATER_STATES } from '@/lib/boardFilter'
import { type DragItem, laterZoneId, planDrop, zoneState } from '@/lib/boardDrag'
import type { BoardPrefs } from '@/lib/boardPrefs'
import { COLUMNS, type ColumnStyle } from '@/lib/boardStyle'
import { patchCard } from '@/lib/cardActions'
import { columnStats, STALE_DAYS } from '@/lib/triage'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CardFace, type FaceActions } from './CardFace'
import { Tip } from './markers'
import { Swatch } from './swatch'

type Col = ColumnStyle & Record<string, unknown>

const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-white/70 px-1 font-mono text-[10.5px] text-zinc-500">{children}</code>
const COLUMN_HINT: Partial<Record<CardState, React.ReactNode>> = {
  proposed: <>Agents propose tickets with <C>sparrow propose</C>.</>,
  todo: <>Accept a proposal, or add one with <C>sparrow card add</C>.</>,
  in_progress: <>A ticket moves here when an agent picks it up.</>,
  review: 'Agents send finished work here for your review.',
  done: 'Approved tickets land here.',
}

const plural = (n: number, word: string) => `${n} ${word}`

/** Planning numbers beside the count: urgent / blocked dots (Proposed, To do), stale proposals, and the total estimate. No words, tooltips carry them. */
function HeaderStats({ state, active, now }: { state: CardState; active: Card[]; now: number }) {
  const st = columnStats(state, active, now)
  const triage = LATER_STATES.includes(state)
  const num = 'inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums'
  return (
    <span className="ml-auto flex items-center gap-2" data-stats={state}>
      {state === 'proposed' && st.stale > 0 && (
        <Tip label={`${st.stale} proposed more than ${STALE_DAYS} days ago`}>
          <span className={cn(num, 'text-zinc-500')} data-stat="stale"><Clock className="size-3" />{st.stale}</span>
        </Tip>
      )}
      {triage && st.urgent > 0 && (
        <Tip label={plural(st.urgent, 'urgent')}>
          <span className={cn(num, 'text-red-700')} data-stat="urgent"><Swatch kind="urgent" shape="dot" />{st.urgent}</span>
        </Tip>
      )}
      {triage && st.blocked > 0 && (
        <Tip label={plural(st.blocked, 'blocked')}>
          <span className={cn(num, 'text-orange-700')} data-stat="blocked"><Swatch kind="blocked" shape="dot" />{st.blocked}</span>
        </Tip>
      )}
      {st.estimate > 0 && (
        <Tip label={`Estimated ${formatEstimate(st.estimate)} of work in this column`}>
          <span className="text-[11px] font-medium text-zinc-500/90 tabular-nums" data-stat="estimate">~{formatEstimate(st.estimate)}</span>
        </Tip>
      )}
    </span>
  )
}

/** The dashed divider that ends Proposed and To do. It is also a drop target: dropping a card on it shelves the card. */
function LaterLine({ state, count, open, dragging, onToggle }: { state: CardState; count: number; open: boolean; dragging: boolean; onToggle: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: laterZoneId(state) })
  return (
    <div ref={setNodeRef} className={cn('mx-0.5 my-1.5 rounded-md transition-colors', isOver && 'bg-slate-300/50 ring-2 ring-slate-400/60')} data-later-line={state}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid={`later-${state}`}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="h-px flex-1 border-t border-dashed border-slate-400/60" />
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Moon className="size-3" />
        {dragging && count === 0 ? 'Drop here to shelve' : `Later · ${count}`}
        <span className="h-px flex-1 border-t border-dashed border-slate-400/60" />
      </button>
    </div>
  )
}

export function BoardColumns({ groups, columns, prefs, sort, agents, now, act, onOpen, onLaterToggle, emptyText, focusId }: {
  groups: Record<CardState, ColumnView>
  columns: ColumnStyle[]
  prefs: BoardPrefs
  sort: CardSort
  agents: Record<string, Agent>
  now: number
  act: FaceActions
  onOpen: (id: number) => void
  onLaterToggle: (s: 'proposed' | 'todo') => void
  emptyText: string | null
  /** The card the keyboard focus ring is on (j/k triage). */
  focusId: number | null
}) {
  const cards = useStore((s) => s.cards)
  const [dragging, setDragging] = useState(false)
  const [items, setItems] = useState<DragItem[]>([])
  const [startItems, setStartItems] = useState<DragItem[]>([])
  const [snapshot, setSnapshot] = useState<Record<number, Card>>({})

  const derived = useMemo<DragItem[]>(() => {
    const out: DragItem[] = []
    for (const col of columns) {
      const g = groups[col.id]
      for (const c of g.active) out.push({ id: String(c.id), name: c.title, column: col.id, cardId: c.id })
      if (LATER_STATES.includes(col.id) && prefs.laterOpen[col.id as 'proposed' | 'todo']) {
        for (const c of g.later) out.push({ id: String(c.id), name: c.title, column: col.id, cardId: c.id, later: true })
      }
    }
    return out
  }, [groups, columns, prefs.laterOpen])

  // Sync from the store unless a drag is in flight (SSE updates must not fight the drag).
  useEffect(() => {
    if (!dragging) setItems(derived)
  }, [derived, dragging])

  // Keep the keyboard-focused card in view while j/k walks the board.
  useEffect(() => {
    if (focusId !== null) document.querySelector(`[data-card-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusId])

  const onDragEnd = (event: DragEndEvent, final: DragItem[]) => {
    const card = snapshot[Number(event.active.id)]
    const patch = card ? planDrop({ card, before: startItems, final, overId: event.over?.id ?? null, sort, cards: snapshot }) : null
    if (card && patch) void patchCard(card.id, patch) // optimistic update happens synchronously, before the drag state clears
    setDragging(false)
  }

  return (
    <KanbanProvider<DragItem, Col>
      columns={columns as Col[]}
      data={items}
      onDataChange={setItems}
      resolveZone={(id) => zoneState(id)}
      onDragStart={() => {
        setSnapshot({ ...useStore.getState().cards })
        setStartItems(items)
        setDragging(true)
      }}
      onDragCancel={() => setDragging(false)}
      onDragEnd={onDragEnd}
      className={cn('h-full min-w-[1100px] gap-3', columns.length > 5 ? 'grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,0.8fr)]' : 'grid-cols-5')}
    >
      {(column) => {
        const style = COLUMNS.find((c) => c.id === column.id)!
        const g = groups[column.id as CardState]
        const hasLater = LATER_STATES.includes(column.id as CardState)
        const laterOpen = hasLater && prefs.laterOpen[column.id as 'proposed' | 'todo']
        const count = g.active.length + g.later.length
        const colItems = items.filter((i) => i.column === column.id)
        const inlineLine = hasLater && laterOpen && g.later.length > 0
        return (
          <KanbanBoard key={column.id} id={column.id} className={cn('min-h-0 divide-y-0 rounded-xl shadow-none', style.edge, style.body)}>
            <KanbanHeader data-column={column.id} className={cn('flex items-center gap-2 border-b px-3 py-2 text-[12.5px] font-semibold', style.head, style.edge, style.title)}>
              <span className={cn('size-2 rounded-full', style.dot)} />
              {style.name}
              <HeaderStats state={column.id as CardState} active={g.active} now={now} />
              <span className={cn('min-w-5 rounded-full px-1.5 py-px text-center text-[11px] font-semibold tabular-nums', style.count)} data-count={column.id}>{count}</span>
            </KanbanHeader>
            <div className="min-h-0 flex-1 overflow-y-auto [&_[data-radix-scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area]]:overflow-visible">
              <KanbanCards<DragItem> id={column.id} className="min-h-16 gap-2 px-2 pt-2 pb-1">
                {(item, idx, list) => {
                  const card = cards[item.cardId]
                  if (!card) return null
                  const firstLater = inlineLine && item.later && !list[idx - 1]?.later
                  return (
                    <Fragment key={item.id}>
                      {firstLater && <LaterLine state={column.id as CardState} count={g.later.length} open dragging={dragging} onToggle={() => onLaterToggle(column.id as 'proposed' | 'todo')} />}
                      <KanbanCard<DragItem>
                        {...item}
                        onActivate={() => onOpen(card.id)}
                        className={cn('gap-0 rounded-lg border-zinc-200/90 bg-white p-0 shadow-xs ring-0 transition-shadow hover:border-zinc-300 hover:shadow-sm', item.later && 'border-dashed bg-slate-50 hover:bg-white', item.cardId === focusId && 'kb-focus ring-2 ring-indigo-500 ring-offset-1 ring-offset-white')}
                      >
                        <CardFace card={card} agents={agents} density={prefs.density} now={now} act={act} onOpen={() => onOpen(card.id)} />
                      </KanbanCard>
                    </Fragment>
                  )
                }}
              </KanbanCards>
              {hasLater && !inlineLine && (
                <div className="px-2 pb-2">
                  <LaterLine state={column.id as CardState} count={g.later.length} open={false} dragging={dragging} onToggle={() => onLaterToggle(column.id as 'proposed' | 'todo')} />
                </div>
              )}
              {colItems.length === 0 && g.later.length === 0 && (
                <p className="px-4 pt-2 pb-4 text-center text-[11px] leading-relaxed text-zinc-400">{emptyText ?? COLUMN_HINT[column.id as CardState]}</p>
              )}
            </div>
          </KanbanBoard>
        )
      }}
    </KanbanProvider>
  )
}
