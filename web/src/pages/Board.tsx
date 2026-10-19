import { useEffect, useMemo, useRef, useState } from 'react'
import { isQuickWin } from '@shared/cards'
import { Toolbar } from '@/components/board/Toolbar'
import { BoardColumns } from '@/components/board/BoardColumns'
import { ListView } from '@/components/board/ListView'
import { NewTicketDialog } from '@/components/board/NewTicketDialog'
import { ShortcutSheet } from '@/components/board/ShortcutSheet'
import { TicketSheet } from '@/components/board/TicketSheet'
import { TriageView } from '@/components/board/TriageView'
import { useBoardPrefs } from '@/components/board/usePrefs'
import type { FaceActions } from '@/components/board/CardFace'
import { useNow } from '@/components/sparrow/bits'
import { categoriesOf, filterCards, fleetResolver, groupColumns, hasFilters, isLive, isShelved, summaryCounts } from '@/lib/boardFilter'
import { capDone } from '@/lib/boardView'
import { compareCaptains } from '@/lib/captains'
import { COLUMNS } from '@/lib/boardStyle'
import { quickMove, setLater } from '@/lib/cardActions'
import { patchWithUndo } from '@/lib/keyActions'
import { boardOrder, focusAfterRemoval, stepFocus, triageAction } from '@/lib/triage'
import { useStore } from '@/lib/store'

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
}

