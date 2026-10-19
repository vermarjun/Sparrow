import { useEffect, useState } from 'react'
import { Bird, FileText, KanbanSquare, Library, MessagesSquare, Network, SlidersHorizontal, Stethoscope } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { plural } from '@/lib/format'
import { savedProject, useStore, type Tab } from '@/lib/store'
import { useEvents } from '@/lib/events'
import { Empty } from '@/components/sparrow/bits'
import { BoardPage } from '@/pages/Board'
import { ChatPage } from '@/pages/Chat'
import { AgentsPage } from '@/pages/Agents'
import { DoctorPage } from '@/pages/Doctor'
import { ResumesPage } from '@/pages/Resumes'
import { SkillsPage } from '@/pages/Skills'
import { SettingsPage } from '@/pages/Settings'
import { StartCaptainButton } from '@/components/sparrow/StartCaptain'

const TABS: { id: Tab; label: string; icon: typeof Bird }[] = [
  { id: 'board', label: 'Board', icon: KanbanSquare },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'agents', label: 'Agents', icon: Network },
]
// Global pages: render outside the project gate (work with zero projects).
const GLOBAL_TABS: { id: Tab; label: string; icon: typeof Bird }[] = [
  { id: 'resumes', label: 'Resumes', icon: FileText },
  { id: 'skills', label: 'Skills', icon: Library },
  { id: 'doctor', label: 'Doctor', icon: Stethoscope },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
]
const isGlobal = (t: Tab) => t === 'doctor' || t === 'resumes' || t === 'skills' || t === 'settings'

// Hash route: #/<tab>[/<slug>]  (project is remembered in localStorage and in ?p= for sharing)
function readHash(hash = location.hash): { tab: Tab; project: string | null; slug: string | null } {
  const [path, query] = hash.replace(/^#\/?/, '').split('?')
  const [head, ...rest] = path.split('/')
  const tab = ([...TABS, ...GLOBAL_TABS].find((t) => t.id === head)?.id ?? 'board') as Tab
  const project = new URLSearchParams(query ?? '').get('p')
  const slug = (tab === 'resumes' || tab === 'skills') && rest[0] ? decodeURIComponent(rest[0]) : null
  return { tab, project, slug }
}

// The page follows the `dark` class on <html> (shadcn tokens); the toaster has to match it.
function useDark() {
  const read = () => document.documentElement.classList.contains('dark')
  const [dark, setDark] = useState(read)
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

function useRoute() {
  const [route, setRoute] = useState(readHash)
  useEffect(() => {
    const on = () => setRoute(readHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = (tab: Tab, project: string | null) => {
    location.hash = `/${tab}${project ? `?p=${encodeURIComponent(project)}` : ''}`
  }
  return { ...route, go }
}

export default function App() {
  const { tab, project: hashProject, slug, go } = useRoute()
  const dark = useDark()
  const projects = useStore((s) => s.projects)
  const project = useStore((s) => s.project)
  const conn = useStore((s) => s.conn)
  const agents = useStore((s) => s.agents)
  const [boot, setBoot] = useState<'loading' | 'ok' | 'error'>('loading')

  useEffect(() => {
    const st = useStore.getState()
    void st.loadGlobals()
    st.loadProjects()
      .then((list) => {
        setBoot('ok')
        const want = hashProject ?? savedProject()
        const pick = list.find((p) => p.id === want) ?? [...list].sort((a, b) => b.working - a.working || b.created_at - a.created_at)[0]
        if (pick) {
          useStore.getState().selectProject(pick.id)
          // unknown ?p= → rewrite the hash to the project actually shown
          if (hashProject && hashProject !== pick.id) history.replaceState(null, '', `${location.hash.split('?')[0] || '#/board'}?p=${encodeURIComponent(pick.id)}`)
        }
      })
      .catch(() => setBoot('error'))
    const t = setInterval(() => void useStore.getState().loadProjects().catch(() => {}), 15000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (hashProject && hashProject !== project && projects.some((p) => p.id === hashProject)) useStore.getState().selectProject(hashProject)
  }, [hashProject, projects, project])

  useEvents(project)

  const working = Object.values(agents).filter((a) => a.state === 'working').length
  const connLabel = conn === 'live' ? 'live' : conn === 'connecting' ? 'connecting…' : 'offline — retrying'

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-muted/40 text-foreground">
        <header className="flex h-12 shrink-0 items-center gap-4 border-b bg-background px-4">
          <div className="flex items-center gap-1.5 font-semibold tracking-tight">
            <Bird className="size-4.5 text-amber-600" />
            Sparrow
          </div>
          <Select value={project ?? undefined} onValueChange={(v) => { useStore.getState().selectProject(v); go(tab, v) }}>
            <SelectTrigger size="sm" className="h-7 min-w-40 text-[13px]" aria-label="Project">
              <SelectValue placeholder={boot === 'loading' ? 'Loading…' : 'No projects'} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <nav className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {[...TABS, null, ...GLOBAL_TABS].map((t, i) => t === null ? <span key={`sep${i}`} className="mx-0.5 h-4 w-px bg-border" /> : (
              <button
                key={t.id}
                onClick={() => go(t.id, project)}
                data-tab={t.id}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                  tab === t.id && 'bg-background text-foreground shadow-sm',
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            <StartCaptainButton />
            {project && !isGlobal(tab) && <span>{working} working · {plural(Object.values(agents).filter((a) => a.kind !== 'human' && a.state !== 'retired').length, 'agent')}</span>}
            <span className="flex items-center gap-1.5" title={`Live updates: ${connLabel}`}>
              <span className={cn('size-2 rounded-full', conn === 'live' ? 'bg-emerald-500' : conn === 'connecting' ? 'bg-amber-400' : 'bg-red-500')} />
              {connLabel}
            </span>
          </div>
        </header>
        <main className="min-h-0 flex-1">
          {tab === 'doctor' ? (
            <DoctorPage />
          ) : tab === 'resumes' ? (
            <ResumesPage slug={slug} />
          ) : tab === 'skills' ? (
            <SkillsPage name={slug} />
          ) : tab === 'settings' ? (
            <SettingsPage />
          ) : boot === 'error' ? (
            <Empty title="Can't reach the Sparrow server" className="h-full">
              Start it with <code className="rounded bg-muted px-1">sparrow up</code>, then reload. This page reads <code className="rounded bg-muted px-1">/api</code> on the same origin.
            </Empty>
          ) : boot === 'ok' && !projects.length ? (
            <Empty title="No projects yet" className="h-full">
              A project appears when a captain first runs the <code className="rounded bg-muted px-1">sparrow</code> CLI in a repo, e.g. <code className="rounded bg-muted px-1">sparrow hire builder "…"</code>. Use <b>Start captain</b> above to open one, or check your setup on the <a className="underline" href="#/doctor">Doctor</a> page.
            </Empty>
          ) : !project ? null : tab === 'board' ? (
            <BoardPage />
          ) : tab === 'chat' ? (
            <ChatPage key={project} />
          ) : (
            <AgentsPage />
          )}
        </main>
      </div>
      <Toaster position="bottom-right" theme={dark ? 'dark' : 'light'} />
    </TooltipProvider>
  )
}
