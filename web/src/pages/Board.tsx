import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, MessageSquareText, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { Agent, Card, CardState } from '@shared/types'
import { type DragEndEvent, KanbanBoard, KanbanCard, KanbanCards, KanbanHeader, KanbanProvider } from '@/components/kibo-ui/kanban'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api } from '@/lib/api'
import { ago, clock, moveFor, sortCards } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { StateDot, useNow } from '@/components/sparrow/bits'
import { Markdown } from '@/components/sparrow/Markdown'

type Col = { id: CardState; name: string; tint: string }
const COLUMNS: Col[] = [
  { id: 'proposed', name: 'Proposed', tint: 'bg-violet-400' },
  { id: 'todo', name: 'To do', tint: 'bg-zinc-400' },
  { id: 'in_progress', name: 'In progress', tint: 'bg-sky-500' },
  { id: 'review', name: 'Review', tint: 'bg-amber-400' },
  { id: 'done', name: 'Done', tint: 'bg-emerald-500' },
  { id: 'dropped', name: 'Dropped', tint: 'bg-zinc-300' },
]

const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-zinc-200/70 px-1 font-mono text-[10.5px] text-zinc-500">{children}</code>
const COLUMN_HINT: Partial<Record<CardState, React.ReactNode>> = {
  proposed: <>Agents propose cards with <C>sparrow propose</C>.</>,
  todo: <>The captain adds cards with <C>sparrow card add</C>, or use New card.</>,
  in_progress: <>Hiring with <C>--card N</C> moves a card here.</>,
  review: 'Agents move their card here when done.',
  done: <>Captains close cards with <C>sparrow card move N done</C>.</>,
}

type Item = { id: string; name: string; column: string; cardId: number }


