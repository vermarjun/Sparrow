// Project home (#/captains), spec §7.2: one calm list of every feature in flight.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { CaptainRow } from '@/components/captains/CaptainRow'
import { useNow } from '@/components/sparrow/bits'
import { Button } from '@/components/ui/button'
import { CAPTAIN_FILTERS, filterCaptains, filterCounts, projectLine, type CaptainFilter } from '@/lib/captains'
import { captainHref, navigate, type Route } from '@/lib/route'
import { stepIndex, stepKey } from '@/lib/shell'
import { useShell } from '@/lib/shellUi'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const FILTER_KEY = 'sparrow.captains.filter'
const readFilter = (): CaptainFilter => {
  try { const v = localStorage.getItem(FILTER_KEY) as CaptainFilter | null; return CAPTAIN_FILTERS.some((f) => f.id === v) ? v! : 'all' } catch { return 'all' }
}

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
}

function Segmented({ value, counts, onChange }: { value: CaptainFilter; counts: Record<CaptainFilter, number>; onChange: (f: CaptainFilter) => void }) {
  return (
    <div role="tablist" aria-label="Filter captains" className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 [scrollbar-width:none]">
      {CAPTAIN_FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          role="tab"
          aria-selected={value === f.id}
          onClick={() => onChange(f.id)}
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] md:px-3 whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7',
            value === f.id ? 'bg-background font-medium text-foreground ring-1 ring-border/70' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {f.label}
          <span className="text-xs text-muted-foreground tabular">{counts[f.id]}</span>
        </button>
      ))}
    </div>
  )
}

function RowSkeleton() {
  return (
    <div className="grid gap-px" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-4 px-3 py-3">
          <div className="size-7 rounded-lg bg-muted" />
          <div className="grid min-w-0 flex-1 gap-2">
            <div className="h-3.5 rounded bg-muted" style={{ width: `${52 + ((i * 13) % 30)}%` }} />
            <div className="h-3 w-2/5 rounded bg-muted/70" />
          </div>
          <div className="hidden h-1.5 w-28 rounded-full bg-muted md:block" />
        </div>
      ))}
    </div>
  )
}

function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 pt-24 text-center">
      <p className="text-sm text-muted-foreground">A captain is a Claude Code session that owns one feature and hires its own team. Start your first one.</p>
      <Button onClick={onNew}><Plus /> New captain</Button>
      <code className="font-mono text-[12px] text-muted-foreground">sparrow captain --title "Rate limiting"</code>
    </div>
  )
}

const FILTER_EMPTY: Record<CaptainFilter, string> = {
  all: 'No captains match.',
  working: 'No captain has agents working right now.',
  attention: 'Nothing needs you. Every captain is on track.',
  idle: 'No idle captains.',
  archived: 'No archived captains.',
}

export function CaptainsPage(_props: { route: Route }) {
  const project = useStore((s) => s.project)
  const projects = useStore((s) => s.projects)
  const captains = useStore((s) => s.captains)
  const loaded = useStore((s) => s.captainsLoaded)
  const setNew = useShell((s) => s.setNew)
  const now = useNow(30_000)
  const [filter, setFilter] = useState<CaptainFilter>(readFilter)
  const [focus, setFocus] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)

  const counts = useMemo(() => filterCounts(captains), [captains])
  const rows = useMemo(() => filterCaptains(captains, filter), [captains, filter])
  const name = projects.find((p) => p.id === project)?.name ?? project ?? ''
  const setF = (f: CaptainFilter) => { setFilter(f); setFocus(-1); try { localStorage.setItem(FILTER_KEY, f) } catch { /* private mode */ } }

  // j/k/↑/↓ move a ring through the rows, Enter opens, Esc clears (not while typing or with a dialog open).
  const live = useRef({ rows, focus, project })
  useEffect(() => { live.current = { rows, focus, project } })
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e.target) || document.querySelector('[role=dialog]')) return
      const { rows, focus, project } = live.current
      const dir = stepKey(e.key)
      if (dir !== null) {
        e.preventDefault()
        const i = stepIndex(focus, rows.length, dir)
        setFocus(i)
        const id = rows[i]?.agent.id
        if (id) listRef.current?.querySelector(`[data-captain-row="${id}"]`)?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && focus >= 0 && rows[focus] && !(e.target as HTMLElement | null)?.closest('a,button')) {
        e.preventDefault()
        navigate(captainHref(rows[focus].agent.id, project))
      } else if (e.key === 'Escape' && focus >= 0) setFocus(-1)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const none = loaded && captains.length === 0
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-[980px] px-4 pt-6 pb-16 md:px-8 md:pt-14">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="hidden truncate text-xl font-semibold tracking-tight md:block">{name}</h1>
            <p className="min-h-5 text-[13px] text-muted-foreground tabular md:mt-1">{loaded ? projectLine(captains) : ''}</p>
          </div>
          {!none && (
            <>
              <Button variant="outline" className="hidden shrink-0 md:inline-flex" onClick={() => setNew(true)}><Plus /> New captain</Button>
              <Button variant="outline" size="icon" className="size-9 shrink-0 md:hidden" aria-label="New captain" onClick={() => setNew(true)}><Plus /></Button>
            </>
          )}
        </header>

        {none ? (
          <Empty onNew={() => setNew(true)} />
        ) : (
          <>
            <div className="mt-6 mb-2"><Segmented value={filter} counts={counts} onChange={setF} /></div>
            <div ref={listRef} className="-mx-3" aria-label="Captains">
              {!loaded ? <RowSkeleton /> : rows.length === 0 ? (
                <p className="px-3 pt-10 text-center text-[13px] text-muted-foreground">{FILTER_EMPTY[filter]}</p>
              ) : rows.map((s, i) => <CaptainRow key={s.agent.id} s={s} now={now} focused={i === focus} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
