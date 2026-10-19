import { useMemo } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Moon } from 'lucide-react'
import type { Agent, Card } from '@shared/types'
import { formatEstimate } from '@shared/cards'
import { ago, fullDate } from '@/lib/format'
import { isShelved } from '@/lib/boardFilter'
import { sortListCards, listKeyFor, listSortLabel, nextSort, visibleColumns, type ListCol as Col } from '@/lib/listSort'
import type { ListKey } from '@/lib/boardPrefs'
import { useNow } from '@/components/sparrow/bits'
import { COLUMNS, COLUMN_BY_STATE } from '@/lib/boardStyle'
import { railOf, railTip, type Rail } from '@/lib/faceA'
import { railStyle } from '@/lib/swatchStyle'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Avatar, CategoryLabel, PayoffLabel, Tip } from './markers'

// Rows are grouped by state, so there is no State column. Columns that are empty for every visible ticket are hidden.
const WIDTH: Record<Col, string> = { key: 'w-24', title: 'min-w-64', category: 'w-32', payoff: 'w-28', estimate: 'w-20', age: 'w-16', assignee: 'w-32', updated: 'w-20' }

export function ListView({ cards, onOpen, sortKey, sortDir, onSort }: {
  cards: Card[]
  onOpen: (id: number) => void
  sortKey: ListKey
  sortDir: 'asc' | 'desc'
  onSort: (k: ListKey) => void
}) {
  const agents = useStore((s) => s.agents)
  const now = useNow()
  const ordered = useMemo(() => sortListCards(cards, sortKey, sortDir, (id) => id ? agents[id]?.handle ?? id : null), [cards, sortKey, sortDir, agents])
  const byState = useMemo(() => {
    const states = sortKey === 'state' && sortDir === 'desc' ? [...COLUMNS].reverse() : COLUMNS
    return states.map((column) => ({ ...column, cards: ordered.filter((card) => card.state === column.id) })).filter((group) => group.cards.length)
  }, [ordered, sortKey, sortDir])
  const cols = useMemo(() => visibleColumns(cards), [cards])

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-zinc-200/80 bg-white" data-testid="board-list">
        <table className="w-full min-w-[820px] border-separate border-spacing-0 text-left text-xs">
          <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur">
            <tr>
              {cols.map((key) => <SortHeader key={key} sortKey={sortKey} sortDir={sortDir} onSort={onSort} listKey={key} width={WIDTH[key]} />)}
            </tr>
          </thead>
          {byState.length ? byState.map((group) => (
            <tbody key={group.id}>
              <tr className="sticky top-9 z-[5] bg-zinc-50">
                <th colSpan={cols.length} scope="rowgroup" className="h-8 border-y border-zinc-200/70 bg-zinc-50 px-3 text-left text-[12px] font-semibold text-zinc-700">
                  <span className="inline-flex items-center gap-2"><span className={cn('size-2 rounded-full', COLUMN_BY_STATE[group.id].dot)} />{group.name}<span className="font-medium text-zinc-400 tabular-nums">{group.cards.length}</span></span>
                </th>
              </tr>
              {group.cards.map((card) => (
                <TicketRow key={card.id} card={card} cols={cols} agents={agents} now={now} onOpen={onOpen} />
              ))}
            </tbody>
          )) : (
            <tbody><tr><td colSpan={cols.length} className="px-4 py-14 text-center">
              <div className="mx-auto flex max-w-xs flex-col items-center gap-2 text-zinc-400">
                <div className="flex size-8 items-center justify-center rounded-full bg-zinc-100"><Check className="size-4 text-zinc-500" /></div>
                <p className="text-xs font-medium text-zinc-600">No tickets match this view</p>
                <p className="text-[11px]">Clear a filter or search for another ticket.</p>
              </div>
            </td></tr></tbody>
          )}
        </table>
        <div className="sticky bottom-0 flex h-8 items-center border-t border-zinc-100 bg-white/95 px-3 text-[11px] text-zinc-400 backdrop-blur">
          <span>{cards.length} {cards.length === 1 ? 'ticket' : 'tickets'}</span>
          <span className="ml-auto">Select a row to open the ticket</span>
        </div>
      </div>
    </div>
  )
}

