import { type RefObject } from 'react'
import { ArrowUpDown, Ban, Check, ChevronLeft, ChevronRight, Columns3, Flame, List, Plus, Search, Tag, User, X, Zap } from 'lucide-react'
import type { Agent, Card } from '@shared/types'
import { CARD_SORTS, type CardSort } from '@shared/cards'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { type BoardFilters, hasFilters, NO_FILTERS } from '@/lib/boardFilter'
import type { BoardPrefs } from '@/lib/boardPrefs'
import { cn } from '@/lib/utils'
import { Insights } from './Insights'
import { CategoryChip, Segmented } from './markers'

export interface Counts { urgent: number; blocked: number; quick: number }

function FilterChip({ on, onClick, icon, label, count, tone, name }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number; tone: string; name: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-filter={name}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5',
        on ? tone : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50',
      )}
    >
      {icon}
      {label}
      <span className={cn('tabular-nums', on ? 'opacity-80' : 'text-zinc-400')}>{count}</span>
    </button>
  )
}

export function Toolbar({ prefs, update, categories, agents, counts, searchRef }: {
  prefs: BoardPrefs
  update: (fn: (p: BoardPrefs) => BoardPrefs) => void
  categories: string[]
  agents: Agent[]
  counts: Counts
  searchRef: RefObject<HTMLInputElement | null>
}) {
  const f = prefs.filters
  const setF = (patch: Partial<BoardFilters>) => update((p) => ({ ...p, filters: { ...p.filters, ...patch } }))
  const toggleCat = (c: string) => setF({ categories: f.categories.includes(c.toLowerCase()) ? f.categories.filter((x) => x !== c.toLowerCase()) : [...f.categories, c.toLowerCase()] })
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2.5" data-testid="toolbar">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          ref={searchRef}
          value={f.q}
          onChange={(e) => setF({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') { if (f.q) setF({ q: '' }); else e.currentTarget.blur() } }}
          placeholder="Search tickets"
          aria-label="Search tickets"
          data-testid="search"
          className="h-7 w-56 rounded-lg border border-zinc-200 bg-white pr-8 pl-7 text-xs outline-none placeholder:text-zinc-400 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        {f.q ? (
          <button type="button" aria-label="Clear search" onClick={() => setF({ q: '' })} className="absolute top-1/2 right-1.5 grid size-4 -translate-y-1/2 place-items-center rounded text-zinc-400 hover:text-zinc-700"><X className="size-3" /></button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] text-zinc-400">/</kbd>
        )}
      </div>

      {prefs.view === 'board' && (
        <Select value={prefs.sort} onValueChange={(v) => update((p) => ({ ...p, sort: v as CardSort }))}>
          <SelectTrigger size="sm" aria-label="Sort" data-testid="sort" className="h-7 w-auto gap-1.5 bg-white text-xs [&_svg:not([class*='size-'])]:size-3.5">
            <ArrowUpDown className="text-zinc-400" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {CARD_SORTS.map((s) => <SelectItem key={s.id} value={s.id} className="text-xs">{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      <span className="mx-0.5 h-4 w-px bg-zinc-200" />
      <FilterChip name="urgent" on={f.urgent} onClick={() => setF({ urgent: !f.urgent })} icon={<Flame />} label="Urgent" count={counts.urgent} tone="border-red-300 bg-red-50 text-red-700" />
      <FilterChip name="blocked" on={f.blocked} onClick={() => setF({ blocked: !f.blocked })} icon={<Ban />} label="Blocked" count={counts.blocked} tone="border-orange-300 bg-orange-50 text-orange-700" />
      <FilterChip name="quick" on={f.quick} onClick={() => setF({ quick: !f.quick })} icon={<Zap />} label="Quick wins" count={counts.quick} tone="border-green-300 bg-green-50 text-green-700" />

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-filter="category"
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5',
              f.categories.length ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50',
            )}
          >
            <Tag />
            {f.categories.length === 1 ? f.categories[0] : f.categories.length > 1 ? `${f.categories.length} categories` : 'Category'}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-52" align="start">
          {categories.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No categories yet.</p>}
          {categories.map((c) => {
            const on = f.categories.includes(c.toLowerCase())
            return (
              <button key={c} type="button" onClick={() => toggleCat(c)} aria-pressed={on} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-100">
                <span className={cn('grid size-3.5 place-items-center rounded border', on ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-zinc-300')}>{on && <Check className="size-3" />}</span>
                <CategoryChip name={c} />
              </button>
            )
          })}
        </PopoverContent>
      </Popover>

      <Select value={f.assignee ?? 'any'} onValueChange={(v) => setF({ assignee: v === 'any' ? null : v })}>
        <SelectTrigger size="sm" aria-label="Assignee" data-testid="assignee-filter" className={cn('h-7 w-auto gap-1.5 bg-white text-xs [&_svg:not([class*="size-"])]:size-3.5', f.assignee && 'border-indigo-300 bg-indigo-50 text-indigo-700')}>
          <User className="text-zinc-400" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value="any" className="text-xs">Anyone</SelectItem>
          <SelectItem value="none" className="text-xs">Unassigned</SelectItem>
          {agents.map((a) => <SelectItem key={a.id} value={a.id} className="text-xs">@{a.handle}</SelectItem>)}
        </SelectContent>
      </Select>

      {hasFilters(f) && (
        <Button variant="ghost" size="xs" className="text-zinc-500" data-testid="clear-filters" onClick={() => setF({ ...NO_FILTERS })}>
          <X /> Clear
        </Button>
      )}
    </div>
  )
}

export function BoardHeader({ summary, prefs, update, droppedCount, onNew, cards }: {
  cards: Card[]
  summary: string
  prefs: BoardPrefs
  update: (fn: (p: BoardPrefs) => BoardPrefs) => void
  droppedCount: number
  onNew: () => void
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 px-4">
      <h1 className="text-sm font-semibold">Board</h1>
      <span className="text-xs text-zinc-500" data-testid="summary">{summary}</span>
      <div className="ml-auto flex items-center gap-2">
        <Segmented
          label="Density"
          value={prefs.density}
          onChange={(density) => update((p) => ({ ...p, density }))}
          options={[{ id: 'compact', label: 'Compact' }, { id: 'detailed', label: 'Detailed' }]}
        />
        <Segmented
          label="View"
          value={prefs.view}
          onChange={(view) => update((p) => ({ ...p, view }))}
          options={[{ id: 'board', label: 'Board', icon: <Columns3 className="size-3.5" /> }, { id: 'list', label: 'List', icon: <List className="size-3.5" /> }]}
        />
        <Insights cards={cards} />
        <Button variant="ghost" size="sm" className="text-zinc-500" data-testid="toggle-dropped" aria-pressed={prefs.showDropped} onClick={() => update((p) => ({ ...p, showDropped: !p.showDropped }))}>
          {prefs.showDropped ? <ChevronRight /> : <ChevronLeft />}
          Dropped{droppedCount ? ` (${droppedCount})` : ''}
        </Button>
        <Button size="sm" data-testid="new-ticket" onClick={onNew}>
          <Plus /> New ticket
          <kbd className="ml-1 rounded bg-white/20 px-1 font-mono text-[10px]">N</kbd>
        </Button>
      </div>
    </div>
  )
}
