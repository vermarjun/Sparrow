import { create } from 'zustand'
import type { Resume, ServerEvent } from '@shared/types'
import { api, type ProjectRow } from './api'
import { emptyData, reduce, sortThreads, type Data } from './reduce'

export type Conn = 'connecting' | 'live' | 'down'
export type Tab = 'board' | 'chat' | 'agents'

interface Store extends Data {
  projects: ProjectRow[]
  resumes: Record<string, Resume>
  conn: Conn
  loading: boolean
  error: string | null
  setConn: (c: Conn) => void
  loadProjects: () => Promise<ProjectRow[]>
  loadResumes: () => Promise<void>
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
    const next = reduce(s, ev)
    if (next !== s) set(next)
  },
}))

export function savedProject(): string | null {
  try { return localStorage.getItem(LS_KEY) } catch { return null }
}
