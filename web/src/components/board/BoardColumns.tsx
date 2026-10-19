import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { ChevronRight, Moon } from 'lucide-react'
import type { Agent, Card, CardState } from '@shared/types'
import type { CardSort } from '@shared/cards'
import { type DragEndEvent, KanbanBoard, KanbanCard, KanbanCards, KanbanHeader, KanbanProvider } from '@/components/kibo-ui/kanban'
import { type ColumnView, LATER_STATES } from '@/lib/boardFilter'
import { type DragItem, laterZoneId, planDrop, zoneState } from '@/lib/boardDrag'
import type { BoardPrefs } from '@/lib/boardPrefs'
import { capDone, columnTip, doneInsight, oldestShelved } from '@/lib/boardView'
import { COLUMNS, type ColumnStyle } from '@/lib/boardStyle'
import { patchCard } from '@/lib/cardActions'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CardFace, type FaceActions } from './CardFace'
import { Tip } from './markers'

type Col = ColumnStyle & Record<string, unknown>

/** Calm empty-column copy: text, not a blank column. */
const EMPTY_TEXT: Record<CardState, string> = {
  proposed: "Nothing to triage. Captains' proposals land here.",
  todo: 'Nothing queued.',
  in_progress: 'Nothing in flight.',
  review: 'Nothing waiting on you.',
  done: 'Nothing finished this week.',
  dropped: 'Nothing dropped.',
}

const FLIP_MS = 180
const typingIn = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.tagName))
}

/** The dashed divider that ends Proposed and To do. It is also a drop target: dropping a card on it shelves the card. */
function LaterLine({ state, count, oldest, open, dragging, onToggle }: { state: CardState; count: number; oldest: string; open: boolean; dragging: boolean; onToggle: () => void }) {
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
        <span className="h-px flex-1 border-t border-dashed border-slate-300" />
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Moon className="size-3" />
        {dragging && count === 0 ? 'Drop here to shelve' : `Later · ${count}${oldest ? ` · ${oldest}` : ''}`}
        <span className="h-px flex-1 border-t border-dashed border-slate-300" />
      </button>
    </div>
  )
}

/** Column header count: plain number, the planning numbers live in its tooltip. On Proposed it opens Triage mode. */
function HeaderCount({ column, count, lines, onClick }: { column: CardState; count: number; lines: string[]; onClick?: () => void }) {
  const cls = 'min-w-4 text-[12px] font-medium text-zinc-400 tabular-nums outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring/50'
  const tip = <span className="flex flex-col">{lines.map((l) => <span key={l}>{l}</span>)}{onClick && <span className="mt-0.5 opacity-70">Click to triage</span>}</span>
  return (
    <Tip label={tip}>
      {onClick
        ? <button type="button" onClick={onClick} className={cn(cls, 'cursor-pointer hover:text-zinc-700')} data-count={column} data-testid="triage-count">{count}</button>
        : <span tabIndex={0} className={cls} data-count={column}>{count}</span>}
    </Tip>
  )
}

