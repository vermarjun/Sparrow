import { create } from 'zustand'
import type { HarnessHealth, ServerEvent } from '@shared/types'
import { api, type ProjectRow } from './api'
import type { SkillsState } from './skills'
import { emptyData, reduce, reduceGlobal, sortThreads, type Data, type GlobalData } from './reduce'

export type Conn = 'connecting' | 'live' | 'down'
export type Tab = 'board' | 'chat' | 'agents' | 'doctor' | 'resumes' | 'skills'

interface Store extends Data, GlobalData {
  projects: ProjectRow[]
  health: HarnessHealth[]
  catalogLoaded: boolean
  doctorLoaded: boolean
  skills: SkillsState | null
  skillsError: string | null
  /** Bumps on every skills.updated event so open detail pages refetch. */
  skillsRev: number
  conn: Conn
  loading: boolean
  error: string | null
  setConn: (c: Conn) => void
  loadProjects: () => Promise<ProjectRow[]>
  loadResumes: () => Promise<void>
  loadCatalog: () => Promise<void>
  loadDoctor: () => Promise<void>
  loadSkills: () => Promise<void>
  loadGlobals: () => Promise<void>
  selectProject: (id: string) => void
  loadProject: () => Promise<void>
  loadThread: (thread: string) => Promise<void>
  apply: (ev: ServerEvent) => void
}

const LS_KEY = 'sparrow.project'

export const useStore = create<Store>((set, get) => ({
  ...emptyData(),
  projects: [],
  resumes: {},
  catalogs: [],
  doctorRun: null,
  providers: [],
  health: [],
  catalogLoaded: false,
  doctorLoaded: false,
  skills: null,
  skillsError: null,
  skillsRev: 0,
  conn: 'connecting',
  loading: false,
  error: null,
  setConn: (conn) => set({ conn }),
  async loadProjects() {
    const projects = await api.projects()
    set({ projects })
    return projects
  },
  async loadResumes() {
    try {
      const list = await api.resumes()
      set({ resumes: Object.fromEntries(list.map((r) => [r.slug, r])) })
    } catch { /* optional */ }
  },
  async loadCatalog() {
    try {
      set({ catalogs: await api.catalog(), catalogLoaded: true })
    } catch { /* server without U1: pages show their empty state */ }
  },
  async loadDoctor() {
    try {
      const { run, health, providers } = await api.doctor()
      set({ doctorRun: run, health, providers: providers ?? [], doctorLoaded: true })
    } catch { /* idem */ }
  },
  async loadSkills() {
    try {
      set({ skills: await api.skills(), skillsError: null })
    } catch (e) {
      set({ skillsError: (e as Error).message })
    }
  },
  async loadGlobals() {
    const s = get()
    // Skills load on first visit to the page; once loaded they stay fresh (reconnect + skills.updated).
    await Promise.all([s.loadResumes(), s.loadCatalog(), s.loadDoctor(), ...(s.skills ? [s.loadSkills()] : [])])
  },
  selectProject(id) {
    if (get().project === id) return
    try { localStorage.setItem(LS_KEY, id) } catch { /* private mode */ }
    set({ ...emptyData(id) })
  },
  async loadProject() {
    const project = get().project
    if (!project) return
    set({ loading: true, error: null })
    try {
      const [agents, cards, threads] = await Promise.all([api.agents(project), api.cards(project), api.threads(project)])
      if (get().project !== project) return
      // Keep already-open threads fresh too (missed events while disconnected).
      const loaded = Object.keys(get().messages)
      const msgs = await Promise.all(loaded.map((t) => api.messages(project, t).then((m) => [t, m] as const)))
      if (get().project !== project) return
      set({
        agents: Object.fromEntries(agents.map((a) => [a.id, a])),
        cards: Object.fromEntries(cards.map((c) => [c.id, c])),
        threads: sortThreads(threads),
        messages: Object.fromEntries(msgs),
        loading: false,
      })
    } catch (e) {
      set({ loading: false, error: (e as Error).message })
    }
  },
  async loadThread(thread) {
    const project = get().project
    if (!project) return
    const list = await api.messages(project, thread)
    if (get().project !== project) return
    set({ messages: { ...get().messages, [thread]: list } })
  },
  apply(ev) {
    const s = get()
    if (ev.project_id === '*') {
      const next = reduceGlobal(s, ev)
      if (next !== s) set(next)
      // A finished run changes health and resume statuses; neither travels on the event.
      if (ev.type === 'doctor.updated' && ev.run.ended_at && s.doctorRun?.ended_at !== ev.run.ended_at) {
        void get().loadDoctor()
        void get().loadResumes()
      }
      if (ev.type === 'catalog.updated') void get().loadResumes()
      if (ev.type === 'skills.updated') {
        set({ skillsRev: s.skillsRev + 1 })
        if (get().skills) void get().loadSkills()
      }
      return
    }
    const next = reduce(s, ev)
    if (next !== s) set(next)
  },
}))

export function savedProject(): string | null {
  try { return localStorage.getItem(LS_KEY) } catch { return null }
}