export function BoardPage() {
  const project = useStore((s) => s.project)
  const cards = useStore((s) => s.cards)
  const agents = useStore((s) => s.agents)
  const captains = useStore((s) => s.captains)
  const now = useNow(60_000)
  const [prefs, update] = useBoardPrefs(project)
  const [open, setOpen] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [help, setHelp] = useState(false)
  const [triage, setTriage] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [focusId, setFocusId] = useState<number | null>(null)

  const all = useMemo(() => Object.values(cards), [cards])
  const scope = useMemo(() => (prefs.showDropped ? all : all.filter((c) => c.state !== 'dropped')), [all, prefs.showDropped])
  const fleetOf = useMemo(() => fleetResolver(agents), [agents])
  const filtered = useMemo(() => filterCards(scope, prefs.filters, fleetOf), [scope, prefs.filters, fleetOf])
  const groups = useMemo(() => groupColumns(filtered, prefs.sort), [filtered, prefs.sort])
  const summary = useMemo(() => summaryCounts(scope, prefs.filters, fleetOf), [scope, prefs.filters, fleetOf])
  const quickCount = useMemo(() => scope.filter((c) => isLive(c) && isQuickWin(c)).length, [scope])
  const categories = useMemo(() => categoriesOf(all), [all])
  const agentList = useMemo(() => Object.values(agents).filter((a) => a.state !== 'retired'), [agents])
  const sortedCaptains = useMemo(() => [...captains].sort(compareCaptains), [captains])
  const droppedCount = useMemo(() => all.filter((c) => c.state === 'dropped').length, [all])
  const columns = prefs.showDropped ? COLUMNS : COLUMNS.filter((c) => c.id !== 'dropped')

  // `/` focuses search, `n` opens the new-ticket dialog, `t` Triage mode, `?` the shortcut sheet (not while typing or while a sheet / dialog
  // is open). Triage mode owns its keys: only `?` stays on there.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('[role=dialog]')) return
      if (e.key === '?') { e.preventDefault(); setHelp(true); return }
      if (triage) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'n') { e.preventDefault(); setCreating(true) }
      else if (e.key === 't') { e.preventDefault(); setTriage(true) }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [triage])

  const act: FaceActions = {
    accept: (c) => void quickMove(c, 'todo', 'accepted to To do'),
    later: (c) => void setLater(c, true),
    bringBack: (c) => void setLater(c, false),
    drop: (c) => void quickMove(c, 'dropped', 'dropped'),
  }

  // Keyboard triage (board view): j/k move a focus ring through the cards in board order, a/l/d/u/1-3 act on the focused card.
  // The listener is registered once and reads the latest state through a ref.
  // j/k skip the Done cards the column folds behind "N older".
  const order = useMemo(() => boardOrder(capDone(groups, now).groups, columns, prefs.laterOpen), [groups, columns, prefs.laterOpen, now])
  const live = useRef({ order, board: prefs.view === 'board' && !triage, focusId, act, open })
  useEffect(() => { live.current = { order, board: prefs.view === 'board' && !triage, focusId, act, open } })
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const { order, board, focusId, act, open } = live.current
      if (!board || open !== null || e.defaultPrevented || typing(e.target) || document.querySelector('[role=dialog]')) return
      if (t?.closest('[role=listbox],[role=menu],[aria-pressed=true][data-kanban-item]')) return // an open menu, or a keyboard drag in flight
      if (e.key === 'Enter' && t?.closest('button,a,[data-kanban-item]')) return // those handle Enter themselves
      const card = order.find((c) => c.id === focusId) ?? null
      const a = triageAction(e, card)
      if (!a || (a.kind === 'clear' && focusId === null)) return
      e.preventDefault()
      const advance = () => card && setFocusId(focusAfterRemoval(order, card.id))
      switch (a.kind) {
        case 'step': setFocusId(stepFocus(order, focusId, a.dir)); break
        case 'clear': setFocusId(null); break
        case 'open': if (card) setOpen(card.id); break
        case 'accept': if (card) { act.accept(card); advance() } break
        case 'later': if (card) { if (isShelved(card)) act.bringBack(card); else act.later(card); advance() } break
        case 'drop': if (card) { act.drop(card); advance() } break
        case 'patch': if (card) void patchWithUndo(card, a.body); break
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const showOlderDone = () => update((p) => ({ ...p, view: 'list', filters: { ...p.filters, state: 'done' } }))

  if (triage) {
    return (
      <div className="flex h-full flex-col">
        <TriageView cards={all} agents={agents} onExit={() => setTriage(false)} />
        <ShortcutSheet open={help} onOpenChange={setHelp} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        prefs={prefs}
        update={update}
        categories={categories}
        agents={agentList}
        captains={sortedCaptains}
        summary={summary}
        quickCount={quickCount}
        droppedCount={droppedCount}
        searchRef={searchRef}
        onNew={() => setCreating(true)}
      />

      {all.length === 0 && (
        <div className="mx-4 mb-3 rounded-lg border border-dashed bg-background px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">No tickets yet.</span> Agents propose tickets with{' '}
          <code className="rounded bg-muted px-1">sparrow propose "…"</code>; the captain moves them with{' '}
          <code className="rounded bg-muted px-1">sparrow card move PLU-1 todo</code> or you drag them here. The board only tracks work.
        </div>
      )}

      {prefs.view === 'board' ? (
        <div className="min-h-0 flex-1 overflow-x-auto px-4 pb-4">
          <BoardColumns
            groups={groups}
            columns={columns}
            prefs={prefs}
            sort={prefs.sort}
            agents={agents}
            now={now}
            act={act}
            onOpen={(id) => { setOpen(id); setFocusId(id) }}
            focusId={focusId}
            onTriage={() => setTriage(true)}
            onShowOlderDone={showOlderDone}
            onLaterToggle={(s) => update((p) => ({ ...p, laterOpen: { ...p.laterOpen, [s]: !p.laterOpen[s] } }))}
            emptyText={hasFilters(prefs.filters) ? 'No tickets match the filters.' : null}
          />
        </div>
      ) : (
        <ListView
          cards={filtered}
          onOpen={setOpen}
          sortKey={prefs.list.key}
          sortDir={prefs.list.dir}
          onSort={(k) => update((p) => ({ ...p, list: { key: k, dir: p.list.key === k ? (p.list.dir === 'asc' ? 'desc' : 'asc') : k === 'payoff' ? 'desc' : 'asc' } }))}
        />
      )}

      <TicketSheet cardId={open} onClose={() => setOpen(null)} categories={categories} />
      <NewTicketDialog open={creating} onOpenChange={setCreating} />
      <ShortcutSheet open={help} onOpenChange={setHelp} />
    </div>
  )
}
