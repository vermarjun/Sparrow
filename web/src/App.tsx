import { useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { savedProject, useStore } from '@/lib/store'
import { useEvents } from '@/lib/events'
import { GLOBAL_PAGES, href, navigate, useRoute } from '@/lib/route'
import { useTheme } from '@/lib/theme'
import { Empty } from '@/components/sparrow/bits'
import { Sidebar } from '@/components/shell/Sidebar'
import { BoardPage } from '@/pages/Board'
import { CaptainsPage } from '@/pages/Captains'
import { CaptainPage } from '@/pages/Captain'
import { DoctorPage } from '@/pages/Doctor'
import { ResumesPage } from '@/pages/Resumes'
import { SkillsPage } from '@/pages/Skills'
import { SettingsPage } from '@/pages/Settings'

export type Boot = 'loading' | 'ok' | 'error'

export default function App() {
  const route = useRoute()
  const { dark } = useTheme()
  const projects = useStore((s) => s.projects)
  const project = useStore((s) => s.project)
  const [boot, setBoot] = useState<Boot>('loading')

  // Old pages (#/chat, #/agents) and unknown hashes land on the project home.
  useEffect(() => {
    if (route.redirected) navigate(href({ page: 'captains', project: route.project }), true)
  }, [route.redirected, route.project])

  useEffect(() => {
    const st = useStore.getState()
    void st.loadGlobals()
    st.loadProjects()
      .then((list) => {
        setBoot('ok')
        const want = route.project ?? savedProject()
        const pick = list.find((p) => p.id === want) ?? [...list].sort((a, b) => b.working - a.working || b.created_at - a.created_at)[0]
        if (pick) {
          useStore.getState().selectProject(pick.id)
          // unknown ?p= → rewrite the hash to the project actually shown
          if (route.project && route.project !== pick.id) navigate(href({ ...route, project: pick.id }), true)
        }
      })
      .catch(() => setBoot('error'))
    const t = setInterval(() => void useStore.getState().loadProjects().catch(() => {}), 15000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (route.project && route.project !== project && projects.some((p) => p.id === route.project)) useStore.getState().selectProject(route.project)
  }, [route.project, projects, project])

  useEvents(project)

  const global = GLOBAL_PAGES.includes(route.page)
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <Sidebar route={route} boot={boot} />
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {route.page === 'doctor' ? (
            <DoctorPage />
          ) : route.page === 'resumes' ? (
            <ResumesPage slug={route.slug} />
          ) : route.page === 'skills' ? (
            <SkillsPage name={route.slug} />
          ) : route.page === 'settings' ? (
            <SettingsPage />
          ) : global ? null : boot === 'error' ? (
            <Empty title="Can't reach the Sparrow server" className="h-full">
              Start it with <code className="rounded bg-muted px-1">sparrow up</code>, then reload. This page reads <code className="rounded bg-muted px-1">/api</code> on the same origin.
            </Empty>
          ) : boot === 'ok' && !projects.length ? (
            <Empty title="No projects yet" className="h-full">
              A project appears when a captain first runs the <code className="rounded bg-muted px-1">sparrow</code> CLI in a repo. Check your setup on the <a className="underline" href="#/doctor">Doctor</a> page.
            </Empty>
          ) : !project ? null : route.page === 'board' ? (
            <BoardPage />
          ) : route.page === 'captain' && route.captain ? (
            <CaptainPage key={route.captain} route={route} />
          ) : (
            <CaptainsPage route={route} />
          )}
        </main>
      </div>
      <Toaster position="bottom-right" theme={dark ? 'dark' : 'light'} />
    </TooltipProvider>
  )
}
