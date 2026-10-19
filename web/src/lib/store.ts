import { create } from 'zustand'
import type { CaptainInfo, CaptainPatchReq, CaptainStartRes, HarnessHealth, ServerEvent } from '@shared/types'
import { api, type ProjectRow } from './api'
import type { SkillsState } from './skills'
import { emptyData, reduce, reduceGlobal, sortThreads, type Data, type GlobalData } from './reduce'

export type Conn = 'connecting' | 'live' | 'down'

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
  /** GET /api/captains (archived included). */
  loadCaptains: () => Promise<void>
  /** Debounced loadCaptains (~400 ms), called on agent/message/call events of the current project (§5). */
  scheduleCaptains: () => void
  /** Load (or refresh) one fleet's activity into fleetMessages[captainId]. */
  loadFleet: (captainId: string) => Promise<void>
  /** PATCH /api/captains/:id, applied optimistically to the summary; rolls back and rethrows on error. */
  patchCaptain: (id: string, patch: CaptainPatchReq) => Promise<void>
  /** POST /api/captains/:id/resume; refreshes the list. Errors (409 open window, 400 non-Claude) are rethrown as HttpError. */
  resumeCaptain: (id: string) => Promise<CaptainStartRes>
  apply: (ev: ServerEvent) => void
}

const LS_KEY = 'sparrow.project'
let captainsTimer: ReturnType<typeof setTimeout> | null = null

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
      const [agents, cards, threads, captains] = await Promise.all([
        api.agents(project), api.cards(project), api.threads(project), api.captains(project).catch(() => null),
      ])
      if (get().project !== project) return
      // Keep already-open threads and fleets fresh too (missed events while disconnected).
      const loaded = Object.keys(get().messages)
      const fleets = Object.keys(get().fleetMessages)
      const [msgs, fleetMsgs] = await Promise.all([
        Promise.all(loaded.map((t) => api.messages(project, t).then((m) => [t, m] as const))),
        Promise.all(fleets.map((f) => api.fleetMessages(project, f).then((m) => [f, m] as const).catch(() => [f, get().fleetMessages[f]] as const))),
      ])
      if (get().project !== project) return
      set({
        agents: Object.fromEntries(agents.map((a) => [a.id, a])),
        cards: Object.fromEntries(cards.map((c) => [c.id, c])),
        threads: sortThreads(threads),
        messages: Object.fromEntries(msgs),
        fleetMessages: Object.fromEntries(fleetMsgs),
        ...(captains ? { captains, captainsLoaded: true } : {}),
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
  async loadCaptains() {
    const project = get().project
    if (!project) return
    try {
      const captains = await api.captains(project)
      if (get().project === project) set({ captains, captainsLoaded: true })
    } catch { /* keep the last list; the conn dot shows trouble */ }
  },
  scheduleCaptains() {
    if (captainsTimer) clearTimeout(captainsTimer)
    captainsTimer = setTimeout(() => { captainsTimer = null; void get().loadCaptains() }, 400)
  },
  async loadFleet(captainId) {
    const project = get().project
    if (!project) return
    const list = await api.fleetMessages(project, captainId)
    if (get().project !== project) return
    set({ fleetMessages: { ...get().fleetMessages, [captainId]: list } })
  },
  async patchCaptain(id, patch) {
    const before = get().captains
    const agentBefore = get().agents[id]
    const edit = <T extends { handle: string; captain: CaptainInfo | null }>(a: T): T => ({
      ...a,
      ...(patch.name !== undefined ? { handle: patch.name } : {}),
      captain: a.captain && {
        ...a.captain,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.archived !== undefined ? { archived_at: patch.archived ? Date.now() : null } : {}),
      },
    })
    set({
      captains: before.map((c) => (c.agent.id === id ? { ...c, agent: edit(c.agent), ...(patch.archived ? { status: 'archived' as const } : {}) } : c)),
      ...(agentBefore ? { agents: { ...get().agents, [id]: edit(agentBefore) } } : {}),
    })
    try {
      const { agent } = await api.patchCaptain(id, patch)
      set({ agents: { ...get().agents, [id]: { ...agent, last_result: agent.last_result ?? null } } })
      get().scheduleCaptains()
    } catch (e) {
      set({ captains: before, ...(agentBefore ? { agents: { ...get().agents, [id]: agentBefore } } : {}) })
      throw e
    }
  },
  async resumeCaptain(id) {
    const res = await api.resumeCaptain(id)
    get().scheduleCaptains()
    return res
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
    if (ev.project_id === s.project && (ev.type === 'agent.updated' || ev.type === 'message.created' || ev.type === 'call.started' || ev.type === 'call.ended')) {
      get().scheduleCaptains()
    }
  },
}))

export function savedProject(): string | null {
  try { return localStorage.getItem(LS_KEY) } catch { return null }
}
