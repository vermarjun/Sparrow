import { useMemo } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Moon } from 'lucide-react'
import type { Agent, Card } from '@shared/types'
import { formatEstimate } from '@shared/cards'
import { ago, fullDate } from '@/lib/format'
import { isShelved } from '@/lib/boardFilter'
import { sortListCards, listKeyFor, listSortLabel } from '@/lib/listSort'
import type { ListKey } from '@/lib/boardPrefs'
import { useNow } from '@/components/sparrow/bits'
import { COLUMNS, COLUMN_BY_STATE } from '@/lib/boardStyle'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { railOf } from '@/lib/faceA'
import { Avatar, CategoryLabel, PayoffLabel, StatePill, Tip } from './markers'
import { Swatch } from './swatch'

const SORT_KEYS: ListKey[] = ['key', 'title', 'state', 'category', 'payoff', 'estimate', 'age', 'assignee', 'updated']

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

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-zinc-200/80 bg-white shadow-sm" data-testid="board-list">
        <table className="w-full min-w-[1000px] border-separate border-spacing-0 text-left text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-50/95 text-[10px] font-semibold tracking-[0.08em] text-zinc-500 uppercase backdrop-blur">
            <tr>
              {SORT_KEYS.slice(0, 4).map((key) => <SortHeader key={key} sortKey={sortKey} sortDir={sortDir} onSort={onSort} listKey={key} />)}
              <th scope="col" className="w-20 border-b border-zinc-200 px-3 py-2">Flags</th>
              {SORT_KEYS.slice(4).map((key) => <SortHeader key={key} sortKey={sortKey} sortDir={sortDir} onSort={onSort} listKey={key} />)}
            </tr>
          </thead>
          {byState.length ? byState.map((group) => (
            <tbody key={group.id}>
              <tr className={cn('sticky top-9 z-[5] border-b', COLUMN_BY_STATE[group.id].head, COLUMN_BY_STATE[group.id].edge)}>
                <th colSpan={10} scope="rowgroup" className={cn('h-7 px-3 text-left text-[11px] font-semibold', COLUMN_BY_STATE[group.id].title)}>
                  <span className="inline-flex items-center gap-2"><span className={cn('size-1.5 rounded-full', COLUMN_BY_STATE[group.id].dot)} />{group.name}<span className="font-normal opacity-70 tabular-nums">{group.cards.length}</span></span>
                </th>
              </tr>
              {group.cards.map((card) => (
                <TicketRow key={card.id} card={card} agents={agents} now={now} onOpen={onOpen} />
              ))}
            </tbody>
          )) : (
            <tbody><tr><td colSpan={10} className="px-4 py-14 text-center">
              <div className="mx-auto flex max-w-xs flex-col items-center gap-2 text-zinc-400">
                <div className="flex size-8 items-center justify-center rounded-full bg-zinc-100"><Check className="size-4 text-zinc-500" /></div>
                <p className="text-xs font-medium text-zinc-600">No tickets match this view</p>
                <p className="text-[11px]">Clear a filter or search for another ticket.</p>
              </div>
            </td></tr></tbody>
          )}
        </table>
        <div className="sticky bottom-0 flex h-8 items-center border-t border-zinc-100 bg-zinc-50/95 px-3 text-[10px] text-zinc-400 backdrop-blur">
          <span>{cards.length} {cards.length === 1 ? 'ticket' : 'tickets'}</span>
          <span className="ml-auto">Select a row to open the ticket</span>
        </div>
      </div>
    </div>
  )
}

function SortHeader({ listKey, sortKey, sortDir, onSort }: { listKey: ListKey; sortKey: ListKey; sortDir: 'asc' | 'desc'; onSort: (key: ListKey) => void }) {
  const active = sortKey === listKey
  const widths: Partial<Record<ListKey, string>> = { key: 'w-24', title: 'w-[30%] min-w-64', state: 'w-28', category: 'w-28', payoff: 'w-28', estimate: 'w-24', age: 'w-16', assignee: 'w-32', updated: 'w-20' }
  return (
    <th scope="col" className={cn('h-9 border-b border-zinc-200 px-3', widths[listKey])}>
      <button
        type="button"
        onClick={() => onSort(listKey)}
        aria-label={`Sort by ${listSortLabel(listKey)}`}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cn('group inline-flex items-center gap-1.5 whitespace-nowrap outline-none transition-colors hover:text-zinc-900 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring', active && 'text-zinc-900')}
        data-sort-key={listKey}
      >
        {listSortLabel(listKey)}
        {active ? sortDir === 'asc' ? <ArrowUp className="size-3 text-violet-600" /> : <ArrowDown className="size-3 text-violet-600" /> : <ArrowUpDown className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />}
      </button>
    </th>
  )
}

