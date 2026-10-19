// Pure event reducers: `reduce` applies one ServerEvent to the project's local data,
// `reduceGlobal` applies the global (project_id '*') events: catalog, doctor, resumes.
import type { Agent, Call, Card, DoctorRun, HarnessCatalog, MessageView, ProviderHealth, ResumeView, ServerEvent } from '@shared/types'
import type { ThreadRow } from './api'

export interface Data {
  project: string | null
  agents: Record<string, Agent>
  cards: Record<number, Card>
  threads: ThreadRow[]
  messages: Record<string, MessageView[]>   // loaded threads only
  lastCall: { agent_id: string; call: Call; at: number } | null
}

export const emptyData = (project: string | null = null): Data => ({
  project, agents: {}, cards: {}, threads: [], messages: {}, lastCall: null,
})

export function sortThreads(rows: ThreadRow[]): ThreadRow[] {
  return [...rows].sort((a, b) => (b.last?.created_at ?? 0) - (a.last?.created_at ?? 0))
}

export function appendMessage(list: MessageView[] | undefined, m: MessageView): MessageView[] | undefined {
  if (!list) return list
  if (list.some((x) => x.seq === m.seq)) return list
  const next = [...list, m]
  if (list.length && list[list.length - 1].seq > m.seq) next.sort((a, b) => a.seq - b.seq)
  return next
}

function membersOf(m: MessageView): string[] {
  const fromLabel = m.thread_label.match(/@[a-z][a-z0-9-]*/gi)?.map((h) => h.slice(1))
  return fromLabel ?? [m.from_handle, ...m.to_handles]
}

export function reduce(d: Data, ev: ServerEvent): Data {
  if (!d.project || ev.project_id === '*' || ev.project_id !== d.project) return d
  switch (ev.type) {
    case 'agent.updated':
      // Events carry the bare row; keep the `last_result` the read API gave us.
      return { ...d, agents: { ...d.agents, [ev.agent.id]: { ...ev.agent, last_result: ev.agent.last_result ?? d.agents[ev.agent.id]?.last_result ?? null } } }
    case 'card.updated':
      return { ...d, cards: { ...d.cards, [ev.card.id]: ev.card } }
    case 'call.started':
    case 'call.ended':
      return { ...d, lastCall: { agent_id: ev.call.agent_id, call: ev.call, at: Date.now() } }
    case 'message.created': {
      const m = ev.message
      if (m.kind === 'result' && d.agents[m.from_id]) {
        const status = m.meta?.status
        const last_result = { status: status === 'blocked' || status === 'failed' ? status : 'ok', text: m.text, at: m.created_at } as const
        d = { ...d, agents: { ...d.agents, [m.from_id]: { ...d.agents[m.from_id], last_result } } }
      }
      const loaded = d.messages[m.thread]
      const appended = appendMessage(loaded, m)
      const messages = appended === loaded ? d.messages : { ...d.messages, [m.thread]: appended! }
      if (loaded && appended === loaded) return d // duplicate
      const i = d.threads.findIndex((t) => t.thread === m.thread)
      let threads: ThreadRow[]
      if (i === -1) {
        threads = [...d.threads, { thread: m.thread, label: m.thread_label, members: membersOf(m), last: m, count: 1 }]
      } else {
        const t = d.threads[i]
        if (t.last && t.last.seq >= m.seq) return { ...d, messages }
        threads = d.threads.slice()
        threads[i] = { ...t, last: m, count: t.count + 1 }
      }
      return { ...d, messages, threads: sortThreads(threads) }
    }
    default:
      return d
  }
}

export interface GlobalData {
  catalogs: HarnessCatalog[]
  doctorRun: DoctorRun | null
  providers: ProviderHealth[]
  resumes: Record<string, ResumeView>
}

export function reduceGlobal(g: GlobalData, ev: ServerEvent): GlobalData {
  switch (ev.type) {
    case 'catalog.updated':
      return { ...g, catalogs: ev.catalogs }
    case 'doctor.updated':
      // An older run's late update must not replace the newer run.
      if (g.doctorRun && g.doctorRun.id !== ev.run.id && g.doctorRun.started_at > ev.run.started_at) return g
      return { ...g, doctorRun: ev.run }
    case 'provider.updated':
      return { ...g, providers: ev.providers }
    case 'resume.updated':
      return { ...g, resumes: { ...g.resumes, [ev.resume.slug]: ev.resume } }
    case 'resume.deleted': {
      if (!(ev.slug in g.resumes)) return g
      const resumes = { ...g.resumes }
      delete resumes[ev.slug]
      return { ...g, resumes }
    }
    default:
      return g
  }
}
