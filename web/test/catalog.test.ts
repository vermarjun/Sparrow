import { describe, expect, test } from 'bun:test'
import type { Agent, DoctorCheck, DoctorRun, HarnessCatalog, HarnessHealth, ResumeView } from '../../src/shared/types'
import {
  costLabel, effortAfterModelChange, effortChoice, errorField, findModel, groupChecks, harnessAvailability, healthVerdict, isOlderResume,
  modelGone, modelOptions, runLabel, slugError, stripField, summarizeChecks,
} from '../src/lib/catalog'
import { reduce, reduceGlobal, emptyData, type GlobalData } from '../src/lib/reduce'
import { seedCatalogs } from '../mock/u1'

const cats = seedCatalogs(0)
const claude = cats.find((c) => c.harness === 'claude')!
const codex = cats.find((c) => c.harness === 'codex')!
const opencode = cats.find((c) => c.harness === 'opencode')!
const H = (h: Partial<HarnessHealth> & Pick<HarnessHealth, 'harness'>): HarnessHealth => ({ installed: null, logged_in: null, working: null, fix: null, checked_at: null, ...h })
const check = (id: string, harness: DoctorCheck['harness'], status: DoctorCheck['status']): DoctorCheck => ({ id, harness, label: id, status, detail: '', fix: null, duration_ms: null, updated_at: 0 })

describe('model options', () => {
  test('visible models first, hidden last, catalog order kept', () => {
    const ids = modelOptions(codex, null).map((o) => `${o.value}${o.hidden ? '(h)' : ''}`)
    expect(ids).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.5(h)', 'codex-auto-review(h)'])
  })
  test('a gone model stays visible as the first option, marked gone', () => {
    const opts = modelOptions(codex, 'gpt-6-nova')
    expect(opts[0]).toMatchObject({ value: 'gpt-6-nova', gone: true })
    expect(opts.filter((o) => o.gone)).toHaveLength(1)
    expect(modelGone(codex, 'gpt-6-nova')).toBe(true)
    expect(modelGone(codex, 'gpt-6-luna')).toBe(false)
    expect(modelGone(codex, null)).toBe(false)
  })
  test('a failed catalog never says "gone"', () => {
    const failed: HarnessCatalog = { ...codex, ok: false, models: [], error: 'codex: command not found' }
    expect(modelGone(failed, 'gpt-6-nova')).toBe(false)
  })
  test('claude aliases show the resolved id; a full id finds its alias', () => {
    expect(modelOptions(claude, null).find((o) => o.value === 'opus')?.hint).toBe('→ claude-opus-5-5')
    expect(findModel(claude, 'claude-opus-5-5')?.id).toBe('opus')
    expect(modelGone(claude, 'claude-opus-5-5')).toBe(false)
  })
  test('cost shown only for OpenCode', () => {
    expect(modelOptions(opencode, null).find((o) => o.value === 'opencode/glm-5.1')?.hint).toBe('$0.45 / $1.80 per 1M')
    expect(modelOptions(opencode, null).find((o) => o.value === 'opencode/big-pickle')?.hint).toBe('free')
    expect(costLabel({ input: 3, output: 15 })).toBe('$3 / $15 per 1M')
    expect(costLabel(null)).toBeNull()
  })
})

describe('effort', () => {
  test('efforts come from the chosen model', () => {
    expect(effortChoice(codex, 'gpt-6-luna', null)).toMatchObject({ efforts: ['low', 'medium', 'high'], disabled: false, invalid: false })
    expect(effortChoice(codex, 'gpt-6-luna', 'xhigh').invalid).toBe(true)
  })
  test('model with no effort levels: disabled with a note', () => {
    expect(effortChoice(opencode, 'opencode-go/glm-5.3', null)).toMatchObject({ efforts: [], disabled: true, note: 'no effort levels' })
    expect(effortChoice(opencode, 'opencode-go/glm-5.3', 'high').invalid).toBe(true)
  })
  test('harness default: Claude shares one effort list, Codex does not', () => {
    expect(effortChoice(claude, null, null).efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortChoice(codex, null, null)).toMatchObject({ efforts: [], disabled: true })
  })
  test('model change keeps a supported effort, else the default, else none', () => {
    expect(effortAfterModelChange(codex, 'gpt-6-astra', 'high')).toBe('high')
    expect(effortAfterModelChange(codex, 'gpt-6-luna', 'xhigh')).toBe('low')
    expect(effortAfterModelChange(opencode, 'opencode-go/glm-5.3', 'high')).toBeNull()
  })
})

describe('harness availability + health', () => {
  test('logged out / missing from the doctor, failed catalog — each disabled with a reason', () => {
    const health = [H({ harness: 'opencode', installed: true, logged_in: false, fix: 'run opencode auth login', checked_at: 1 }), H({ harness: 'codex', installed: false, checked_at: 1 })]
    expect(harnessAvailability('opencode', cats, health)).toEqual({ disabled: true, reason: 'logged out — run opencode auth login' })
    expect(harnessAvailability('codex', cats, health)).toEqual({ disabled: true, reason: 'not installed' })
    const failed = cats.map((c) => (c.harness === 'claude' ? { ...c, ok: false, error: 'claude --help failed' } : c))
    expect(harnessAvailability('claude', failed, [])).toEqual({ disabled: true, reason: 'model list failed — claude --help failed' })
    expect(harnessAvailability('claude', cats, [])).toEqual({ disabled: false, reason: null })
  })
  test('verdicts', () => {
    expect(healthVerdict(undefined).label).toBe('not checked')
    expect(healthVerdict(H({ harness: 'claude', checked_at: 1, installed: true, logged_in: true, working: true })).tone).toBe('ok')
    expect(healthVerdict(H({ harness: 'codex', checked_at: 1, installed: true, logged_in: false })).label).toBe('logged out')
    expect(healthVerdict(H({ harness: 'codex', checked_at: 1, installed: true, logged_in: true, working: false })).label).toBe('round trip failed')
  })
})