function SortHeader({ listKey, sortKey, sortDir, onSort, width }: { listKey: ListKey; sortKey: ListKey; sortDir: 'asc' | 'desc'; onSort: (key: ListKey) => void; width: string }) {
  const active = sortKey === listKey
  return (
    <th scope="col" className={cn('h-9 border-b border-zinc-200 px-3', width)}>
      <button
        type="button"
        onClick={() => onSort(nextSort(sortKey, sortDir, listKey))}
        aria-label={`Sort by ${listSortLabel(listKey)}`}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cn('group inline-flex items-center gap-1.5 text-[11.5px] font-medium whitespace-nowrap text-zinc-500 outline-none transition-colors hover:text-zinc-900 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring', active && 'text-zinc-900')}
        data-sort-key={listKey}
      >
        {listSortLabel(listKey)}
        {active ? sortDir === 'asc' ? <ArrowUp className="size-3 text-zinc-500" /> : <ArrowDown className="size-3 text-zinc-500" /> : <ArrowUpDown className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />}
      </button>
    </th>
  )
}

/** The row's left edge carries the same rail as the card; its tooltip says why. */
function RowRail({ rail, lines }: { rail: Exclude<Rail, null>; lines: string[] }) {
  return (
    <Tip side="right" label={<span className="flex flex-col">{lines.map((l) => <span key={l}>{l}</span>)}</span>}>
      <span className="absolute inset-y-0 left-0 flex w-2.5 cursor-help" data-rail={rail}>
        <span className="flex h-full w-1 flex-col" aria-hidden>
          {rail !== 'blocked' && <span className="min-h-0 flex-1" style={railStyle('urgent')} />}
          {rail !== 'urgent' && <span className="min-h-0 flex-1" style={railStyle('blocked')} />}
        </span>
      </span>
    </Tip>
  )
}

const CELL = 'border-b border-zinc-100 px-3 py-2.5'

function TicketRow({ card, cols, agents, now, onOpen }: { card: Card; cols: Col[]; agents: Record<string, Agent>; now: number; onOpen: (id: number) => void }) {
  const later = isShelved(card)
  const done = card.state === 'done'
  const rail = railOf(card)
  const assignee = card.assignee_id ? agents[card.assignee_id] : null
  const createdBy = card.created_by === 'user' ? 'you' : agents[card.created_by] ? `@${agents[card.created_by].handle}` : card.created_by
  const cell: Record<Col, React.ReactNode> = {
    key: (
      <td key="key" className={cn('relative whitespace-nowrap border-b border-zinc-100 py-2.5 pr-3 pl-4 font-mono text-[11px] tabular-nums', done ? 'text-emerald-700' : 'text-zinc-400')}>
        {rail && <RowRail rail={rail} lines={railTip(card, now)} />}
        {listKeyFor(card)}
      </td>
    ),
    title: (
      <td key="title" className="max-w-0 border-b border-zinc-100 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {done && <Check className="size-3.5 shrink-0 text-emerald-600" strokeWidth={3} aria-label="Done" />}
          <span className={cn('truncate text-[13px] font-medium', done ? 'text-zinc-500' : later ? 'text-slate-500' : 'text-zinc-900')}>{card.title}</span>
          {later && <Tip label="Later: parked"><Moon className="size-3 shrink-0 text-slate-400" data-flag="later" aria-label="Later" /></Tip>}
        </div>
      </td>
    ),
    category: <td key="category" className={CELL}>{card.category && <CategoryLabel name={card.category} />}</td>,
    payoff: <td key="payoff" className={CELL}>{card.impact || card.effort ? <PayoffLabel card={card} /> : null}</td>,
    estimate: <td key="estimate" className={cn(CELL, 'whitespace-nowrap font-mono text-[11px] tabular-nums text-zinc-500')}>{card.estimate_min ? `~${formatEstimate(card.estimate_min)}` : ''}</td>,
    age: (
      <td key="age" className={cn(CELL, 'font-mono text-[11px] tabular-nums text-zinc-500')}>
        <Tip label={`Created ${fullDate(card.created_at)} by ${createdBy}`}><span>{ago(card.created_at, now)}</span></Tip>
      </td>
    ),
    assignee: <td key="assignee" className={CELL}>{assignee && <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-700"><Avatar agent={assignee} />@{assignee.handle}</span>}</td>,
    updated: <td key="updated" className={cn(CELL, 'font-mono text-[11px] tabular-nums text-zinc-400')}>{ago(card.updated_at, now)}</td>,
  }
  return (
    <tr
      tabIndex={0}
      aria-label={`Open ${listKeyFor(card)} ${card.title}`}
      data-card-id={card.id}
      data-key={listKeyFor(card)}
      data-urgent={card.urgent || undefined}
      data-blocked={card.blocked_on ? '' : undefined}
      data-list-row
      data-later={later || undefined}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(card.id) } }}
      className={cn('group cursor-pointer outline-none focus-visible:relative focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500', later ? 'bg-zinc-50/80 text-slate-500 hover:bg-zinc-100/70' : 'bg-white text-zinc-700 hover:bg-zinc-50')}
    >
      {cols.map((c) => cell[c])}
    </tr>
  )
}
