// U1 mock endpoints: model catalog, doctor, editable resumes, captain launcher.
// Data mirrors the contract facts measured on 17 Oct 2026 (real ids and versions).
// The doctor run is simulated over ~MOCK_DOCTOR_MS (default 8 s) with doctor.updated events:
// Claude passes, Codex passes on a new version ("re-verified"), OpenCode is logged out; skills warns.
import type {
  Agent, CaptainStartReq, CaptainStartRes, CatalogModel, DoctorCheck, DoctorRun, HarnessCatalog, HarnessHealth, HarnessName,
  ResumeStatus, ResumeView, ResumeWriteReq, ServerEvent, SettingField, SettingsView,
} from '../../src/shared/types'

const SETTINGS: Omit<SettingField, 'value' | 'saved' | 'env_override'>[] = [
  { key: 'max_running', group: 'Capacity', label: 'Running slots', unit: 'agents', min: 1, max: 50, default: 3, help: 'Agents that may work at the same time across all projects.' },
  { key: 'max_depth', group: 'Capacity', label: 'Depth limit', unit: 'levels', min: 1, max: 10, default: 3, help: 'How deep the hiring tree may grow; you are level 0.' },
  { key: 'quiet_minutes', group: 'Call limits', label: 'Quiet nudge', unit: 'minutes', min: 1, max: 240, default: 15, help: 'A silent working agent is nudged after this long.' },
  { key: 'max_call_minutes', group: 'Call limits', label: 'Long call notice', unit: 'minutes', min: 1, max: 1440, default: 90, help: 'The parent is told when one call runs this long.' },
  { key: 'close_grace_ms', group: 'Timing', label: 'Window close grace', unit: 'ms', min: 0, max: 120000, default: 8000, help: 'Delay between a report and closing the window.' },
]

const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/
const HOME = '/Users/vermarjun'

// ---------------------------------------------------------------- catalog
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const M = (m: Partial<CatalogModel> & Pick<CatalogModel, 'id'>): CatalogModel => ({
  label: m.id, efforts: [], default_effort: null, hidden: false, cost: null, resolves_to: null, description: null, ...m,
})