describe('doctor grouping', () => {
  const run: DoctorRun = {
    id: 'doc_1', started_at: 0, ended_at: null, versions: {}, version_changed: [],
    checks: [check('tmux', null, 'pass'), check('claude.login', 'claude', 'pass'), check('codex.login', 'codex', 'fail'), check('opencode.roundtrip', 'opencode', 'running'), check('fake.x', 'fake', 'pass')],
  }
  test('shared vs per harness; fake ignored', () => {
    const g = groupChecks(run)
    expect(g.shared.map((c) => c.id)).toEqual(['tmux'])
    expect(g.byHarness.codex.map((c) => c.id)).toEqual(['codex.login'])
    expect(groupChecks(null).shared).toEqual([])
  })
  test('summary in a fixed order', () => {
    expect(summarizeChecks(run.checks)).toBe('1 running · 3 pass · 1 fail')
  })
})

describe('resume helpers', () => {
  test('slug rules', () => {
    expect(slugError('builder-2')).toBeNull()
    expect(slugError('')).toBe('slug is required')
    expect(slugError('2fast')).toMatch(/^slug:/)
    expect(slugError('a'.repeat(33))).toMatch(/^slug:/)
  })
  test('server errors map to the field they name', () => {
    expect(errorField('effort: xhigh is not accepted by gpt-6-luna')).toBe('effort')
    expect(errorField('model gpt-6-nova no longer offered by codex; available: gpt-6.1-sol')).toBe('model')
    expect(errorField('limits.quiet_minutes: must be ≥ 1')).toBe('limits')
    expect(errorField('server exploded')).toBeNull()
    expect(stripField('effort: xhigh is not accepted', 'effort')).toBe('xhigh is not accepted')
    expect(stripField('limits.quiet_minutes: must be ≥ 1', 'limits')).toBe('must be ≥ 1')
  })
  test('older resume badge only when both hashes are known and differ', () => {
    const a = { kind: 'agent', state: 'idle', resume_hash: 'aaa' } as Agent
    expect(isOlderResume(a, { hash: 'bbb' })).toBe(true)
    expect(isOlderResume(a, { hash: 'aaa' })).toBe(false)
    expect(isOlderResume({ ...a, resume_hash: null }, { hash: 'bbb' })).toBe(false)
    expect(isOlderResume({ ...a, state: 'retired' }, { hash: 'bbb' })).toBe(false)
    expect(isOlderResume(a, undefined)).toBe(false)
  })
  test('last run label', () => {
    expect(runLabel({ harness: 'codex', model: 'gpt-6-luna', effort: 'low', at: 0 })).toBe('codex · gpt-6-luna · low')
    expect(runLabel({ harness: 'claude', model: null, effort: null, at: 0 })).toBe('claude · default model')
    expect(runLabel(null)).toBeNull()
  })
})

describe('global reducer', () => {
  const g0: GlobalData = { catalogs: [], doctorRun: null, resumes: {} }
  const rv = (slug: string, hash = 'h1') => ({ slug, hash, status: 'ok' }) as ResumeView
  test('catalog, doctor and resume events', () => {
    let g = reduceGlobal(g0, { type: 'catalog.updated', project_id: '*', catalogs: cats })
    expect(g.catalogs).toHaveLength(3)
    const run = { id: 'doc_2', started_at: 10, ended_at: null, checks: [], versions: {}, version_changed: [] }
    g = reduceGlobal(g, { type: 'doctor.updated', project_id: '*', run })
    expect(g.doctorRun?.id).toBe('doc_2')
    // a late update from an older run is ignored
    const old = { ...run, id: 'doc_1', started_at: 5 }
    expect(reduceGlobal(g, { type: 'doctor.updated', project_id: '*', run: old })).toBe(g)
    g = reduceGlobal(g, { type: 'resume.updated', project_id: '*', resume: rv('builder') })
    g = reduceGlobal(g, { type: 'resume.updated', project_id: '*', resume: rv('builder', 'h2') })
    expect(g.resumes.builder.hash).toBe('h2')
    g = reduceGlobal(g, { type: 'resume.deleted', project_id: '*', slug: 'builder' })
    expect(g.resumes).toEqual({})
    expect(reduceGlobal(g, { type: 'resume.deleted', project_id: '*', slug: 'nope' })).toBe(g)
  })
  test('project reducer ignores global events and anything when no project is selected', () => {
    const d = emptyData('p')
    expect(reduce(d, { type: 'resume.deleted', project_id: '*', slug: 'x' })).toBe(d)
    const none = emptyData(null)
    expect(reduce(none, { type: 'agent.updated', project_id: 'p', agent: { id: 'ag_x' } as Agent })).toBe(none)
  })
})
