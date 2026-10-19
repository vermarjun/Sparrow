// Shell sidebar (§7.1): project switcher, New captain, search, captains grouped by what needs attention, nav, theme.
// Desktop: 260 px, collapsible (⌘B) to a 56 px rail of avatars. Mobile (< md): the same body inside an off-canvas Sheet.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bird, ChevronRight, Columns3, FileText, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Sparkles, Stethoscope, X } from 'lucide-react'
import type { CaptainSummary } from '@shared/types'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { CaptainAvatar, CountPill, hueStyle, StatusGlyph } from '@/components/captains/primitives'
import { attentionReason, captainName, captainSubline, isUntitled, statusLabel, tildePath } from '@/lib/captains'
import { ago } from '@/lib/format'
import { captainHref, href, type Page, type Route } from '@/lib/route'
import { sidebarModel, stepIndex, stepKey } from '@/lib/shell'
import { useShell } from '@/lib/shellUi'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import type { Boot } from '@/App'
import { IconButton } from './IconButton'
import { ProjectSwitcher } from './ProjectSwitcher'
import { ThemeToggle } from './ThemeToggle'

const NAV: { page: Page; label: string; Icon: typeof Columns3 }[] = [
  { page: 'board', label: 'Board', Icon: Columns3 },
  { page: 'resumes', label: 'Resumes', Icon: FileText },
  { page: 'skills', label: 'Skills', Icon: Sparkles },
  { page: 'doctor', label: 'Doctor', Icon: Stethoscope },
  { page: 'settings', label: 'Settings', Icon: Settings },
]

const CONN = {
  live: { label: 'Live', dot: 'bg-ok' },
  connecting: { label: 'Connecting…', dot: 'bg-warn' },
  down: { label: 'Offline', dot: 'bg-bad' },
} as const

function ConnDot({ withLabel }: { withLabel?: boolean }) {
  const conn = useStore((s) => s.conn)
  const c = CONN[conn]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-7 items-center gap-1.5 px-1.5 text-xs text-muted-foreground" role="status" aria-label={`Server ${c.label.toLowerCase()}`}>
          <span className={cn('size-1.5 rounded-full', c.dot)} />
          {withLabel && c.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{conn === 'live' ? 'Connected to Sparrow, updates are live' : conn === 'connecting' ? 'Connecting to Sparrow…' : 'Cannot reach Sparrow, retrying'}</TooltipContent>
    </Tooltip>
  )
}

// ---------------------------------------------------------------- rows

/** Fixed-width right slot (glyph or unread pill): nothing shifts when a status changes. The time lives in the tooltip. */
function RowStatus({ s }: { s: CaptainSummary }) {
  const n = s.questions > 0 ? s.questions : s.unread
  return (
    <span className="flex h-4 w-6 shrink-0 items-center justify-end">
      {s.status === 'attention' && n > 0 ? <CountPill n={n} /> : <StatusGlyph status={s.status} />}
    </span>
  )
}

function CaptainNavRow({ s, selected, tabbable, onNavigate }: { s: CaptainSummary; selected: boolean; tabbable: boolean; onNavigate?: () => void }) {
  const project = useStore((st) => st.project)
  const a = s.agent
  const untitled = isUntitled(a)
  const reason = attentionReason(s)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          data-row
          href={captainHref(a.id, project)}
          tabIndex={tabbable ? 0 : -1}
          aria-current={selected ? 'page' : undefined}
          onClick={onNavigate}
          className={cn(
            'relative flex h-9 items-center gap-2.5 rounded-md px-2 text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
            selected && 'bg-accent',
            s.status === 'archived' && 'opacity-60',
          )}
        >
          {selected && <span aria-hidden style={hueStyle(a.id)} className="absolute inset-y-2 left-0 w-0.5 rounded-full cap-bg" />}
          <CaptainAvatar id={a.id} handle={a.handle} />
          <span className={cn('min-w-0 flex-1 truncate', untitled && 'text-muted-foreground')}>{captainName(a)}</span>
          <RowStatus s={s} />
        </a>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} className="max-w-72 flex-col items-start gap-0.5">
        <span className="font-medium">{captainName(a)}</span>
        <span className="opacity-70">{captainSubline(a)}{!untitled ? '' : a.captain?.branch ? ` · ${a.captain.branch}` : ''}</span>
        <span className="font-mono text-[11px] opacity-70">{tildePath(a.cwd)}</span>
        <span className="opacity-70">{statusLabel(s)}{reason && s.status !== 'attention' ? ` · ${reason}` : ''} · {ago(s.last_activity_at)}</span>
      </TooltipContent>
    </Tooltip>
  )
}

// ---------------------------------------------------------------- list