export function BoardColumns({ groups, columns, prefs, sort, agents, now, act, onOpen, onLaterToggle, emptyText, focusId, onTriage, onShowOlderDone }: {
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
  /** The Proposed count was clicked. */
  onTriage?: () => void
  /** The Done column's "N older" link. */
  onShowOlderDone?: () => void
}) {
  const cards = useStore((s) => s.cards)
  const [dragging, setDragging] = useState(false)
  const [items, setItems] = useState<DragItem[]>([])
  const [startItems, setStartItems] = useState<DragItem[]>([])
  const [snapshot, setSnapshot] = useState<Record<number, Card>>({})
  const [peekFor, setPeekFor] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const prevPos = useRef<Map<string, { x: number; cy: number }> | null>(null)

  const capped = useMemo(() => capDone(groups, now), [groups, now])
  const view = capped.groups
  const insight = useMemo(() => doneInsight(Object.values(cards), now), [cards, now])

  const derived = useMemo<DragItem[]>(() => {
    const out: DragItem[] = []
    for (const col of columns) {
      const g = view[col.id]
      for (const c of g.active) out.push({ id: String(c.id), name: c.title, column: col.id, cardId: c.id })
      if (LATER_STATES.includes(col.id) && prefs.laterOpen[col.id as 'proposed' | 'todo']) {
        for (const c of g.later) out.push({ id: String(c.id), name: c.title, column: col.id, cardId: c.id, later: true })
      }
    }
    return out
  }, [view, columns, prefs.laterOpen])

  // Sync from the store unless a drag is in flight (SSE updates must not fight the drag).
  useEffect(() => {
    if (!dragging) setItems(derived)
  }, [derived, dragging])

  // Keep the keyboard-focused card in view while j/k walks the board.
  useEffect(() => {
    if (focusId !== null) document.querySelector(`[data-card-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusId])

  // Space on the keyboard-focused card pins its peek (capture phase, so the drag sensor's Space pickup does not also fire).
  const liveFocus = useRef(focusId)
  useEffect(() => { liveFocus.current = focusId })
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const f = liveFocus.current
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || f === null) return
      const t = e.target as HTMLElement | null
      if (typingIn(t) || t?.closest('[aria-pressed=true][data-kanban-item]') || document.querySelector('[role=dialog]')) return
      e.preventDefault()
      e.stopPropagation()
      setPeekFor((p) => (p === f ? null : f))
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])
  const pinnedId = peekFor !== null && peekFor === focusId ? peekFor : null

  // FLIP: a card that changed place (it moved column, or the cards above it left) glides from where it was; a card that
  // appears fades in. Skipped during a drag (dnd-kit animates that) and for reduced motion.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (dragging) { prevPos.current = null; return }
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const prev = prevPos.current
    const next = new Map<string, { x: number; cy: number }>()
    root.querySelectorAll<HTMLElement>('[data-kanban-item]').forEach((el) => {
      const scroller = el.closest<HTMLElement>('[data-col-scroll]')
      if (!scroller) return
      const id = el.dataset.kanbanItem!
      // Layout position: the rect minus whatever transform a running glide has applied, so a re-render mid-glide sees no move.
      const m = new DOMMatrix(getComputedStyle(el).transform)
      const r = el.getBoundingClientRect()
      const top = scroller.getBoundingClientRect().top
      const x = r.left - m.e
      const y = r.top - m.f
      next.set(id, { x, cy: y - top + scroller.scrollTop })
      const old = prev?.get(id)
      if (reduce || !prev) return
      if (old) {
        const dx = old.x - x
        const dy = old.cy + top - scroller.scrollTop - y
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          el.getAnimations().forEach((a) => a.cancel())
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: FLIP_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
        }
      } else {
        el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 150, easing: 'ease-out' })
      }
    })
    prevPos.current = next
  })

  const onDragEnd = (event: DragEndEvent, final: DragItem[]) => {
    const card = snapshot[Number(event.active.id)]
    const patch = card ? planDrop({ card, before: startItems, final, overId: event.over?.id ?? null, sort, cards: snapshot }) : null
    if (card && patch) void patchCard(card.id, patch) // optimistic update happens synchronously, before the drag state clears
    setDragging(false)
  }

  return (
    <div ref={rootRef} className="h-full">
      <KanbanProvider<DragItem, Col>
        columns={columns as Col[]}
        data={items}
        onDataChange={setItems}
        resolveZone={(id) => zoneState(id)}
        onDragStart={() => {
          setSnapshot({ ...useStore.getState().cards })
          setStartItems(items)
          setDragging(true)
          setPeekFor(null)
        }}
        onDragCancel={() => setDragging(false)}
        onDragEnd={onDragEnd}
        className={cn('h-full min-w-[1100px] gap-3', columns.length > 5 ? 'grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,0.8fr)]' : 'grid-cols-5')}
      >
        {(column) => {
          const state = column.id as CardState
          const style = COLUMNS.find((c) => c.id === column.id)!
          const g = view[state]
          const hasLater = LATER_STATES.includes(state)
          const laterOpen = hasLater && prefs.laterOpen[state as 'proposed' | 'todo']
          const total = groups[state]
          const colItems = items.filter((i) => i.column === column.id)
          const inlineLine = hasLater && laterOpen && g.later.length > 0
          const older = state === 'done' ? capped.older : 0
          const tip = columnTip(state, total.active, total.later, now, insight)
          return (
            <KanbanBoard key={column.id} id={column.id} className={cn('relative min-h-0 divide-y-0 rounded-xl shadow-none', style.edge, style.body)}>
              <span aria-hidden className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5', style.line)} data-column-line={column.id} />
              <KanbanHeader data-column={column.id} className={cn('flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-[13px] font-semibold', style.title)}>
                <span className={cn('size-2 rounded-full', style.dot)} />
                {style.name}
                <HeaderCount column={state} count={total.active.length + total.later.length} lines={tip} onClick={state === 'proposed' ? onTriage : undefined} />
              </KanbanHeader>
              <div data-col-scroll className="min-h-0 flex-1 overflow-y-auto [&_[data-radix-scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area]]:overflow-visible">
                <KanbanCards<DragItem> id={column.id} className="min-h-16 gap-2.5 px-2.5 pt-1.5 pb-1.5">
                  {(item, idx, list) => {
                    const card = cards[item.cardId]
                    if (!card) return null
                    const firstLater = inlineLine && item.later && !list[idx - 1]?.later
                    return (
                      <Fragment key={item.id}>
                        {firstLater && <LaterLine state={state} count={g.later.length} oldest={oldestShelved(g.later, now)} open dragging={dragging} onToggle={() => onLaterToggle(state as 'proposed' | 'todo')} />}
                        <KanbanCard<DragItem>
                          {...item}
                          onActivate={() => onOpen(card.id)}
                          overlayClassName="scale-[1.02] rotate-[0.6deg] border-zinc-300 shadow-xl"
                          className={cn('gap-0 rounded-lg border border-zinc-200 bg-white p-0 shadow-none ring-0 transition-colors hover:border-zinc-300', item.later && 'border-dashed bg-zinc-50 hover:bg-white', item.cardId === focusId && 'kb-focus ring-2 ring-indigo-500 ring-offset-1 ring-offset-white')}
                        >
                          <CardFace card={card} agents={agents} now={now} act={act} onOpen={() => onOpen(card.id)} peekPinned={pinnedId === card.id} onPeekClose={() => setPeekFor(null)} peekDisabled={dragging} />
                        </KanbanCard>
                      </Fragment>
                    )
                  }}
                </KanbanCards>
                {colItems.length === 0 && g.later.length === 0 && (
                  <p className="px-4 pt-2 pb-4 text-center text-[12px] leading-relaxed text-zinc-400" data-empty={column.id}>{emptyText ?? EMPTY_TEXT[state]}</p>
                )}
                {hasLater && !inlineLine && (
                  <div className="px-2 pb-2">
                    <LaterLine state={state} count={g.later.length} oldest={oldestShelved(g.later, now)} open={false} dragging={dragging} onToggle={() => onLaterToggle(state as 'proposed' | 'todo')} />
                  </div>
                )}
                {older > 0 && (
                  <button
                    type="button"
                    onClick={onShowOlderDone}
                    data-testid="done-older"
                    className="mx-auto mt-1 mb-2.5 flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {older} older<ChevronRight className="size-3" />
                  </button>
                )}
              </div>
            </KanbanBoard>
          )
        }}
      </KanbanProvider>
    </div>
  )
}