export function BoardPage() {
  const cards = useStore((s) => s.cards)
  const agents = useStore((s) => s.agents)
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [showDropped, setShowDropped] = useState(false)
  const snapshot = useRef<Record<number, Card>>({})

  const sorted = useMemo(() => sortCards(Object.values(cards)), [cards])

  // Sync from the store unless a drag is in flight (SSE updates must not fight the drag).
  useEffect(() => {
    if (dragging) return
    setItems(sorted.map((c) => ({ id: String(c.id), name: c.title, column: c.state, cardId: c.id })))
  }, [sorted, dragging])

  const columns = showDropped ? COLUMNS : COLUMNS.filter((c) => c.id !== 'dropped')

  const onDragEnd = async (event: DragEndEvent, final: Item[]) => {
    setDragging(false)
    const activeId = Number(event.active.id)
    const before = snapshot.current[activeId]
    const moved = final.find((i) => i.cardId === activeId)
    if (!before || !moved) return
    const toState = moved.column as CardState
    const columnIds = final.filter((i) => i.column === toState).map((i) => i.cardId)
    const positions = new Map(Object.values(snapshot.current).map((c) => [c.id, c.position]))
    const originalOrder = sortCards(Object.values(snapshot.current).filter((c) => c.state === toState)).map((c) => c.id)
    const patch = moveFor(before, toState, columnIds, positions, originalOrder)
    if (!patch) return
    // Optimistic update, then exactly one PATCH.
    const optimistic: Card = { ...before, state: patch.state ?? before.state, position: patch.position, updated_at: Date.now() }
    useStore.setState((s) => ({ cards: { ...s.cards, [before.id]: optimistic } }))
    try {
      const { card } = await api.patchCard(before.id, patch)
      useStore.setState((s) => ({ cards: { ...s.cards, [card.id]: card } }))
    } catch (e) {
      useStore.setState((s) => ({ cards: { ...s.cards, [before.id]: before } }))
      toast.error(`Could not move #${before.id}: ${(e as Error).message}`)
    }
  }

  const total = sorted.length
  const dropped = sorted.filter((c) => c.state === 'dropped').length

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 px-4">
        <h1 className="text-sm font-semibold">Board</h1>
        <span className="text-xs text-muted-foreground">
          {total} cards · tracking only — moving a card never starts or messages an agent
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowDropped((v) => !v)}>
            {showDropped ? <ChevronRight /> : <ChevronLeft />}
            Dropped {dropped ? `(${dropped})` : ''}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New card
          </Button>
        </div>
      </div>

      {total === 0 && (
        <div className="mx-4 mb-3 rounded-lg border border-dashed bg-background px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">No cards yet.</span> Agents propose cards with{' '}
          <code className="rounded bg-muted px-1">sparrow propose "…"</code>; the captain moves them with{' '}
          <code className="rounded bg-muted px-1">sparrow card move N state</code> or by dragging here. The board only tracks work.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-x-auto px-4 pb-4">
        <KanbanProvider<Item, Col>
          columns={columns}
          data={items}
          onDataChange={setItems}
          onDragStart={() => {
            snapshot.current = { ...useStore.getState().cards }
            setDragging(true)
          }}
          onDragCancel={() => setDragging(false)}
          onDragEnd={onDragEnd}
          className={cn('h-full min-w-[1100px] gap-3', showDropped ? 'grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,0.8fr)]' : 'grid-cols-5')}
        >
          {(column) => {
            const count = items.filter((i) => i.column === column.id).length
            return (
              <KanbanBoard key={column.id} id={column.id} className="min-h-0 divide-y-0 rounded-xl border-zinc-200/80 bg-zinc-100/70 shadow-none">
                <KanbanHeader data-column={column.id} className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-xs font-semibold tracking-wide text-zinc-600 uppercase">
                  <span className={cn('size-2 rounded-full', column.tint)} />
                  {column.name}
                  <span className="ml-auto font-normal text-zinc-400 tabular-nums">{count}</span>
                </KanbanHeader>
                <div className="min-h-0 flex-1 overflow-y-auto [&_[data-slot=scroll-area]]:overflow-visible">
                  <KanbanCards<Item> id={column.id} className="min-h-24 gap-2 px-2 pt-0.5 pb-2">
                    {(item) => {
                      const card = cards[item.cardId]
                      if (!card) return null
                      return (
                        <KanbanCard<Item> key={item.id} {...item} className="gap-0 rounded-lg border-zinc-200 p-0 shadow-xs ring-0 hover:border-zinc-300">
                          <CardFace card={card} agents={agents} onOpen={() => setOpen(card.id)} />
                        </KanbanCard>
                      )
                    }}
                  </KanbanCards>
                  {count === 0 && COLUMN_HINT[column.id as CardState] && (
                    <p className="px-4 pb-4 text-center text-[11px] leading-relaxed text-zinc-400">{COLUMN_HINT[column.id as CardState]}</p>
                  )}
                </div>
              </KanbanBoard>
            )
          }}
        </KanbanProvider>
      </div>

      <CardSheet cardId={open} onClose={() => setOpen(null)} />
      <NewCardDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function CardFace({ card, agents, onOpen }: { card: Card; agents: Record<string, Agent>; onOpen: () => void }) {
  const assignee = card.assignee_id ? agents[card.assignee_id] : null
  return (
    <div role="button" tabIndex={-1} onClick={onOpen} className="flex cursor-pointer flex-col gap-1.5 px-3 py-2.5" data-card-id={card.id}>
      <div className="text-[13px] leading-snug font-medium">
        <span className="mr-1 font-normal text-zinc-400 tabular-nums">#{card.id}</span>
        {card.title}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
        {card.category && <span className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-px text-zinc-600">{card.category}</span>}
        {assignee && (
          <span className="inline-flex items-center gap-1 font-medium text-zinc-700">
            <StateDot state={assignee.kind === 'human' ? 'human' : assignee.state} />@{assignee.handle}
          </span>
        )}
        {card.notes.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-0.5 text-zinc-400" title={`${card.notes.length} notes`}>
            <MessageSquareText className="size-3" />
            {card.notes.length}
          </span>
        )}
      </div>
    </div>
  )
}

const STATE_LABEL: Record<CardState, string> = {
  proposed: 'Proposed', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done', dropped: 'Dropped',
}

function CardSheet({ cardId, onClose }: { cardId: number | null; onClose: () => void }) {
  const card = useStore((s) => (cardId != null ? s.cards[cardId] : undefined))
  const agents = useStore((s) => s.agents)
  const now = useNow()
  const who = (id: string) => (id === 'user' ? 'you (web)' : id === 'system' ? 'system' : agents[id] ? `@${agents[id].handle}` : id)
  const assignee = card?.assignee_id ? agents[card.assignee_id] : null
  return (
    <Sheet open={cardId != null && !!card} onOpenChange={(o) => !o && onClose()}>
      <SheetContent onOpenAutoFocus={(e) => e.preventDefault()} className="gap-0 p-0 data-[side=right]:w-[min(540px,92vw)] data-[side=right]:sm:max-w-[540px]">
        {card && (
          <>
            <SheetHeader className="border-b px-5 pt-5 pb-4">
              <SheetDescription className="text-xs tabular-nums">#{card.id} · {STATE_LABEL[card.state]}</SheetDescription>
              <SheetTitle className="pr-6 text-base leading-snug">{card.title}</SheetTitle>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                {card.category && <span>category <span className="text-foreground">{card.category}</span></span>}
                <span>
                  assignee{' '}
                  {assignee ? (
                    <span className="inline-flex items-center gap-1 text-foreground"><StateDot state={assignee.kind === 'human' ? 'human' : assignee.state} />@{assignee.handle}</span>
                  ) : <span className="text-foreground">none</span>}
                </span>
                <span>by <span className="text-foreground">{who(card.created_by)}</span></span>
                <span>updated <span className="text-foreground">{ago(card.updated_at, now)}</span></span>
              </div>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-5 px-5 py-4">
                <section>
                  <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Details</h3>
                  {card.details.trim() ? <Markdown text={card.details} /> : <p className="text-sm text-muted-foreground">No details.</p>}
                </section>
                <section>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Notes · {card.notes.length}</h3>
                  {card.notes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No notes yet. Agents add them with <code className="rounded bg-muted px-1 text-xs">sparrow update --card {card.id}</code>.</p>
                  ) : (
                    <ol className="relative space-y-3 border-l border-zinc-200 pl-4">
                      {card.notes.map((n, i) => (
                        <li key={i} className="relative">
                          <span className="absolute top-1 -left-[21px] size-2.5 rounded-full bg-zinc-300 ring-2 ring-background" />
                          <div className="text-[11px] text-muted-foreground"><span className="font-medium text-foreground/80">{who(n.by)}</span> · {clock(n.at, now)}</div>
                          <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{n.text}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function NewCardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const project = useStore((s) => s.project)
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!project || !title.trim()) return
    setBusy(true)
    try {
      const { card } = await api.createCard(project, {
        title: title.trim(), details: details.trim() || undefined, category: category.trim() || undefined, state: 'todo',
      })
      useStore.setState((s) => ({ cards: { ...s.cards, [card.id]: card } }))
      setTitle(''); setDetails(''); setCategory('')
      onOpenChange(false)
    } catch (err) {
      toast.error(`Could not create card: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New card</DialogTitle>
            <DialogDescription>Adds a card to To do. It does not start or message any agent.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-title">Title</Label>
            <Input id="nc-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Retry ring when the tower reconnects" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-details">Details</Label>
            <Textarea id="nc-details" rows={4} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Acceptance, links, notes (markdown)" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-cat">Category <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="nc-cat" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="ui, server, docs…" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()}>Add card</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