function ListSkeleton() {
  return (
    <div className="grid gap-1 px-2.5 pt-2" aria-hidden>
      {[72, 58, 84, 64, 76].map((w, i) => (
        <div key={i} className="flex h-9 items-center gap-2.5 px-2">
          <div className="size-5 rounded-md bg-muted" />
          <div className="h-3 rounded bg-muted" style={{ width: `${w}%`, maxWidth: 150 }} />
        </div>
      ))}
    </div>
  )
}

function CaptainList({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const captains = useStore((s) => s.captains)
  const loaded = useStore((s) => s.captainsLoaded)
  const q = useShell((s) => s.query)
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const model = useMemo(() => sidebarModel(captains, q, archivedExpanded), [captains, q, archivedExpanded])
  const selectedId = route.page === 'captain' ? route.captain : null
  const tabbableId = (model.flat.find((s) => s.agent.id === selectedId) ?? model.flat[0])?.agent.id

  const step = (e: React.KeyboardEvent<HTMLElement>) => {
    const dir = stepKey(e.key)
    if (dir === null || e.metaKey || e.ctrlKey || e.altKey) return
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')]
    const cur = rows.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    rows[stepIndex(cur, rows.length, dir)]?.focus()
  }

  if (!loaded) return <ListSkeleton />
  return (
    <nav aria-label="Captains" onKeyDown={step} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2">
      {captains.length === 0 && <p className="px-2 pt-3 text-[13px] text-muted-foreground">No captains yet.</p>}
      {model.empty && <p className="px-2 pt-3 text-[13px] text-muted-foreground">No captain matches “{q.trim()}”.</p>}
      {model.groups.map((g) => {
        if (g.status === 'archived') {
          return (
            <div key="archived" className="mt-3">
              <button
                type="button"
                aria-expanded={model.archivedOpen}
                onClick={() => setArchivedExpanded((v) => !v)}
                className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ChevronRight className={cn('size-3 transition-transform duration-150', model.archivedOpen && 'rotate-90')} />
                Archived
                <span className="tabular">({model.archivedCount})</span>
              </button>
              {model.archivedOpen && g.items.map((s) => <CaptainNavRow key={s.agent.id} s={s} selected={s.agent.id === selectedId} tabbable={s.agent.id === tabbableId} onNavigate={onNavigate} />)}
            </div>
          )
        }
        return (
          <div key={g.status} className="mt-3 first:mt-1">
            <div className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">{g.label}</div>
            {g.items.map((s) => <CaptainNavRow key={s.agent.id} s={s} selected={s.agent.id === selectedId} tabbable={s.agent.id === tabbableId} onNavigate={onNavigate} />)}
          </div>
        )
      })}
    </nav>
  )
}

// ---------------------------------------------------------------- search

function SearchField({ onOpen }: { onOpen?: () => void }) {
  const q = useShell((s) => s.query)
  const setQuery = useShell((s) => s.setQuery)
  const focusTick = useShell((s) => s.focusTick)
  const ref = useRef<HTMLInputElement>(null)
  const captains = useStore((s) => s.captains)
  const project = useStore((s) => s.project)
  useEffect(() => { if (focusTick) { ref.current?.focus(); ref.current?.select() } }, [focusTick])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q) setQuery(''); else e.currentTarget.blur() }
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.currentTarget.closest('aside, [role=dialog]')?.querySelector<HTMLElement>('[data-row]')?.focus()
    } else if (e.key === 'Enter') {
      const first = sidebarModel(captains, q, false).flat[0]
      if (first) { location.hash = captainHref(first.agent.id, project).slice(1); onOpen?.() }
    }
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search captains"
        aria-label="Search captains"
        spellCheck={false}
        className="h-8 w-full rounded-md bg-transparent pr-8 pl-8 text-[13px] outline-none ring-1 ring-border/70 transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      />
      {q ? (
        <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); ref.current?.focus() }} className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground">
          <X className="size-3" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border/70 px-1 font-mono text-[10px] leading-4 text-muted-foreground">/</kbd>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- body