export function seedCatalogs(now: number): HarnessCatalog[] {
  const claude = (alias: string, full: string, label: string) =>
    M({ id: alias, label, efforts: CLAUDE_EFFORTS, resolves_to: full })
  const codexEfforts = ['low', 'medium', 'high', 'xhigh']
  return [
    {
      harness: 'claude', ok: true, error: null, version: '2.1.302', binary: `${HOME}/.local/bin/claude`, fetched_at: now - 4 * 60_000,
      models: [
        claude('fable', 'claude-fable-5-1', 'Fable 5.1'),
        claude('opus', 'claude-opus-5-5', 'Opus 5.5'),
        claude('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5'),
        claude('haiku', 'claude-haiku-5-5', 'Haiku 5.5'),
        claude('claude-opus-5-5[1m]', 'claude-opus-5-5[1m]', 'Opus 5.5 (1M context)'),
      ],
    },
    {
      harness: 'codex', ok: true, error: null, version: '0.162.1', binary: '/opt/homebrew/bin/codex', fetched_at: now - 4 * 60_000,
      models: [
        M({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: codexEfforts, default_effort: 'medium', description: 'Latest frontier agentic coding model.' }),
        M({ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: codexEfforts, default_effort: 'medium', description: 'Strong general model for long tasks.' }),
        M({ id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium', 'high'], default_effort: 'low', description: 'Affordable, fast model for simple tasks.' }),
        M({ id: 'gpt-5.5', label: 'GPT-5.5', efforts: codexEfforts, default_effort: 'medium', hidden: true, description: 'Previous generation.' }),
        M({ id: 'codex-auto-review', label: 'Codex auto review', efforts: ['low'], default_effort: 'low', hidden: true }),
      ],
    },
    {
      harness: 'opencode', ok: true, error: null, version: '1.19.0', binary: '/opt/homebrew/bin/opencode', fetched_at: now - 4 * 60_000,
      models: [
        M({ id: 'opencode-go/glm-5.3', label: 'GLM-5.3', cost: { input: 0.6, output: 2.2 } }),
        M({ id: 'opencode/glm-5.1', label: 'GLM-5.1', cost: { input: 0.45, output: 1.8 } }),
        M({ id: 'opencode/kimi-k3', label: 'Kimi K3', efforts: ['low', 'medium', 'high'], default_effort: 'medium', cost: { input: 0.6, output: 2.5 } }),
        M({ id: 'opencode-go/deepseek-v4', label: 'DeepSeek V4', efforts: ['minimal', 'low', 'medium', 'high'], default_effort: 'low', cost: { input: 0.27, output: 1.1 } }),
        M({ id: 'opencode/qwen4-coder', label: 'Qwen4 Coder', cost: { input: 0.3, output: 1.2 } }),
        M({ id: 'opencode/big-pickle', label: 'Big Pickle', cost: { input: 0, output: 0 } }),
        M({ id: 'opencode/gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'], default_effort: 'medium', cost: { input: 1.5, output: 12 } }),
        M({ id: 'opencode/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: ['low', 'high'], cost: { input: 3, output: 15 } }),
        M({ id: 'opencode/glm-5.4-preview', label: 'GLM-5.4 preview', cost: { input: 0.5, output: 2 } }),
      ],
    },
  ]
}

// ---------------------------------------------------------------- resumes
const BODIES: Record<string, string> = {
  builder: `You are a senior software engineer. You own ONE task end to end: understand it, implement it, run it, test it, and prove it works.

How you work:
1. Read before writing. Find the files your task touches and the conventions around them.
2. Plan briefly, then implement in small, verifiable steps.
3. Run what you build. Add or update tests that cover the behaviour you changed.
4. Finish with \`sparrow done\` using Result / Evidence / Files / Next.
`,
  verifier: `You are a read-only verifier. Check one builder's work against its acceptance checks.
Run the tests, try edge cases, hit live endpoints. Report PASS/FAIL per check with evidence. Never edit code.
`,
  researcher: `You read widely and cite sources. Return a short digest: the answer first, then the evidence, then open questions.
`,
}

type Row = Omit<ResumeView, 'hash' | 'status' | 'status_detail' | 'resolved_model' | 'stale_agents'>
const R = (slug: string, title: string, harness: HarnessName, model: string | null, effort: string | null, can_hire: string[], description: string, builtin = false): Row => ({
  slug, title, description, harness, model, effort, can_hire, limits: { quiet_minutes: 15, max_call_minutes: 90 },
  body: BODIES[slug] ?? `You are a ${title}.\n`, path: builtin ? `${HOME}/Desktop/SWEFactory/sparrow/assets/resumes/${slug}.md` : `${HOME}/.sparrow/resumes/${slug}.md`, builtin,
})

export function seedResumes(): Row[] {
  return [
    R('sub-captain', 'Sub-captain', 'claude', 'opus', 'high', ['builder', 'builder-codex', 'verifier', 'researcher', 'presenter'], 'Owns one slice: plans, hires, reviews, reports.'),
    R('builder', 'Builder', 'claude', 'opus', 'high', [], 'Implements one task end to end in the given folder, runs it, reports evidence.'),
    R('builder-codex', 'Builder (Codex)', 'codex', 'gpt-6-nova', 'medium', [], 'Same as builder, on Codex.'),
    R('verifier', 'Verifier', 'codex', 'gpt-6.1-sol', 'medium', [], 'Read-only checker: runs tests, tries edge cases, reports pass/fail with evidence.'),
    R('researcher', 'Researcher', 'opencode', 'opencode/glm-5.1', null, [], 'Reads widely, cites sources, writes a short digest.'),
    R('scout', 'Scout', 'codex', 'gpt-6-luna', 'xhigh', [], 'Quick triage of an issue or log: what broke, where, and who should fix it.'),
    R('presenter', 'Presenter', 'opencode', 'opencode-go/glm-5.3', null, [], 'Turns findings into a short HTML deck.', true),
    { ...R('deckhand', 'Deckhand', 'claude', 'haiku', 'medium', [], 'Fast, cheap mechanical work. One-shot.', true), helper: true, one_shot: true },
    { ...R('advisor', 'Advisor', 'claude', 'opus', 'medium', [], 'Read-only senior advisor: answers one question.', true), helper: true },
  ]
}

export function hashOf(r: Pick<Row, 'title' | 'description' | 'harness' | 'model' | 'effort' | 'can_hire' | 'limits' | 'body'>): string {
  const text = JSON.stringify([r.title, r.description, r.harness, r.model, r.effort, r.can_hire, r.limits, r.body])
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------- doctor script
interface Step { id: string; harness: HarnessName | null; label: string; status: DoctorCheck['status']; detail: string; fix?: string; ms: number }
const STEPS: Step[] = [
  { id: 'tmux', harness: null, label: 'tmux', status: 'pass', detail: 'tmux 3.5a at /opt/homebrew/bin/tmux', ms: 40 },
  { id: 'port', harness: null, label: 'Server port', status: 'pass', detail: '127.0.0.1:4040 answers as Sparrow (pid 81234)', ms: 12 },
  { id: 'path', harness: null, label: 'sparrow on PATH', status: 'pass', detail: `${HOME}/.bun/bin/sparrow → bin/sparrow`, ms: 8 },
  { id: 'skills', harness: null, label: 'Skills', status: 'warn', detail: 'sparrow-captain skill in ~/.claude/skills is older than the packaged copy', fix: 'sparrow install', ms: 15 },
  { id: 'hooks', harness: null, label: 'Hooks', status: 'pass', detail: 'Stop hook fires through --settings (checked in the round trip)', ms: 5 },
  { id: 'claude.binary', harness: 'claude', label: 'Installed', status: 'pass', detail: `2.1.302 at ${HOME}/.local/bin/claude`, ms: 310 },
  { id: 'claude.login', harness: 'claude', label: 'Logged in', status: 'pass', detail: 'claude.ai account (Max)', ms: 420 },
  { id: 'claude.catalog', harness: 'claude', label: 'Model list', status: 'pass', detail: '5 models; opus → claude-opus-5-5', ms: 2900 },
  { id: 'claude.spawn', harness: 'claude', label: 'Opens in tmux', status: 'pass', detail: 'window u1doctor:claude-probe opened, TUI ready in 3.1 s', ms: 3100 },
  { id: 'claude.roundtrip', harness: 'claude', label: 'Round trip', status: 'pass', detail: 'haiku · low: hire → update → done → window closed', ms: 38_400 },
  { id: 'codex.binary', harness: 'codex', label: 'Installed', status: 'pass', detail: '0.162.1 at /opt/homebrew/bin/codex (was 0.161.0)', ms: 120 },
  { id: 'codex.login', harness: 'codex', label: 'Logged in', status: 'pass', detail: 'Logged in using ChatGPT', ms: 380 },
  { id: 'codex.catalog', harness: 'codex', label: 'Model list', status: 'pass', detail: '5 models (2 hidden)', ms: 900 },
  { id: 'codex.spawn', harness: 'codex', label: 'Opens in tmux', status: 'pass', detail: 'window u1doctor:codex-probe opened, TUI ready in 2.4 s', ms: 2400 },
  { id: 'codex.roundtrip', harness: 'codex', label: 'Round trip', status: 'pass', detail: 'gpt-6-luna · low: hire → done → window closed', ms: 51_700 },
  { id: 'opencode.binary', harness: 'opencode', label: 'Installed', status: 'pass', detail: '1.19.0 at /opt/homebrew/bin/opencode', ms: 150 },
  { id: 'opencode.login', harness: 'opencode', label: 'Logged in', status: 'fail', detail: 'opencode auth list: 0 credentials in ~/.sparrow/opencode', fix: 'OPENCODE_CONFIG_DIR=~/.sparrow/opencode opencode auth login', ms: 610 },
  { id: 'opencode.catalog', harness: 'opencode', label: 'Model list', status: 'pass', detail: '9 models across opencode and opencode-go', ms: 1800 },
  { id: 'opencode.spawn', harness: 'opencode', label: 'Opens in tmux', status: 'skipped', detail: 'skipped: not logged in', ms: 0 },
  { id: 'opencode.roundtrip', harness: 'opencode', label: 'Round trip', status: 'skipped', detail: 'skipped: not logged in', ms: 0 },
]
const LOGIN_FIX = 'Run `OPENCODE_CONFIG_DIR=~/.sparrow/opencode opencode auth login`, then Run doctor again.'

// ---------------------------------------------------------------- state
export interface U1Ctx {
  agents: Agent[]
  emit: (ev: ServerEvent) => void
  /** Multi-captain: create the captain row before "launching" (mock/captains.ts). Returns the response or an error. */
  startCaptain?: (b: CaptainStartReq, cwd: string, project: string) => CaptainStartRes | string | undefined
}

export function createU1(ctx: U1Ctx, opts: { now?: number; doctorMs?: number; doctorDone?: boolean } = {}) {
  const now = opts.now ?? Date.now()
  let catalogs = seedCatalogs(now)
  const rows = new Map(seedResumes().map((r) => [r.slug, r]))
  let run: DoctorRun | null = null
  let prevVersions: Record<string, string | null> = { claude: '2.1.302', codex: '0.161.0', opencode: '1.19.0' }
  const tests = new Map<string, DoctorCheck>()
  const recent = [`${HOME}/Desktop/plutus`, `${HOME}/Desktop/SWEFactory/sparrow`, `${HOME}/Desktop/plutus-wt/export-csv`, `${HOME}/code/notes`]
  const doctorMs = opts.doctorMs ?? 8000

  // Agents hired from an older copy: the hash they carry is not the current one.
  for (const a of ctx.agents) {
    if (a.kind === 'human') continue
    const r = rows.get(a.resume)
    a.resume_hash = r ? (['james', 'iris'].includes(a.handle) ? 'a1b2c3d4e5f6' : hashOf(r)) : null
  }

  function health(): HarnessHealth[] {
    return (['claude', 'codex', 'opencode'] as const).map((h) => {
      if (!run?.ended_at) return { harness: h, installed: null, logged_in: null, working: null, fix: null, checked_at: null }
      const get = (k: string) => run!.checks.find((c) => c.id === `${h}.${k}`)?.status
      const flag = (k: string) => (get(k) === 'pass' ? true : get(k) === 'fail' ? false : null)
      const failing = run.checks.find((c) => c.harness === h && c.status === 'fail')
      return { harness: h, installed: flag('binary'), logged_in: flag('login'), working: flag('roundtrip'), fix: failing ? (h === 'opencode' ? LOGIN_FIX : failing.fix) : null, checked_at: run.ended_at }
    })
  }

  function view(r: Row): ResumeView {
    const cat = catalogs.find((c) => c.harness === r.harness)
    const model = r.model ? cat?.models.find((m) => m.id === r.model || m.resolves_to === r.model) : undefined
    const hh = health().find((x) => x.harness === r.harness)
    let status: ResumeStatus = 'ok'
    let detail: string | null = null
    if (hh?.installed === false) { status = 'harness_missing'; detail = `${r.harness} is not installed. ${hh.fix ?? ''}`.trim() }
    else if (hh?.logged_in === false) { status = 'harness_logged_out'; detail = `${r.harness} is not logged in. ${hh.fix ?? ''}`.trim() }
    else if (hh?.working === false) { status = 'harness_broken'; detail = `${r.harness} round trip failed in the last doctor run` }
    else if (r.model && cat?.ok && !model) {
      status = 'model_gone'
      detail = `model ${r.model} no longer offered by ${r.harness}; available: ${cat.models.filter((m) => !m.hidden).map((m) => m.id).join(', ')}`
    } else if (r.effort && model && !model.efforts.includes(r.effort)) {
      status = 'effort_invalid'
      detail = model.efforts.length ? `effort ${r.effort} not accepted by ${model.id}; use ${model.efforts.join(', ')}` : `${model.id} has no effort levels; clear the effort`
    } else if (!hh?.checked_at) status = 'unchecked'
    const hash = hashOf(r)
    const stale = ctx.agents.filter((a) => a.resume === r.slug && a.state !== 'retired' && a.kind !== 'human' && a.resume_hash && a.resume_hash !== hash).map((a) => a.id)
    return { ...r, hash, status, status_detail: detail, resolved_model: model?.resolves_to ?? null, stale_agents: stale }
  }

  const all = () => [...rows.values()].map(view).sort((a, b) => a.slug.localeCompare(b.slug))
  const emitResumes = () => { for (const r of rows.values()) ctx.emit({ type: 'resume.updated', project_id: '*', resume: view(r) }) }

  function validate(b: Partial<ResumeWriteReq>): string | null {
    if (!b || typeof b !== 'object') return 'body: expected a JSON resume'
    if (!b.title?.trim()) return 'title: required'
    if (!['claude', 'codex', 'opencode', 'fake'].includes(b.harness as string)) return `harness: must be claude, codex or opencode (got ${b.harness})`
    const cat = catalogs.find((c) => c.harness === b.harness)
    const model = b.model ? cat?.models.find((m) => m.id === b.model || m.resolves_to === b.model) : undefined
    if (b.model && cat?.ok && !model) return `model: ${b.model} is not offered by ${b.harness}; available: ${cat.models.filter((m) => !m.hidden).map((m) => m.id).join(', ')}`
    if (b.effort && model && !model.efforts.includes(b.effort)) {
      return model.efforts.length ? `effort: ${b.effort} is not accepted by ${model.id}; use one of ${model.efforts.join(', ')}` : `effort: ${model.id} has no effort levels; leave effort empty`
    }
    if (!Array.isArray(b.can_hire)) return 'can_hire: expected a list of resume slugs'
    const unknown = b.can_hire.filter((s) => s !== '*' && !rows.has(s))
    if (unknown.length) return `can_hire: unknown resume ${unknown.join(', ')}`
    const l = b.limits
    if (!l || !(l.quiet_minutes >= 1) || !(l.max_call_minutes >= 1)) return 'limits: quiet_minutes and max_call_minutes must be whole minutes ≥ 1'
    if (!b.body?.trim()) return 'body: the role prompt cannot be empty'
    return null
  }

  function pick(b: ResumeWriteReq): Omit<Row, 'slug' | 'path' | 'builtin'> {
    return {
      title: b.title.trim(), description: b.description ?? '', harness: b.harness, model: b.model || null, effort: b.effort || null, can_hire: b.helper ? [] : b.can_hire,
      limits: { quiet_minutes: Math.round(b.limits.quiet_minutes), max_call_minutes: Math.round(b.limits.max_call_minutes) }, body: b.body,
      ...(b.helper ? { helper: true } : {}), ...(b.one_shot ? { one_shot: true } : {}),
    }
  }

  function startDoctor(): DoctorRun {
    const t0 = Date.now()
    const versions: Record<string, string | null> = { claude: '2.1.302', codex: '0.162.1', opencode: '1.19.0' }
    const r: DoctorRun = {
      id: `doc_${t0.toString(36)}`, started_at: t0, ended_at: null, versions,
      version_changed: Object.keys(versions).filter((h) => prevVersions[h] && prevVersions[h] !== versions[h]),
      checks: STEPS.map((s) => ({ id: s.id, harness: s.harness, label: s.label, status: 'pending', detail: '', fix: null, duration_ms: null, updated_at: t0 })),
    }
    run = r
    const tick = doctorMs / (STEPS.length + 2)
    STEPS.forEach((s, i) => {
      const c = r.checks[i]
      setTimeout(() => { c.status = 'running'; c.detail = 'checking…'; c.updated_at = Date.now(); ctx.emit({ type: 'doctor.updated', project_id: '*', run: r }) }, tick * (i + 0.5))
      setTimeout(() => {
        Object.assign(c, { status: s.status, detail: s.detail, fix: s.fix ?? null, duration_ms: s.ms || null, updated_at: Date.now() })
        ctx.emit({ type: 'doctor.updated', project_id: '*', run: r })
      }, tick * (i + 1))
    })
    setTimeout(() => {
      r.ended_at = Date.now()
      prevVersions = versions
      ctx.emit({ type: 'doctor.updated', project_id: '*', run: r })
      emitResumes()
    }, tick * (STEPS.length + 1))
    ctx.emit({ type: 'doctor.updated', project_id: '*', run: r })
    return r
  }

  if (opts.doctorDone) {
    const t0 = now - 3 * 60_000
    run = {
      id: 'doc_seed', started_at: t0 - 95_000, ended_at: t0, versions: { claude: '2.1.302', codex: '0.162.1', opencode: '1.19.0' }, version_changed: ['codex'],
      checks: STEPS.map((s) => ({ id: s.id, harness: s.harness, label: s.label, status: s.status, detail: s.detail, fix: s.fix ?? null, duration_ms: s.ms || null, updated_at: t0 })),
    }
    prevVersions = run.versions
  }

  const savedSettings: Record<string, number> = {}
  const doctorModels: Record<string, string> = {}
  const settingsView = (): SettingsView => ({
    fields: SETTINGS.map((f) => ({ ...f, value: savedSettings[f.key] ?? f.default, saved: f.key in savedSettings, env_override: false })),
    doctor_models: { ...doctorModels }, file: `${HOME}/.sparrow/config.json`,
  })
  const json = (data: unknown, status = 200) => Response.json(data, { status })
  const err = (status: number, error: string) => json({ error }, status)

  async function handle(req: Request, p: string, body: any): Promise<Response | null> {
    const method = req.method
    if (p === '/api/catalog' && method === 'GET') return json(catalogs)
    if (p === '/api/catalog/refresh' && method === 'POST') {
      await Bun.sleep(Number(process.env.MOCK_REFRESH_MS ?? 1200))
      const t = Date.now()
      catalogs = catalogs.map((c) => ({ ...c, fetched_at: t }))
      ctx.emit({ type: 'catalog.updated', project_id: '*', catalogs })
      return json(catalogs)
    }
    if (p === '/api/doctor' && method === 'GET') return json({ run, health: health() })
    if (p === '/api/doctor/run' && method === 'POST') {
      if (run && !run.ended_at) return err(409, 'a doctor run is already in progress; watch it on the Doctor page')
      return json({ run: startDoctor() })
    }
    if (p === '/api/settings' && method === 'GET') return json(settingsView())
    if (p === '/api/settings' && method === 'PUT') {
      const values = (body?.values ?? {}) as Record<string, number | null>
      for (const [k, v] of Object.entries(values)) {
        const f = SETTINGS.find((x) => x.key === k)
        if (!f) return err(400, `${k}: unknown setting`)
        if (v !== null && (!Number.isInteger(v) || v < f.min || v > f.max)) return err(400, `${k}: must be between ${f.min} and ${f.max} ${f.unit}`)
      }
      for (const [k, v] of Object.entries(values)) { if (v === null) delete savedSettings[k]; else savedSettings[k] = v }
      for (const [h, m] of Object.entries((body?.doctor_models ?? {}) as Record<string, string | null>)) { if (m) doctorModels[h] = m; else delete doctorModels[h] }
      return json(settingsView())
    }
    if (p === '/api/captain/recent' && method === 'GET') return json(recent)
    if (p === '/api/captain/start' && method === 'POST') {
      const b = (body ?? {}) as CaptainStartReq
      if (!b.cwd?.trim()) return err(400, 'cwd: give the folder the captain should start in')
      const cwd = b.cwd.trim().replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, '')
      if (!cwd.startsWith('/')) return err(400, `cwd: ${b.cwd} is not an absolute path; use e.g. ~/Desktop/plutus`)
      if (cwd.includes('missing')) return err(400, `cwd: ${cwd} does not exist`)
      const claude = catalogs.find((c) => c.harness === 'claude')!
      if (b.model && !claude.models.some((m) => m.id === b.model || m.resolves_to === b.model)) return err(400, `model: ${b.model} is not offered by claude`)
      const project = cwd.split('/').pop()!
      const made = ctx.startCaptain?.(b, cwd, /plutus/.test(cwd) ? 'plutus' : /sparrow/.test(cwd) ? 'sparrow' : project)
      if (typeof made === 'string') return err(400, made)
      const res: CaptainStartRes = made ?? { session: `sparrow-${project}`, window: 'captain', window_id: '@41', cwd, attach: `tmux attach -t sparrow-${project} \\; select-window -t @41` }
      const i = recent.indexOf(cwd)
      if (i !== -1) recent.splice(i, 1)
      recent.unshift(cwd)
      return json(res)
    }
    if (p === '/api/resumes' && method === 'GET') return json(all())
    if (p === '/api/resumes' && method === 'POST') {
      const b = body as ResumeWriteReq
      if (!b?.slug || !SLUG_RE.test(b.slug)) return err(400, 'slug: lowercase letters, digits and dashes, starting with a letter (max 32)')
      if (rows.has(b.slug)) return err(409, `slug: a resume named ${b.slug} already exists; pick another slug or edit it`)
      const bad = validate(b)
      if (bad) return err(400, bad)
      const row: Row = { slug: b.slug, path: `${HOME}/.sparrow/resumes/${b.slug}.md`, builtin: false, ...pick(b) }
      rows.set(row.slug, row)
      const v = view(row)
      ctx.emit({ type: 'resume.updated', project_id: '*', resume: v })
      return json(v, 201)
    }
    const m = p.match(/^\/api\/resumes\/([^/]+)(?:\/(duplicate|apply|test))?$/)
    if (!m) return null
    const slug = decodeURIComponent(m[1])
    const row = rows.get(slug)
    const action = m[2]
    if (!row) return err(404, `no resume named ${slug}; see GET /api/resumes`)
    if (!action && method === 'GET') return json(view(row))
    if (!action && method === 'PUT') {
      const bad = validate(body)
      if (bad) return err(400, bad)
      Object.assign(row, pick(body), { builtin: false, path: `${HOME}/.sparrow/resumes/${slug}.md` })
      const v = view(row)
      ctx.emit({ type: 'resume.updated', project_id: '*', resume: v })
      return json(v)
    }
    if (!action && method === 'DELETE') {
      rows.delete(slug)
      ctx.emit({ type: 'resume.deleted', project_id: '*', slug })
      return json({ ok: true })
    }
    if (action === 'duplicate' && method === 'POST') {
      const to = body?.slug as string
      if (!to || !SLUG_RE.test(to)) return err(400, 'slug: lowercase letters, digits and dashes, starting with a letter (max 32)')
      if (rows.has(to)) return err(409, `slug: a resume named ${to} already exists`)
      const copy: Row = { ...structuredClone(row), slug: to, title: `${row.title} (copy)`, builtin: false, path: `${HOME}/.sparrow/resumes/${to}.md` }
      rows.set(to, copy)
      const v = view(copy)
      ctx.emit({ type: 'resume.updated', project_id: '*', resume: v })
      return json(v, 201)
    }
    if (action === 'apply' && method === 'POST') {
      const v = view(row)
      const updated: string[] = []
      for (const a of ctx.agents) {
        if (!v.stale_agents.includes(a.id)) continue
        Object.assign(a, { harness: row.harness, model: row.model, effort: row.effort, can_hire: row.can_hire, resume_hash: v.hash, updated_at: Date.now() })
        updated.push(a.id)
        ctx.emit({ type: 'agent.updated', project_id: a.project_id, agent: a })
      }
      ctx.emit({ type: 'resume.updated', project_id: '*', resume: view(row) })
      return json({ updated })
    }
    if (action === 'test' && method === 'GET') {
      const c = tests.get(slug)
      return c ? json(c) : err(404, `no test run for ${slug} yet; POST /api/resumes/${slug}/test`)
    }
    if (action === 'test' && method === 'POST') {
      const t0 = Date.now()
      const c: DoctorCheck = { id: `test.${slug}`, harness: row.harness, label: `Test ${slug}`, status: 'running', detail: `hiring a probe with ${row.harness} · ${row.model ?? 'default'} · ${row.effort ?? 'default effort'}…`, fix: null, duration_ms: null, updated_at: t0 }
      tests.set(slug, c)
      const v = view(row)
      setTimeout(() => {
        const ms = Date.now() - t0
        if (v.status === 'model_gone' || v.status === 'harness_logged_out' || v.status === 'harness_missing' || v.status === 'effort_invalid') {
          tests.set(slug, { ...c, status: 'fail', detail: `hire refused: ${v.status_detail}`, fix: v.status === 'harness_logged_out' ? LOGIN_FIX : 'Pick a model from the list and save, then test again.', duration_ms: ms, updated_at: Date.now() })
        } else {
          tests.set(slug, { ...c, status: 'pass', detail: `${row.harness} · ${v.resolved_model ?? row.model ?? 'default'} · ${row.effort ?? 'default'}: hire → done → window closed`, duration_ms: ms, updated_at: Date.now() })
        }
      }, Number(process.env.MOCK_TEST_MS ?? 4500))
      return json({ check: c })
    }
    return null
  }

  return { handle, view: (slug: string) => { const r = rows.get(slug); return r ? view(r) : null } }
}
