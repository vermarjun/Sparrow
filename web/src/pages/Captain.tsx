// Captain page (#/captain/<id>), spec §7.3: header, meta line, stats, then Activity · Team · Cards and the Agent sheet.
import { useEffect, useMemo, useState } from 'react'
import type { Route, CaptainTab } from '@/lib/route'
import { CAPTAIN_TABS, captainHref, href, navigate } from '@/lib/route'
import { useStore } from '@/lib/store'
import { fleetCards } from '@/lib/captainPage'
import { fleetIds } from '@/lib/captains'
import { TicketSheet } from '@/components/board/TicketSheet'
import { Activity } from '@/components/captain/Activity'
import { AgentSheet } from '@/components/captain/AgentSheet'
import { CardsTab } from '@/components/captain/CardsTab'
import { Header } from '@/components/captain/Header'
import { MetaLine } from '@/components/captain/MetaLine'
import { Bar, EmptyState, FeedSkeleton } from '@/components/captain/parts'
import { Stats } from '@/components/captain/Stats'
import { TeamTab } from '@/components/captain/Team'
import { cn } from '@/lib/utils'

const TAB_LABEL: Record<CaptainTab, string> = { activity: 'Activity', team: 'Team', cards: 'Cards' }

function Tabs({ tab, counts, onTab }: { tab: CaptainTab; counts: Record<CaptainTab, number>; onTab: (t: CaptainTab) => void }) {
  return (
    <div role="tablist" aria-label="Captain" className="flex shrink-0 items-end gap-6 border-b border-border/60 px-4 sm:px-8">
      {CAPTAIN_TABS.map((t, i) => (
        <button
          key={t}
          role="tab"
          id={`tab-${t}`}
          aria-selected={tab === t}
          aria-controls="captain-panel"
          tabIndex={tab === t ? 0 : -1}
          onClick={() => onTab(t)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') onTab(CAPTAIN_TABS[(i + 1) % 3])
            else if (e.key === 'ArrowLeft') onTab(CAPTAIN_TABS[(i + 2) % 3])
          }}
          className={cn(
            '-mb-px inline-flex h-11 items-center gap-2 border-b-2 text-sm transition-colors duration-150 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50',
            tab === t ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {TAB_LABEL[t]}
          <span className="text-xs font-normal text-muted-foreground tabular">{counts[t]}</span>
        </button>
      ))}
    </div>
  )
}

function PageSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy>
      <div className="space-y-4 px-4 pt-6 sm:px-8 sm:pt-7">
        <div className="flex items-center gap-3"><Bar className="size-10 rounded-xl" /><Bar className="h-6 w-72 max-w-full" /></div>
        <Bar className="h-4 w-96 max-w-full" />
        <Bar className="h-10 w-80 max-w-full" />
      </div>
      <div className="mt-4 h-11 border-b border-border/60" />
      <FeedSkeleton />
    </div>
  )
}

export function CaptainPage({ route }: { route: Route }) {
  const project = useStore((s) => s.project)
  const summary = useStore((s) => s.captains.find((c) => c.agent.id === route.captain || c.agent.handle === route.captain))
  const loaded = useStore((s) => s.captainsLoaded)
  const agents = useStore((s) => s.agents)
  const cardsById = useStore((s) => s.cards)
  const id = summary?.agent.id
  const messages = useStore((s) => (id ? s.fleetMessages[id] : undefined))
  const [openCard, setOpenCard] = useState<number | null>(null)

  useEffect(() => {
    if (id) void useStore.getState().loadFleet(id).catch(() => {})
  }, [id])

  const fleet = useMemo(() => (id ? Object.values(agents).filter((a) => a.fleet_id === id || a.id === id) : []), [agents, id])
  const cards = useMemo(() => (id ? fleetCards(Object.values(cardsById), fleetIds(fleet, id)) : []), [cardsById, fleet, id])

  const go = (patch: { tab?: CaptainTab; agent?: string | null }, replace: boolean) =>
    navigate(captainHref(id ?? route.captain!, route.project, { tab: route.tab, agent: route.agent, ...patch }), replace)
  const setTab = (tab: CaptainTab) => go({ tab }, true)
  const openAgent = (agent: string) => go({ agent }, false)
  const closeAgent = () => go({ agent: null }, true)

  // 1 / 2 / 3 switch tabs when no field or dialog has the keys.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, [contenteditable], [role=dialog]')) return
      const tab = CAPTAIN_TABS[Number(e.key) - 1]
      if (tab) setTab(tab)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  if (!summary) {
    if (!loaded) return <PageSkeleton />
    return (
      <EmptyState
        title={`No captain ${route.captain?.startsWith('ag_') ? '' : '@'}${route.captain} in ${project}`}
        hint="It may be archived, renamed, or live in another project."
        action={{ label: 'All captains', href: href({ page: 'captains', project: route.project }) }}
      />
    )
  }

  const counts: Record<CaptainTab, number> = {
    activity: (messages ?? []).filter((m) => m.kind !== 'update').length,
    team: summary.fleet.total,
    cards: cards.length,
  }
  const sheetMessages = messages ?? []
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 space-y-2.5 px-4 pt-4 pb-3 sm:space-y-4 sm:px-8 sm:pt-7 sm:pb-5">
        <Header summary={summary} onRenamed={() => { if (route.captain !== summary.agent.id) go({}, true) }} />
        <div className="sm:pl-[52px]"><MetaLine summary={summary} /></div>
        <div className="pt-1 sm:pl-[52px]"><Stats summary={summary} /></div>
      </div>
      <Tabs tab={route.tab} counts={counts} onTab={setTab} />
      <div id="captain-panel" role="tabpanel" aria-labelledby={`tab-${route.tab}`} className="min-h-0 flex-1">
        {route.tab === 'activity' && <Activity summary={summary} fleet={fleet} messages={messages} onAgent={openAgent} onCard={setOpenCard} />}
        {route.tab === 'team' && <TeamTab summary={summary} fleet={fleet} selected={route.agent} onAgent={openAgent} />}
        {route.tab === 'cards' && <CardsTab cards={cards} agents={agents} onCard={setOpenCard} />}
      </div>
      <AgentSheet summary={summary} fleet={fleet} messages={sheetMessages} agentId={route.agent} onClose={closeAgent} onAgent={openAgent} onCard={setOpenCard} />
      <TicketSheet cardId={openCard} onClose={() => setOpenCard(null)} />
    </div>
  )
}