function NavLinks({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const project = useStore((s) => s.project)
  return (
    <nav aria-label="Pages" className="grid gap-px px-2.5">
      {NAV.map(({ page, label, Icon }) => {
        const active = route.page === page
        return (
          <a
            key={page}
            href={href({ page, project })}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </a>
        )
      })}
    </nav>
  )
}

function SidebarBody({ route, onNavigate, desktop }: { route: Route; onNavigate?: () => void; desktop?: boolean }) {
  const project = useStore((s) => s.project)
  const setNew = useShell((s) => s.setNew)
  const toggle = useShell((s) => s.toggleCollapsed)
  return (
    <div className="flex h-full w-65 max-w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <a href={href({ page: 'captains', project })} onClick={onNavigate} aria-label="All captains" className="grid size-8 shrink-0 place-items-center rounded-md text-foreground outline-none transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/50">
              <Bird className="size-[18px]" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom">All captains</TooltipContent>
        </Tooltip>
        <ProjectSwitcher route={route} onPicked={onNavigate} />
        {desktop && (
          <IconButton label="Collapse sidebar" hint="⌘B" onClick={toggle} className="text-muted-foreground"><PanelLeftClose className="size-4" /></IconButton>
        )}
      </div>
      <div className="grid gap-2 px-2.5 pb-1.5">
        <Button variant="outline" className="h-9 justify-start gap-2 px-2.5 text-[13px] font-medium" onClick={() => setNew(true)}>
          <Plus className="size-4" /> New captain
        </Button>
        <SearchField onOpen={onNavigate} />
      </div>
      <CaptainList route={route} onNavigate={onNavigate} />
      <div className="shrink-0 border-t border-sidebar-border/70 pt-2">
        <NavLinks route={route} onNavigate={onNavigate} />
        <div className="flex items-center justify-between px-2.5 pt-2 pb-2.5">
          <ThemeToggle />
          <ConnDot withLabel />
        </div>
      </div>
    </div>
  )
}

/** The 56 px collapsed rail: the mark expands it; every captain is an avatar with its status dot. */
function Rail({ route }: { route: Route }) {
  const project = useStore((s) => s.project)
  const captains = useStore((s) => s.captains)
  const toggle = useShell((s) => s.toggleCollapsed)
  const setNew = useShell((s) => s.setNew)
  const live = useMemo(() => sidebarModel(captains, '', false).flat, [captains])
  return (
    <div className="flex h-full w-14 flex-col items-center">
      <div className="flex h-12 shrink-0 items-center">
        <IconButton label="Expand sidebar" hint="⌘B" side="right" onClick={toggle} className="text-muted-foreground"><PanelLeftOpen className="size-4" /></IconButton>
      </div>
      <IconButton label="New captain" side="right" variant="outline" size="icon" onClick={() => setNew(true)}><Plus className="size-4" /></IconButton>
      <div className="mt-2 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
        {live.map((s) => {
          const selected = route.page === 'captain' && route.captain === s.agent.id
          return (
            <Tooltip key={s.agent.id}>
              <TooltipTrigger asChild>
                <a href={captainHref(s.agent.id, project)} aria-label={captainName(s.agent)} aria-current={selected ? 'page' : undefined} className={cn('relative grid size-9 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50', selected && 'bg-accent')}>
                  <span className="relative">
                    <CaptainAvatar id={s.agent.id} handle={s.agent.handle} />
                    {(s.status === 'working' || s.status === 'attention') && (
                      <span className="absolute -top-1 -right-1 rounded-full bg-sidebar p-0.5"><StatusGlyph status={s.status} className="size-1.5" /></span>
                    )}
                  </span>
                </a>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>{captainName(s.agent)}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <div className="grid shrink-0 gap-px border-t border-sidebar-border/70 py-2">
        {NAV.map(({ page, label, Icon }) => (
          <Tooltip key={page}>
            <TooltipTrigger asChild>
              <a href={href({ page, project })} aria-label={label} aria-current={route.page === page ? 'page' : undefined} className={cn('grid size-9 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50', route.page === page ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
                <Icon className="size-4" />
              </a>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        ))}
        <div className="grid place-items-center pt-1"><ConnDot /></div>
      </div>
    </div>
  )
}

export function Sidebar({ route }: { route: Route; boot: Boot }) {
  const collapsed = useShell((s) => s.collapsed)
  const mobileOpen = useShell((s) => s.mobileOpen)
  const setMobileOpen = useShell((s) => s.setMobileOpen)
  // Any navigation closes the drawer (links, palette, back button).
  useEffect(() => { setMobileOpen(false) }, [route.page, route.captain, route.project, setMobileOpen])
  return (
    <>
      <aside
        aria-label="Sidebar"
        className={cn('hidden shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out md:block', collapsed ? 'w-14' : 'w-65')}
      >
        {collapsed ? <Rail route={route} /> : <SidebarBody route={route} desktop />}
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" showCloseButton={false} className="w-[min(300px,86vw)] gap-0 bg-sidebar p-0 data-[side=left]:w-[min(300px,86vw)] data-[side=left]:sm:max-w-none">
          <SheetTitle className="sr-only">Sparrow</SheetTitle>
          <SheetDescription className="sr-only">Captains, projects and pages</SheetDescription>
          <SidebarBody route={route} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  )
}
