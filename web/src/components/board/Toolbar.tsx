import { type RefObject } from 'react'
import { ArrowUpDown, Columns3, List, Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import type { Agent, CaptainSummary } from '@shared/types'
import { CARD_SORTS, type CardSort } from '@shared/cards'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { CaptainAvatar } from '@/components/captains/primitives'
import { captainName } from '@/lib/captains'
import { type BoardFilters, hasFilters, NO_FILTERS, popoverFilterCount, type Summary } from '@/lib/boardFilter'
import type { BoardPrefs } from '@/lib/boardPrefs'
import { COLUMN_BY_STATE } from '@/lib/boardStyle'
import type { SwatchKind } from '@/lib/swatchStyle'
import { cn } from '@/lib/utils'
import { CategoryChip, Segmented } from './markers'
import { Swatch } from './swatch'

type Update = (fn: (p: BoardPrefs) => BoardPrefs) => void

/** One count of the title line: a toggle with its swatch dot; on = coloured text and an underline. */
function SummaryToggle({ kind, on, onClick, count, word, tone, hint }: { kind: SwatchKind; on: boolean; onClick: () => void; count: number; word: string; tone: string; hint: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-filter={kind}
      title={hint}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md px-1 text-xs whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        on ? cn('font-medium underline decoration-2 underline-offset-[5px]', tone) : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Swatch kind={kind} shape="dot" />
      <span className="tabular-nums">{count}</span> {word}
    </button>
  )
}

/** `Board  30 tickets · 4 urgent · 3 blocked · 4 later`: the urgent / blocked / later counts are the filter. */
function Title({ summary, prefs, update, captains }: { summary: Summary; prefs: BoardPrefs; update: Update; captains: CaptainSummary[] }) {
  const f = prefs.filters
  const picked = f.captain ? captains.find((c) => c.agent.id === f.captain) : undefined
  const setF = (patch: Partial<BoardFilters>) => update((p) => ({ ...p, filters: { ...p.filters, ...patch } }))
  const laterOn = prefs.laterOpen.proposed || prefs.laterOpen.todo
  const head = summary.shown === summary.total ? `${summary.total} ticket${summary.total === 1 ? '' : 's'}` : `${summary.shown} of ${summary.total} tickets`
  const parts = [
    (summary.urgent > 0 || f.urgent) && (
      <SummaryToggle key="urgent" kind="urgent" on={f.urgent} onClick={() => setF({ urgent: !f.urgent })} count={summary.urgent} word="urgent" tone="text-red-700 dark:text-red-300 decoration-red-500" hint={f.urgent ? 'Show all tickets again' : 'Show only urgent tickets'} />
    ),
    (summary.blocked > 0 || f.blocked) && (
      <SummaryToggle key="blocked" kind="blocked" on={f.blocked} onClick={() => setF({ blocked: !f.blocked })} count={summary.blocked} word="blocked" tone="text-orange-700 dark:text-orange-300 decoration-orange-500" hint={f.blocked ? 'Show all tickets again' : 'Show only blocked tickets'} />
    ),
    (summary.later > 0 || laterOn) && (
      <SummaryToggle key="later" kind="later" on={laterOn} onClick={() => update((p) => ({ ...p, laterOpen: { proposed: !laterOn, todo: !laterOn } }))} count={summary.later} word="later" tone="text-foreground/75 decoration-muted-foreground/60" hint={laterOn ? 'Hide the Later lists' : 'Show the Later lists'} />
    ),
  ].filter(Boolean)
  return (
    <div className="flex min-w-0 flex-1 basis-[26rem] items-center gap-1.5 overflow-hidden">
      <h1 className="mr-1 text-sm font-semibold">Board</h1>
      <span className="text-xs whitespace-nowrap text-muted-foreground" data-testid="summary">{head}</span>
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span aria-hidden className="text-muted-foreground/45">·</span>
          {part}
        </span>
      ))}
      {f.captain && (
        <button
          type="button"
          data-testid="captain-filter-chip"
          onClick={() => setF({ captain: null })}
          title={`${picked ? captainName(picked.agent) : 'This captain'} · click to show every captain's tickets again`}
          className="ml-1 inline-flex h-5 min-w-0 max-w-44 items-center gap-1.5 rounded-full bg-muted pr-1.5 pl-1 text-[11px] font-medium text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
        >
          {picked && <CaptainAvatar id={picked.agent.id} handle={picked.agent.handle} size="xs" className="size-3.5 rounded-full text-[8px]" />}
          <span className="truncate">{picked ? captainName(picked.agent) : 'Unknown captain'}</span>
          <X className="size-3 shrink-0" />
        </button>
      )}
      {f.state && (
        <button
          type="button"
          data-testid="state-filter"
          onClick={() => setF({ state: null })}
          title="Show every state again"
          className="ml-1 inline-flex h-5 items-center gap-1 rounded-full bg-muted pr-1.5 pl-2 text-[11px] font-medium text-muted-foreground hover:bg-muted-foreground/20"
        >
          {COLUMN_BY_STATE[f.state].name}
          <X className="size-3" />
        </button>
      )}
      {(hasFilters(f) || prefs.showDropped) && (
        <button
          type="button"
          data-testid="clear-filters"
          onClick={() => update((p) => ({ ...p, showDropped: false, filters: { ...NO_FILTERS } }))}
          className="ml-1 shrink-0 rounded-md px-1 text-xs text-muted-foreground/70 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Clear
        </button>
      )}
    </div>
  )
}

