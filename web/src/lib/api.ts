// Tiny fetch-JSON helper. Same origin in production (the Sparrow server serves web/dist);
// in dev, Vite proxies /api to VITE_API (default http://127.0.0.1:4040).
import type {
  Agent, CaptainStartReq, CaptainStartRes, Call, Card, CardCreateReq, CardPatchReq, DoctorCheck, DoctorRun, HarnessCatalog,
  HarnessHealth, MessageView, Project, ResumeView, ResumeWriteReq,
} from '@shared/types'

export type ProjectRow = Project & { agents: number; working: number; cards: number }
export interface ThreadRow { thread: string; label: string; members: string[]; last: MessageView | null; count: number }
export interface AgentDetail { agent: Agent; calls: Call[]; children: Agent[] }
export interface Screen { text: string; live: boolean; at: number | null }

export interface DoctorState { run: DoctorRun | null; health: HarnessHealth[] }

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { error: text } }
  if (!res.ok) throw new HttpError(res.status, data?.error ?? `${method} ${path} → ${res.status}`)
  return data as T
}

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

export const api = {
  health: () => req<{ ok: boolean; version: string }>('GET', '/api/health'),
  projects: () => req<ProjectRow[]>('GET', '/api/projects'),
  resumes: () => req<ResumeView[]>('GET', '/api/resumes'),
  resume: (slug: string) => req<ResumeView>('GET', `/api/resumes/${encodeURIComponent(slug)}`),
  createResume: (body: ResumeWriteReq) => req<ResumeView>('POST', '/api/resumes', body),
  updateResume: (slug: string, body: ResumeWriteReq) => req<ResumeView>('PUT', `/api/resumes/${encodeURIComponent(slug)}`, body),
  deleteResume: (slug: string) => req<{ ok: true }>('DELETE', `/api/resumes/${encodeURIComponent(slug)}`),
  duplicateResume: (slug: string, to: string) => req<ResumeView>('POST', `/api/resumes/${encodeURIComponent(slug)}/duplicate`, { slug: to }),
  applyResume: (slug: string) => req<{ updated: string[] }>('POST', `/api/resumes/${encodeURIComponent(slug)}/apply`),
  testResume: (slug: string) => req<{ check: DoctorCheck }>('POST', `/api/resumes/${encodeURIComponent(slug)}/test`),
  resumeTest: (slug: string) => req<DoctorCheck>('GET', `/api/resumes/${encodeURIComponent(slug)}/test`),
  catalog: () => req<HarnessCatalog[]>('GET', '/api/catalog'),
  refreshCatalog: () => req<HarnessCatalog[]>('POST', '/api/catalog/refresh'),
  doctor: () => req<DoctorState>('GET', '/api/doctor'),
  runDoctor: () => req<{ run: DoctorRun }>('POST', '/api/doctor/run'),
  captainRecent: () => req<string[]>('GET', '/api/captain/recent'),
  startCaptain: (body: CaptainStartReq) => req<CaptainStartRes>('POST', '/api/captain/start', body),
  agents: (project: string) => req<Agent[]>('GET', `/api/agents${q({ project })}`),
  agent: (id: string) => req<AgentDetail>('GET', `/api/agents/${encodeURIComponent(id)}`),
  screen: (id: string, lines = 200) => req<Screen>('GET', `/api/agents/${encodeURIComponent(id)}/screen${q({ lines })}`),
  threads: (project: string) => req<ThreadRow[]>('GET', `/api/threads${q({ project })}`),
  messages: (project: string, thread: string, after?: number, limit = 500) =>
    req<MessageView[]>('GET', `/api/messages${q({ project, thread, after, limit })}`),
  cards: (project: string) => req<Card[]>('GET', `/api/cards${q({ project })}`),
  createCard: (project: string, body: CardCreateReq) =>
    req<{ card: Card }>('POST', '/api/cards', { ...body, project }),
  patchCard: (id: number, body: CardPatchReq) => req<{ card: Card }>('PATCH', `/api/cards/${id}`, body),
}
