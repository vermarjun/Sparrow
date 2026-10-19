import { useEffect, useMemo, useRef, useState } from 'react'
import { isQuickWin } from '@shared/cards'
import { Toolbar, BoardHeader } from '@/components/board/Toolbar'
import { BoardColumns } from '@/components/board/BoardColumns'
import { ListView } from '@/components/board/ListView'
import { NewTicketDialog } from '@/components/board/NewTicketDialog'
import { TicketSheet } from '@/components/board/TicketSheet'
import { useBoardPrefs } from '@/components/board/usePrefs'
import type { FaceActions } from '@/components/board/CardFace'
import { useNow } from '@/components/sparrow/bits'
import { categoriesOf, filterCards, groupColumns, hasFilters, isLive, summarize, summaryText } from '@/lib/boardFilter'
import { COLUMNS } from '@/lib/boardStyle'
import { quickMove, setLater } from '@/lib/cardActions'
import { useStore } from '@/lib/store'

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
}

export function BoardPage() {
  const project = useStore((s) => s.project)
  const cards = useStore((s) => s.cards)
  const agents = useStore((s) => s.agents)
  const now = useNow(60_000)
  const [prefs, update] = useBoardPrefs(project)
  const [open, setOpen] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const all = useMemo(() => Object.values(cards), [cards])
  const scope = useMemo(() => (prefs.showDropped ? all : all.filter((c) => c.state !== 'dropped')), [all, prefs.showDropped])
  const filtered = useMemo(() => filterCards(scope, prefs.filters), [scope, prefs.filters])
  const groups = useMemo(() => groupColumns(filtered, prefs.sort), [filtered, prefs.sort])
  const counts = useMemo(() => {
    const s = summarize(scope, scope)
    return { urgent: s.urgent, blocked: s.blocked, quick: scope.filter((c) => isLive(c) && isQuickWin(c)).length }
  }, [scope])
  const summary = summaryText(summarize(filtered, scope))
  const categories = useMemo(() => categoriesOf(all), [all])
  const agentList = useMemo(() => Object.values(agents).filter((a) => a.state !== 'retired'), [agents])
  const droppedCount = useMemo(() => all.filter((c) => c.state === 'dropped').length, [all])
  const columns = prefs.showDropped ? COLUMNS : COLUMNS.filter((c) => c.id !== 'dropped')

  // `/` focuses search, `n` opens the new-ticket dialog (not while typing or while a sheet / dialog is open).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('[role=dialog]')) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'n') { e.preventDefault(); setCreating(true) }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const act: FaceActions = {
    accept: (c) => void quickMove(c, 'todo', 'accepted to To do'),
    later: (c) => void setLater(c, true),
    bringBack: (c) => void setLater(c, false),
    drop: (c) => void quickMove(c, 'dropped', 'dropped'),
  }

  return (
    <div className="flex h-full flex-col">
      <BoardHeader summary={summary} prefs={prefs} update={update} droppedCount={droppedCount} onNew={() => setCreating(true)} cards={all} />
      <Toolbar prefs={prefs} update={update} categories={categories} agents={agentList} counts={counts} searchRef={searchRef} />

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
            onOpen={setOpen}
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
          onSort={(k) => update((p) => ({ ...p, list: { key: k, dir: p.list.key === k ? (p.list.dir === 'asc' ? 'desc' : 'asc') : k === 'return' ? 'desc' : 'asc' } }))}
        />
      )}

      <TicketSheet cardId={open} onClose={() => setOpen(null)} categories={categories} />
      <NewTicketDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}