/** A toggle chip of the Filter popover: on = ringed (categories keep their own colour) or filled dark (assignees). */
function Chip({ on, onClick, children, className }: { on: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn('rounded-md transition-shadow focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', on ? 'ring-2 ring-foreground ring-offset-1' : 'opacity-80 hover:opacity-100', className)}
    >
      {children}
    </button>
  )
}

const ANYONE = '__anyone'
const Label = ({ children }: { children: React.ReactNode }) => <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/70">{children}</p>

/** Category, Assignee, Quick wins and Show dropped: everything that is not the title line's counts. */
function FilterPopover({ prefs, update, categories, agents, captains, quickCount, droppedCount }: { prefs: BoardPrefs; update: Update; categories: string[]; agents: Agent[]; captains: CaptainSummary[]; quickCount: number; droppedCount: number }) {
  const f = prefs.filters
  const setF = (patch: Partial<BoardFilters>) => update((p) => ({ ...p, filters: { ...p.filters, ...patch } }))
  const n = popoverFilterCount(f, prefs.showDropped)
  const toggleCat = (c: string) => {
    const k = c.toLowerCase()
    setF({ categories: f.categories.includes(k) ? f.categories.filter((x) => x !== k) : [...f.categories, k] })
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="filter"
          aria-label={n ? `Filter, ${n} on` : 'Filter'}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5',
            n ? 'border-foreground text-foreground' : 'border-border text-muted-foreground',
          )}
        >
          <SlidersHorizontal className={n ? '' : 'text-muted-foreground/70'} />
          Filter
          {n > 0 && <span className="grid size-4 place-items-center rounded-full bg-foreground text-[10px] text-background tabular-nums" data-testid="filter-count">{n}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1.5" align="end" data-testid="filter-popover">
        {captains.length > 0 && (
          <>
            <Label>Captain</Label>
            <div className="px-2 pb-1.5">
              <Select value={f.captain ?? ANYONE} onValueChange={(v) => setF({ captain: v === ANYONE ? null : v })}>
                <SelectTrigger size="sm" aria-label="Captain" data-testid="filter-captain" className="h-8 w-full bg-background text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value={ANYONE} className="text-xs">Anyone</SelectItem>
                  {captains.filter((c) => c.status !== 'archived' || c.agent.id === f.captain).map((c) => (
                    <SelectItem key={c.agent.id} value={c.agent.id} className="text-xs">
                      <CaptainAvatar id={c.agent.id} handle={c.agent.handle} size="xs" />
                      <span className="truncate">{captainName(c.agent)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        {categories.length > 0 && (
          <>
            <Label>Category</Label>
            <div className="flex flex-wrap gap-1.5 px-2 pb-1.5" role="group" aria-label="Category">
              {categories.map((c) => <Chip key={c} on={f.categories.includes(c.toLowerCase())} onClick={() => toggleCat(c)}><CategoryChip name={c} /></Chip>)}
            </div>
          </>
        )}
        <Label>Assignee</Label>
        <div className="flex flex-wrap gap-1.5 px-2 pb-1.5" role="group" aria-label="Assignee">
          {[{ id: 'none', label: 'Unassigned' }, ...agents.map((a) => ({ id: a.id, label: `@${a.handle}` }))].map((o) => (
            <Chip key={o.id} on={f.assignee === o.id} onClick={() => setF({ assignee: f.assignee === o.id ? null : o.id })} className="bg-muted px-1.5 py-px text-[11px] font-medium text-foreground/80">{o.label}</Chip>
          ))}
        </div>
        <div className="mt-1.5 border-t border-border/50 pt-1">
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
            <Swatch kind="quick" shape="dot" />
            <span className="flex-1">Quick wins only</span>
            <span className="text-muted-foreground/70 tabular-nums">{quickCount}</span>
            <Switch checked={f.quick} onCheckedChange={(quick) => setF({ quick })} aria-label="Quick wins only" data-testid="filter-quick" />
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
            <span className="flex-1">Show dropped</span>
            <span className="text-muted-foreground/70 tabular-nums">{droppedCount}</span>
            <Switch checked={prefs.showDropped} onCheckedChange={(showDropped) => update((p) => ({ ...p, showDropped }))} aria-label="Show dropped" data-testid="filter-dropped" />
          </label>
        </div>
        {n > 0 && (
          <button
            type="button"
            data-testid="filter-reset"
            onClick={() => update((p) => ({ ...p, showDropped: false, filters: { ...p.filters, categories: [], assignee: null, captain: null, quick: false } }))}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Reset these filters
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The one chrome row: the title line (whose counts filter) on the left; Search · Filter · Sort · Board|List · New ticket on the right.
 * Nothing else lives up here: keys are on `?`, the Insights line is in the Done header's tooltip.
 */
export function Toolbar({ prefs, update, categories, agents, captains, summary, quickCount, droppedCount, searchRef, onNew }: {
  prefs: BoardPrefs
  update: Update
  categories: string[]
  agents: Agent[]
  captains: CaptainSummary[]
  summary: Summary
  quickCount: number
  droppedCount: number
  searchRef: RefObject<HTMLInputElement | null>
  onNew: () => void
}) {
  const f = prefs.filters
  const setF = (patch: Partial<BoardFilters>) => update((p) => ({ ...p, filters: { ...p.filters, ...patch } }))
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 pb-3" data-testid="toolbar">
      <Title summary={summary} prefs={prefs} update={update} captains={captains} />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <input
            ref={searchRef}
            value={f.q}
            onChange={(e) => setF({ q: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') { if (f.q) setF({ q: '' }); else e.currentTarget.blur() } }}
            placeholder="Search"
            aria-label="Search tickets"
            data-testid="search"
            className="h-7 w-36 rounded-lg border border-border bg-background pr-8 pl-7 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
          {f.q ? (
            <button type="button" aria-label="Clear search" onClick={() => setF({ q: '' })} className="absolute top-1/2 right-1.5 grid size-4 -translate-y-1/2 place-items-center rounded text-muted-foreground/70 hover:text-foreground/80"><X className="size-3" /></button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-border bg-muted/50 px-1 font-mono text-[10px] text-muted-foreground/70">/</kbd>
          )}
        </div>

        <FilterPopover prefs={prefs} update={update} categories={categories} agents={agents} captains={captains} quickCount={quickCount} droppedCount={droppedCount} />

        {prefs.view === 'board' && (
          <Select value={prefs.sort} onValueChange={(v) => update((p) => ({ ...p, sort: v as CardSort }))}>
            <SelectTrigger size="sm" aria-label="Sort" data-testid="sort" className="h-7 w-auto gap-1.5 bg-background text-xs [&_svg:not([class*='size-'])]:size-3.5">
              <ArrowUpDown className="text-muted-foreground/70" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {CARD_SORTS.map((s) => <SelectItem key={s.id} value={s.id} className="text-xs">{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        <Segmented
          label="View"
          value={prefs.view}
          onChange={(view) => update((p) => ({ ...p, view }))}
          options={[{ id: 'board', label: 'Board', icon: <Columns3 className="size-3.5" /> }, { id: 'list', label: 'List', icon: <List className="size-3.5" /> }]}
        />
        <Button size="sm" data-testid="new-ticket" onClick={onNew}>
          <Plus /> New ticket
        </Button>
      </div>
    </div>
  )
}
