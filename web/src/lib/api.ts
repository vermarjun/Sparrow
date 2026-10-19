// Tiny fetch-JSON helper. Same origin in production (the Sparrow server serves web/dist);
// in dev, Vite proxies /api to VITE_API (default http://127.0.0.1:4040).
import type { SkillMatrix } from './skillMatrix'
import type { MigApplyResult, MigBackupInfo, MigPlan, MigRollbackResult } from './migration'
import type { GitState, Harness, LibrarySkill, LinkAction, SkillDetail, SkillUpdate, SkillsState, StagedImport } from './skills'
import type {
  Agent, CaptainStartReq, CaptainStartRes, Call, Card, CardCreateReq, CardPatchReq, DoctorCheck, DoctorRun, HarnessCatalog,
  HarnessHealth, MessageView, Project, ProviderHealth, ResumeView, ResumeWriteReq, SettingsView, SettingsWriteReq,
} from '@shared/types'

export type ProjectRow = Project & { agents: number; working: number; cards: number }
export interface ThreadRow { thread: string; label: string; members: string[]; last: MessageView | null; count: number }
export interface AgentDetail { agent: Agent; calls: Call[]; children: Agent[] }
export interface Screen { text: string; live: boolean; at: number | null }

export interface DoctorState { run: DoctorRun | null; health: HarnessHealth[]; providers?: ProviderHealth[] }

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const multipart = typeof FormData !== 'undefined' && body instanceof FormData
  const res = await fetch(path, {
    method,
    headers: body === undefined || multipart ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
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
  settings: () => req<SettingsView>('GET', '/api/settings'),
  updateSettings: (body: SettingsWriteReq) => req<SettingsView>('PUT', '/api/settings', body),
  runDoctor: () => req<{ run: DoctorRun }>('POST', '/api/doctor/run'),
  skills: () => req<SkillsState>('GET', '/api/skills'),
  skillsMatrix: () => req<SkillMatrix>('GET', '/api/skills/matrix'),
  /** One atomic grant/remove on the server (edits only the resume's skills: line). */
  setMatrixSkill: (slug: string, skill: string, on: boolean) => req<{ resume: ResumeView }>('POST', '/api/skills/matrix', { slug, skill, on }),
  skill: (name: string) => req<SkillDetail>('GET', `/api/skills/${encodeURIComponent(name)}`),
  skillDiff: (name: string, path: string) => req<{ diff: string; truncated?: boolean }>('GET', `/api/skills/${encodeURIComponent(name)}/diff${q({ path })}`),
  setSkillHarnesses: (name: string, harnesses: Harness[]) =>
    req<{ skill: LibrarySkill; actions: LinkAction[]; conflicts: LinkAction[] }>('PUT', `/api/skills/${encodeURIComponent(name)}/harnesses`, { harnesses }),
  syncSkills: () => req<{ actions: LinkAction[]; conflicts: LinkAction[] }>('POST', '/api/skills/sync'),
  adoptSkill: (path: string) => req<{ skill: LibrarySkill; backup: string | null }>('POST', '/api/skills/adopt', { path }),
  resolveConflict: (path: string, keep: 'library' | 'entry') =>
    req<{ skill: LibrarySkill; backup: string }>('POST', '/api/skills/conflicts/resolve', { path, keep }),
  initSkillsLibrary: () => req<SkillsState>('POST', '/api/skills/library/init'),
  createSkill: (body: { name: string; description: string; harnesses: Harness[] }) =>
    req<{ skill: { name: string; description: string; harnesses: Harness[] } }>('POST', '/api/skills', body),
  uploadSkills: (form: FormData) => req<{ staged: StagedImport }>('POST', '/api/skills/upload', form),
  previewSkillSource: (source: string) => req<{ staged: StagedImport }>('POST', '/api/skills/import/preview', { source }),
  importSkills: (staged_id: string, skills: string[], harnesses: Harness[]) =>
    req<{ skills: { name: string; harnesses: Harness[] }[]; actions: LinkAction[]; conflicts: LinkAction[] }>(
      'POST', '/api/skills/import', { staged_id, skills, harnesses },
    ),
  skillUpdates: () => req<SkillUpdate[]>('POST', '/api/skills/updates'),
  migrationPlan: () => req<MigPlan>('POST', '/api/skills/migration/plan'),
  migrationDiff: (name: string, a: string, b: string) => req<{ diff: string; truncated?: boolean }>('GET', `/api/skills/migration/diff${q({ name, a, b })}`),
  migrationBackups: () => req<MigBackupInfo[]>('GET', '/api/skills/migration/backups'),
  migrationApply: (plan_id: string, choices: Record<string, string>) =>
    req<MigApplyResult>('POST', '/api/skills/migration/apply', { plan_id, choices, confirm: 'migrate' }),
  migrationRollback: (backup_id: string) => req<MigRollbackResult>('POST', '/api/skills/migration/rollback', { backup_id, confirm: 'rollback' }),
  skillsGit: () => req<GitState>('GET', '/api/skills/git'),
  pullSkills: () => req<GitState & { output: string }>('POST', '/api/skills/git/pull'),
  commitSkills: (message: string, push: boolean) => req<GitState>('POST', '/api/skills/git/commit', { message, push }),
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
