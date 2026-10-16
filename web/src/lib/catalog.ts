// Pure helpers for the U1 pages: catalog-driven selects, doctor grouping, resume status (unit-tested in web/test).
import type {
  Agent, CatalogModel, CheckStatus, DoctorCheck, DoctorRun, HarnessCatalog, HarnessHealth, HarnessName, ResumeStatus, ResumeView,
} from '@shared/types'

export const HARNESSES = ['claude', 'codex', 'opencode'] as const satisfies readonly HarnessName[]
export type RealHarness = (typeof HARNESSES)[number]

/** Route of the resume editor; `NEW_SLUG` (not a valid slug) is the create form. */
export const NEW_SLUG = '_new'
export function resumeHref(slug: string | null) {
  return slug ? `#/resumes/${encodeURIComponent(slug)}` : '#/resumes'
}

export const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/

export function slugError(slug: string): string | null {
  if (!slug) return 'slug is required'
  if (!SLUG_RE.test(slug)) return 'slug: lowercase letters, digits and dashes, starting with a letter (max 32)'
  return null
}

// ---------------------------------------------------------------- resume status

export const STATUS_CHIP: Record<ResumeStatus, { label: string; cls: string }> = {
  ok: { label: 'ok', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  harness_missing: { label: 'harness missing', cls: 'bg-red-50 text-red-700 border-red-200' },
  harness_logged_out: { label: 'logged out', cls: 'bg-red-50 text-red-700 border-red-200' },
  harness_broken: { label: 'harness broken', cls: 'bg-red-50 text-red-700 border-red-200' },
  model_gone: { label: 'model gone', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  effort_invalid: { label: 'effort invalid', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  unchecked: { label: 'unchecked', cls: 'bg-zinc-50 text-zinc-600 border-zinc-200' },
}

/** Agent was hired from (or last applied) an older copy of its resume. Unknown hashes are not "older". */
export function isOlderResume(a: Pick<Agent, 'resume_hash' | 'kind' | 'state'>, r: Pick<ResumeView, 'hash'> | undefined): boolean {
  if (a.kind === 'human' || a.state === 'retired' || !r || !a.resume_hash) return false
  return a.resume_hash !== r.hash
}

/** "claude · opus · high" from an agent's last run; null when it never ran. */
export function runLabel(run: Agent['last_run']): string | null {
  if (!run) return null
  return [run.harness, run.model ?? 'default model', run.effort].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------- harness availability

export interface Availability { disabled: boolean; reason: string | null }

/** Why a harness can't be picked in the resume editor (catalog failed, or the doctor said missing / logged out). */
export function harnessAvailability(h: HarnessName, catalogs: HarnessCatalog[], health: HarnessHealth[]): Availability {
  const hh = health.find((x) => x.harness === h)
  if (hh?.installed === false) return { disabled: true, reason: `not installed${hh.fix ? ` — ${hh.fix}` : ''}` }
  if (hh?.logged_in === false) return { disabled: true, reason: `logged out${hh.fix ? ` — ${hh.fix}` : ''}` }
  const c = catalogs.find((x) => x.harness === h)
  if (c && !c.ok) return { disabled: true, reason: `model list failed${c.error ? ` — ${c.error}` : ''}` }
  return { disabled: false, reason: null }
}

/** No catalog entry yet: the server is still fetching it (fills in on catalog.updated). Not a failure. */
export function modelsLoading(h: HarnessName, catalogs: HarnessCatalog[]): boolean {
  return !catalogs.some((c) => c.harness === h)
}

/** One-word health verdict for a harness card. */
export function healthVerdict(h: HarnessHealth | undefined): { label: string; tone: 'ok' | 'bad' | 'warn' | 'none' } {
  if (!h || h.checked_at == null) return { label: 'not checked', tone: 'none' }
  if (h.installed === false) return { label: 'not installed', tone: 'bad' }
  if (h.logged_in === false) return { label: 'logged out', tone: 'bad' }
  if (h.working === false) return { label: 'round trip failed', tone: 'bad' }
  if (h.working === true) return { label: 'working', tone: 'ok' }
  return { label: 'partly checked', tone: 'warn' }
}

// ---------------------------------------------------------------- model / effort options

export interface ModelOption { value: string; label: string; hint: string | null; hidden: boolean; gone: boolean }

export function costLabel(cost: CatalogModel['cost']): string | null {
  if (!cost) return null
  if (cost.input === 0 && cost.output === 0) return 'free'
  const f = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
  return `${f(cost.input)} / ${f(cost.output)} per 1M`
}

/**
 * Options for the model select: visible models first (catalog order), hidden models last.
 * A current value missing from the catalog is kept as a "gone" option so it stays visible.
 */
export function modelOptions(catalog: HarnessCatalog | undefined, current: string | null): ModelOption[] {
  const models = catalog?.models ?? []
  const opt = (m: CatalogModel): ModelOption => {
    const hint = [m.resolves_to ? `→ ${m.resolves_to}` : null, catalog?.harness === 'opencode' ? costLabel(m.cost) : null].filter(Boolean).join(' · ')
    return { value: m.id, label: m.label && m.label !== m.id ? `${m.id} — ${m.label}` : m.id, hint: hint || null, hidden: m.hidden, gone: false }
  }
  const out = [...models.filter((m) => !m.hidden).map(opt), ...models.filter((m) => m.hidden).map(opt)]
  if (current && !findModel(catalog, current)) out.unshift({ value: current, label: current, hint: 'not in the catalog', hidden: false, gone: true })
  else if (current && !models.some((m) => m.id === current)) {
    // a full id that an alias resolves to (e.g. 'claude-opus-5-5' for 'opus'): keep it selectable as itself
    const alias = findModel(catalog, current)!
    out.unshift({ value: current, label: current, hint: `same model as ${alias.id}`, hidden: false, gone: false })
  }
  return out
}

/** Find a model by id, Claude alias resolution included ('claude-opus-5-5' finds 'opus'). */
export function findModel(catalog: HarnessCatalog | undefined, id: string | null): CatalogModel | undefined {
  if (!catalog || !id) return undefined
  return catalog.models.find((m) => m.id === id) ?? catalog.models.find((m) => m.resolves_to === id)
}

/** Model is "gone" only when the catalog loaded fine and does not list it. */
export function modelGone(catalog: HarnessCatalog | undefined, id: string | null): boolean {
  return !!id && !!catalog?.ok && !findModel(catalog, id)
}

export interface EffortChoice { efforts: string[]; disabled: boolean; note: string | null; invalid: boolean }

/** Effort options for the chosen model. Unknown model (gone / harness default) = free text not allowed: keep current only. */
export function effortChoice(catalog: HarnessCatalog | undefined, model: string | null, current: string | null): EffortChoice {
  const m = findModel(catalog, model)
  if (!m) {
    // Harness default or a gone model: show the efforts the catalog uses everywhere if they agree (Claude), else nothing.
    const sets = new Set((catalog?.models ?? []).map((x) => x.efforts.join(',')))
    const shared = sets.size === 1 ? (catalog!.models[0].efforts) : []
    return { efforts: shared, disabled: shared.length === 0 && !current, note: shared.length ? null : 'pick a model to see its effort levels', invalid: !!current && shared.length > 0 && !shared.includes(current) }
  }
  if (m.efforts.length === 0) return { efforts: [], disabled: true, note: 'no effort levels', invalid: !!current }
  return { efforts: m.efforts, disabled: false, note: null, invalid: !!current && !m.efforts.includes(current) }
}

/** After a model change: keep the effort when the new model accepts it, else fall back to its default (or none). */
export function effortAfterModelChange(catalog: HarnessCatalog | undefined, model: string | null, effort: string | null): string | null {
  const m = findModel(catalog, model)
  if (!m) return effort
  if (effort && m.efforts.includes(effort)) return effort
  return m.default_effort && m.efforts.includes(m.default_effort) ? m.default_effort : null
}

// ---------------------------------------------------------------- doctor

export const CHECK_DOT: Record<CheckStatus, string> = {
  pending: 'bg-zinc-300',
  running: 'bg-sky-500 animate-pulse',
  pass: 'bg-emerald-500',
  warn: 'bg-amber-400',
  fail: 'bg-red-500',
  skipped: 'bg-zinc-200 ring-1 ring-zinc-300',
}

export interface CheckGroups { shared: DoctorCheck[]; byHarness: Record<RealHarness, DoctorCheck[]> }

export function groupChecks(run: DoctorRun | null): CheckGroups {
  const out: CheckGroups = { shared: [], byHarness: { claude: [], codex: [], opencode: [] } }
  for (const c of run?.checks ?? []) {
    if (c.harness === null) out.shared.push(c)
    else if (c.harness in out.byHarness) out.byHarness[c.harness as RealHarness].push(c)
  }
  return out
}

export function countByStatus(checks: DoctorCheck[]): Partial<Record<CheckStatus, number>> {
  const out: Partial<Record<CheckStatus, number>> = {}
  for (const c of checks) out[c.status] = (out[c.status] ?? 0) + 1
  return out
}

/** "12 pass · 1 warn · 2 fail" in a fixed order, zeros left out. */
export function summarizeChecks(checks: DoctorCheck[]): string {
  const n = countByStatus(checks)
  const order: CheckStatus[] = ['running', 'pending', 'pass', 'warn', 'fail', 'skipped']
  return order.filter((s) => n[s]).map((s) => `${n[s]} ${s}`).join(' · ')
}

/** "effort: xhigh is not…" → "xhigh is not…" (the field is already named by where the message is shown). */
export function stripField(msg: string, field: string): string {
  return msg.replace(new RegExp(`^${field}(?:\\.[a-z_]+)?\\s*:\\s*`, 'i'), '')
}

/** Error text from the server, mapped to the editor field it names (400s name the field), else null. */
const FIELDS = ['slug', 'title', 'description', 'harness', 'model', 'effort', 'can_hire', 'limits', 'body'] as const
export type ResumeField = (typeof FIELDS)[number]
export function errorField(msg: string): ResumeField | null {
  const lower = msg.toLowerCase()
  const head = lower.match(/^([a-z_]+)(?:\.[a-z_]+)?\s*[:=]/)?.[1]
  if (head && (FIELDS as readonly string[]).includes(head)) return head as ResumeField
  if (/quiet_minutes|max_call_minutes|limits/.test(lower)) return 'limits'
  for (const f of FIELDS) if (new RegExp(`\\b${f}\\b`).test(lower)) return f
  return null
}