function TicketRow({ card, agents, now, onOpen }: { card: Card; agents: Record<string, Agent>; now: number; onOpen: (id: number) => void }) {
  const later = isShelved(card)
  const done = card.state === 'done'
  const rail = railOf(card)
  const assignee = card.assignee_id ? agents[card.assignee_id] : null
  const createdBy = card.created_by === 'user' ? 'you' : agents[card.created_by] ? `@${agents[card.created_by].handle}` : card.created_by
  return (
    <tr
      tabIndex={0}
      aria-label={`Open ${listKeyFor(card)} ${card.title}`}
      data-card-id={card.id}
      data-list-row
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(card.id) } }}
      className={cn('group cursor-pointer outline-none focus-visible:relative focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500', later ? 'bg-slate-50/90 text-slate-500 hover:bg-slate-100/80' : 'bg-white text-zinc-700 hover:bg-violet-50/40')}
    >
      <td className={cn('whitespace-nowrap border-b border-zinc-100 px-3 py-2.5 font-mono text-[11px] tabular-nums text-zinc-400')}>
        {listKeyFor(card)}
      </td>
      <td className="max-w-0 border-b border-zinc-100 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {done && <Check className="size-3.5 shrink-0 text-emerald-600" strokeWidth={3} aria-label="Done" />}
          <span className={cn('truncate text-[12px] font-medium', later ? 'text-slate-500' : 'text-zinc-800 group-hover:text-zinc-950')}>{card.title}</span>
        </div>
      </td>
      <td className="border-b border-zinc-100 px-3 py-2.5"><StatePill state={card.state} /></td>
      <td className="border-b border-zinc-100 px-3 py-2.5">{card.category ? <CategoryLabel name={card.category} /> : <span className="text-zinc-300">—</span>}</td>
      <td className="border-b border-zinc-100 px-3 py-2.5">
        <div className="flex items-center gap-1.5" data-flags>
          {(rail === 'urgent' || rail === 'both') && <FlagSwatch kind="urgent" tip="Urgent" />}
          {(rail === 'blocked' || rail === 'both') && <FlagSwatch kind="blocked" tip={`Blocked on ${card.blocked_on}${card.blocked_at ? ` · ${ago(card.blocked_at, now)}` : ''}`} />}
          {later && <Tip label="Later: parked"><Moon className="size-3 text-slate-400" data-flag="later" aria-label="Later" /></Tip>}
          {!rail && !later && <span className="text-zinc-300">—</span>}
        </div>
      </td>
      <td className="border-b border-zinc-100 px-3 py-2.5">{card.impact || card.effort ? <PayoffLabel card={card} /> : <span className="text-zinc-300">—</span>}</td>
      <td className="whitespace-nowrap border-b border-zinc-100 px-3 py-2.5 font-mono text-[11px] tabular-nums text-zinc-500">{card.estimate_min ? `~${formatEstimate(card.estimate_min)}` : <span className="text-zinc-300">—</span>}</td>
      <td className="border-b border-zinc-100 px-3 py-2.5 font-mono text-[11px] tabular-nums text-zinc-500">
        <Tip label={`Created ${fullDate(card.created_at)} by ${createdBy}`}><span>{ago(card.created_at, now)}</span></Tip>
      </td>
      <td className="border-b border-zinc-100 px-3 py-2.5">{assignee ? <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-700"><Avatar agent={assignee} />@{assignee.handle}</span> : <span className="text-zinc-300">—</span>}</td>
      <td className="border-b border-zinc-100 px-3 py-2.5 font-mono text-[11px] tabular-nums text-zinc-400">{ago(card.updated_at, now)}</td>
    </tr>
  )
}

/** A legend swatch (same as the toolbar and the card rail) with a tooltip; the padding makes the thin stripe easy to hover. */
function FlagSwatch({ kind, tip }: { kind: 'urgent' | 'blocked'; tip: string }) {
  return <Tip label={tip}><span className="inline-flex cursor-help p-1" data-flag={kind}><Swatch kind={kind} /></span></Tip>
}
