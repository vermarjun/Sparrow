// Team tab (§7.3): the fleet as a tree with hairline connectors. Rows are a fixed 56 px so live updates never shift layout.
import { useMemo } from 'react'
import type { Agent, CaptainSummary } from '@shared/types'
import { AgentAvatar, CaptainAvatar, HarnessTag, RESULT_TONE, StateDot, STATE_LABEL, StatusGlyph } from '@/components/captains/primitives'
import { useNow } from '@/components/sparrow/bits'
import { STATE_ORDER, STATUS_META, captainName, flattenFleet, fleetTree, isUntitled, type FleetRow } from '@/lib/captains'
import { oneLine } from '@/lib/captainPage'
import { ago, duration, jobResult } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EmptyState } from './parts'
import { useOpenCalls, useRowNav } from './hooks'

const GUT = 28 // one tree level = one avatar width, so connectors run through the parent's avatar centre
const LINE = 'bg-foreground/15'

function Connectors({ row }: { row: FleetRow }) {
  const { depth, guides, last, childCount } = row
  return (
    <>
      {guides.map((on, i) => on && <span key={i} aria-hidden className={cn('absolute top-0 bottom-0 w-px', LINE)} style={{ left: i * GUT + 14 }} />)}
      {depth > 0 && (
        <>
          <span aria-hidden className={cn('absolute top-0 w-px', LINE)} style={{ left: (depth - 1) * GUT + 14, height: last ? 28 : '100%' }} />
          <span aria-hidden className={cn('absolute h-px', LINE)} style={{ left: (depth - 1) * GUT + 14, top: 28, width: GUT - 18 }} />
        </>
      )}
      {childCount > 0 && <span aria-hidden className={cn('absolute w-px', LINE)} style={{ left: depth * GUT + 14, top: 42, bottom: 0 }} />}
    </>
  )
}

function StateBadge({ state, className }: { state: Agent['state']; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', state === 'crashed' ? 'text-bad' : state === 'waiting' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground', className)}>
      <StateDot state={state} />
      {STATE_LABEL[state]}
    </span>
  )
}

function TeamRow({ row, summary, now, started, selected, onOpen }: { row: FleetRow; summary: CaptainSummary; now: number; started?: number; selected: boolean; onOpen: (id: string) => void }) {
  const a = row.agent
  const isRoot = row.depth === 0
  const res = isRoot ? null : jobResult(a)
  // The captain's own line is what it works on (its title), never another agent's message.
  const line = isRoot ? (isUntitled(a) ? '' : captainName(a)) : res ? res.line : oneLine(a.last_update)
  const lineAt = isRoot ? null : res ? res.at : a.last_update_at
  return (
    <button
      type="button"
      data-row
      data-agent={a.handle}
      aria-current={selected || undefined}
      onClick={() => onOpen(a.id)}
      style={{ paddingLeft: row.depth * GUT }}
      className={cn(
        'group relative flex h-14 w-full items-start rounded-lg text-left outline-none transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50',
        selected && 'bg-accent/60',
        a.state === 'retired' && !isRoot && 'opacity-50',
      )}
    >
      <Connectors row={row} />
      <span className="mt-3.5 mr-3 shrink-0">
        {isRoot ? <CaptainAvatar id={a.id} handle={a.handle} size="md" soft={false} /> : <AgentAvatar handle={a.handle} size="md" />}
      </span>
      <span className="min-w-0 flex-1 pt-2.5 pr-3">
        <span className="flex h-5 items-center gap-2">
          <span className="shrink-0 text-sm font-medium">@{a.handle}</span>
          <span className="hidden min-w-0 truncate text-[13px] text-muted-foreground sm:inline">{isRoot ? 'captain · your session' : a.title}</span>
          {!isRoot && <HarnessTag harness={a.harness} className="hidden shrink-0 md:inline" />}
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {res && <span className={cn('inline-flex h-5 items-center rounded-full px-2 text-[11px] leading-none font-medium', RESULT_TONE[res.status].chip)}>{RESULT_TONE[res.status].label}</span>}
            {isRoot ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                {summary.status === 'working' || summary.status === 'attention' ? <StatusGlyph status={summary.status} /> : <StateDot state="idle" />}
                {STATUS_META[summary.status].label}
              </span>
            ) : <StateBadge state={a.state} />}
            {a.state === 'working' && started != null && <span className="w-12 text-right text-xs text-muted-foreground tabular">{duration(Math.max(0, now - started))}</span>}
          </span>
        </span>
        <span className="flex h-5 items-center gap-2 text-[13px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{line || (isRoot ? null : <span className="text-muted-foreground/60">No updates yet</span>)}</span>
          {lineAt != null && <span className="shrink-0 text-xs tabular text-muted-foreground/70">{ago(lineAt, now)}</span>}
        </span>
      </span>
    </button>
  )
}

export function TeamTab({ summary, fleet, selected, onAgent }: { summary: CaptainSummary; fleet: Agent[]; selected: string | null; onAgent: (id: string) => void }) {
  const id = summary.agent.id
  const rows = useMemo(() => flattenFleet(fleetTree(fleet, id)), [fleet, id])
  const now = useNow(5000)
  const working = useMemo(() => fleet.filter((a) => a.state === 'working' && a.id !== id).map((a) => a.id), [fleet, id])
  const starts = useOpenCalls(working)
  const onKeyDown = useRowNav()
  if (rows.length <= 1) {
    return (
      <EmptyState
        title="No hires yet"
        hint="This captain's team shows up here as soon as it hires someone."
        cli={'sparrow hire <resume> "<task>"'}
        action={{ label: 'Open the board', href: '#/board' }}
      />
    )
  }
  return (
    <div className="h-full overflow-y-auto" onKeyDown={onKeyDown}>
      <div className="mx-auto max-w-[920px] px-3 py-4 sm:px-6 sm:py-6" role="list" aria-label="Team">
        {rows.map((r) => (
          <div role="listitem" key={r.agent.id}>
            <TeamRow row={r} summary={summary} now={now} started={starts[r.agent.id]} selected={selected === r.agent.id} onOpen={onAgent} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Compact team for the Activity rail: working first, one line each. */
export function CompactTeam({ fleet, captainId, onAgent }: { fleet: Agent[]; captainId: string; onAgent: (id: string) => void }) {
  const list = useMemo(
    () => fleet.filter((a) => a.id !== captainId).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.created_at - b.created_at),
    [fleet, captainId],
  )
  const onKeyDown = useRowNav()
  if (!list.length) return <p className="text-[13px] text-muted-foreground">No hires yet.</p>
  return (
    <ul className="-mx-2" onKeyDown={onKeyDown}>
      {list.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            data-row
            onClick={() => onAgent(a.id)}
            className={cn('flex h-9 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50', a.state === 'retired' && 'opacity-50')}
          >
            <StateDot state={a.state} />
            <span className="shrink-0 text-[13px] font-medium">@{a.handle}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{oneLine(a.last_update) || STATE_LABEL[a.state]}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
