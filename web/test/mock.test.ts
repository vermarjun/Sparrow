// The mock server mirrors the real API shapes the UI relies on (CONTRACT §4).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Card, ServerEvent } from '../../src/shared/types'

const PORT = 4143
let proc: ReturnType<typeof Bun.spawn>
const U = `http://127.0.0.1:${PORT}`

beforeAll(async () => {
  proc = Bun.spawn(['bun', `${import.meta.dir}/../mock/server.ts`, '--port', String(PORT), '--quiet', '--no-live', '--dist', '/nonexistent'], {
    stdout: 'ignore', stderr: 'inherit', env: { ...process.env, MOCK_DOCTOR_MS: '600', MOCK_TEST_MS: '150', MOCK_REFRESH_MS: '20', MOCK_OPENCODE_LOGGED_OUT: '1' },
  })
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${U}/api/health`).then((r) => r.ok).catch(() => false)) return
    await Bun.sleep(100)
  }
  throw new Error('mock did not start')
})
afterAll(() => proc?.kill())

describe('mock server', () => {
  test('seeded project data', async () => {
    const projects = await fetch(`${U}/api/projects`).then((r) => r.json())
    expect(projects.map((p: { id: string }) => p.id)).toContain('tortuga')
    const agents = await fetch(`${U}/api/agents?project=tortuga`).then((r) => r.json())
    const states = new Set(agents.map((a: { state: string }) => a.state))
    for (const s of ['working', 'queued', 'waiting', 'idle']) expect(states.has(s)).toBe(true)
    const threads = await fetch(`${U}/api/threads?project=tortuga`).then((r) => r.json())
    expect(threads.every((t: { thread: string }) => t.thread.startsWith('dm:'))).toBe(true)
    const kinds = new Set<string>()
    for (const t of threads) for (const m of await fetch(`${U}/api/messages?project=tortuga&thread=${encodeURIComponent(t.thread)}`).then((r) => r.json())) kinds.add(m.kind)
    expect([...kinds].sort()).toEqual(['chat', 'question', 'result', 'system', 'task', 'update'])
  })

  test('PATCH a card emits card.updated on SSE and is logged', async () => {
    await fetch(`${U}/__log/reset`, { method: 'POST' })
    const ctrl = new AbortController()
    const res = await fetch(`${U}/api/events?project=tortuga`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    const patched = await fetch(`${U}/api/cards/5`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'review', position: 7.5 }) }).then((r) => r.json())
    expect(patched.card.state).toBe('review')
    let buf = ''
    let ev: ServerEvent | null = null
    while (!ev) {
      const { value } = await reader.read()
      buf += new TextDecoder().decode(value)
      const line = buf.split('\n').find((l) => l.startsWith('data: '))
      if (line) ev = JSON.parse(line.slice(6))
    }
    ctrl.abort()
    expect(ev.type).toBe('card.updated')
    expect((ev as { card: Card }).card.position).toBe(7.5)
    const log = await fetch(`${U}/__log`).then((r) => r.json())
    expect(log.filter((l: { method: string }) => l.method === 'PATCH')).toHaveLength(1)
  })

  test('UI-only writes: anything else is a 404', async () => {
    const r = await fetch(`${U}/api/hire`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(404)
  })
})

const J = (method: string, path: string, body?: unknown) =>
  fetch(`${U}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, type: string): Promise<ServerEvent> {
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error('stream closed')
    buf += new TextDecoder().decode(value)
    const parts = buf.split('\n\n')
    buf = parts.pop()!
    for (const p of parts) {
      if (!p.startsWith('data: ')) continue
      const ev = JSON.parse(p.slice(6)) as ServerEvent
      if (ev.type === type) return ev
    }
  }
}

describe('mock server: U1 endpoints', () => {
  test('catalog has the measured ids', async () => {
    const cats = await fetch(`${U}/api/catalog`).then((r) => r.json())
    expect(cats.map((c: { harness: string }) => c.harness)).toEqual(['claude', 'codex', 'opencode'])
    const ids = cats.flatMap((c: { models: { id: string }[] }) => c.models.map((m) => m.id))
    for (const id of ['opus', 'gpt-6.1-sol', 'gpt-6-luna', 'opencode-go/glm-5.3']) expect(ids).toContain(id)
    expect(cats[0].models.find((m: { id: string }) => m.id === 'opus').resolves_to).toBe('claude-opus-5-5')
  })

  test('doctor run streams doctor.updated to a project subscriber (global event), 409 while running, then health', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${U}/api/events?project=tortuga`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    const before = await fetch(`${U}/api/doctor`).then((r) => r.json())
    expect(before.run).toBeNull()
    const start = await J('POST', '/api/doctor/run').then((r) => r.json())
    expect(start.run.ended_at).toBeNull()
    expect((await J('POST', '/api/doctor/run')).status).toBe(409)
    const ev = await nextEvent(reader, 'doctor.updated')
    expect(ev.project_id).toBe('*')
    await Bun.sleep(900)
    ctrl.abort()
    const after = await fetch(`${U}/api/doctor`).then((r) => r.json())
    expect(after.run.ended_at).toBeGreaterThan(0)
    expect(after.run.version_changed).toEqual(['codex'])
    expect(after.health.find((h: { harness: string }) => h.harness === 'opencode').logged_in).toBe(false)
  })

  test('the shipped resumes load; after the doctor run only the logged-out harness is flagged; stale agents counted', async () => {
    const list = await fetch(`${U}/api/resumes`).then((r) => r.json()) as { slug: string; status: string; stale_agents: string[] }[]
    const by = Object.fromEntries(list.map((r) => [r.slug, r]))
    expect(Object.keys(by).sort()).toEqual(['advisor', 'builder', 'builder-codex', 'deckhand', 'presenter', 'researcher', 'sub-captain', 'verifier'])
    expect(by['builder-codex'].status).toBe('ok')
    expect(by.researcher.status).toBe('harness_logged_out')
    expect(by.presenter.status).toBe('harness_logged_out')
    expect(by.builder.stale_agents).toEqual([])
    expect(by.verifier.stale_agents).toEqual(['ag_iris'])
  })

  test('resume writes: validation 400 names the field, create 201, duplicate 409, apply, delete', async () => {
    const body = { title: 'Fast', description: '', harness: 'codex', model: 'gpt-6-luna', effort: 'xhigh', can_hire: [], limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: 'x' }
    const bad = await J('POST', '/api/resumes', { ...body, slug: 'fast' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/^effort:/)
    expect((await J('POST', '/api/resumes', { ...body, slug: 'Bad Slug' })).status).toBe(400)
    const ok = await J('POST', '/api/resumes', { ...body, slug: 'fast', effort: 'low' })
    expect(ok.status).toBe(201)
    expect((await ok.json()).hash).toMatch(/^[0-9a-f]{12}$/)
    expect((await J('POST', '/api/resumes', { ...body, slug: 'fast', effort: 'low' })).status).toBe(409)
    expect((await J('POST', '/api/resumes/fast/duplicate', { slug: 'fast' })).status).toBe(409)
    expect((await J('POST', '/api/resumes/fast/duplicate', { slug: 'fast-2' })).status).toBe(201)
    const applied = await J('POST', '/api/resumes/verifier/apply').then((r) => r.json())
    expect(applied.updated).toEqual(['ag_iris'])
    expect((await fetch(`${U}/api/resumes/verifier`).then((r) => r.json())).stale_agents).toEqual([])
    expect((await J('DELETE', '/api/resumes/fast-2')).status).toBe(200)
    expect((await fetch(`${U}/api/resumes/fast-2`)).status).toBe(404)
  })

  test('test resume: running then pass; a logged-out harness fails with the reason', async () => {
    expect((await fetch(`${U}/api/resumes/verifier/test`)).status).toBe(404)
    const { check } = await J('POST', '/api/resumes/verifier/test').then((r) => r.json())
    expect(check).toMatchObject({ id: 'test.verifier', status: 'running' })
    await Bun.sleep(300)
    expect((await fetch(`${U}/api/resumes/verifier/test`).then((r) => r.json())).status).toBe('pass')
    await J('POST', '/api/resumes/researcher/test')
    await Bun.sleep(300)
    const out = await fetch(`${U}/api/resumes/researcher/test`).then((r) => r.json())
    expect(out.status).toBe('fail')
    expect(out.detail).toContain('not logged in')
  })

  test('captain: recent roots and start returns the attach command', async () => {
    const recent = await fetch(`${U}/api/captain/recent`).then((r) => r.json())
    expect(recent[0]).toBe('/home/demo/code/tortuga')
    expect((await J('POST', '/api/captain/start', { cwd: 'relative/dir' })).status).toBe(400)
    const res = await J('POST', '/api/captain/start', { cwd: '~/code/notes', model: 'haiku' }).then((r) => r.json())
    expect(res.attach).toBe('tmux attach -t sparrow-notes \\; select-window -t @41')
    expect((await fetch(`${U}/api/captain/recent`).then((r) => r.json()))[0]).toBe('/home/demo/code/notes')
  })
})

describe('mock server: captains (multi-captain §5)', () => {
  type S = { agent: { id: string; handle: string; fleet_id: string; captain: { title: string | null } }; status: string; unread: number; questions: number; fleet: { total: number; working: number }; resume: { command: string | null; attach: string | null } }
  const list = async (q = '') => (await fetch(`${U}/api/captains?project=tortuga${q}`).then((r) => r.json())) as S[]

  test('tortuga has captains in every status; archived only with ?archived=1; newest activity first', async () => {
    const live = await list()
    const all = await list('&archived=1')
    expect(all.length).toBe(live.length + 1)
    expect(new Set(all.map((s) => s.status))).toEqual(new Set(['working', 'attention', 'idle', 'archived']))
    expect(live.filter((s) => s.status === 'working').length).toBe(1)
    expect(live.some((s) => s.questions > 0)).toBe(true)
    expect(live.map((s) => s.agent.handle).sort()).toEqual(['cap-orion', 'cap-vega', 'captain'])
    for (const s of live) expect(s.agent.fleet_id).toBe(s.agent.id)
    const at = live.map((s) => (s as unknown as { last_activity_at: number }).last_activity_at)
    expect([...at].sort((a, b) => b - a)).toEqual(at)
    expect((await fetch(`${U}/api/captains`)).status).toBe(400)
  })

  test('detail: the fleet incl. a sub-captain with its own hires, all carrying fleet_id', async () => {
    const d = await fetch(`${U}/api/captains/cap-orion?project=tortuga`).then((r) => r.json()) as { agents: { id: string; depth: number; fleet_id: string; parent_id: string | null }[]; summary: S }
    expect(d.agents.every((a) => a.fleet_id === d.summary.agent.id)).toBe(true)
    expect(Math.max(...d.agents.map((a) => a.depth))).toBe(2)
    const agents = await fetch(`${U}/api/agents?project=tortuga`).then((r) => r.json()) as { fleet_id: string; captain: unknown; kind: string }[]
    expect(agents.every((a) => typeof a.fleet_id === 'string' && (a.kind === 'human') === (a.captain !== null))).toBe(true)
  })

  test('messages ?fleet= returns only that fleet', async () => {
    const msgs = await fetch(`${U}/api/messages?project=tortuga&fleet=ag_vega`).then((r) => r.json()) as { thread: string; kind: string }[]
    expect(msgs.length).toBeGreaterThan(3)
    expect(msgs.every((m) => m.thread.includes('ag_vega') || m.thread.includes('ag_kit') || m.thread.includes('ag_ana'))).toBe(true)
    expect(new Set(msgs.map((m) => m.kind))).toContain('result')
  })

  test('PATCH title/name/archived, name validation, agent.updated on SSE', async () => {
    const ctrl = new AbortController()
    const reader = (await fetch(`${U}/api/events?project=tortuga`, { signal: ctrl.signal })).body!.getReader()
    const r = await J('PATCH', '/api/captains/cap-vega?project=tortuga', { title: 'Dark mode on every page' }).then((x) => x.json())
    expect(r.agent.captain.title).toBe('Dark mode on every page')
    const ev = await nextEvent(reader, 'agent.updated')
    ctrl.abort()
    expect((ev as { agent: { handle: string } }).agent.handle).toBe('cap-vega')
    expect((await J('PATCH', '/api/captains/cap-vega?project=tortuga', { name: 'Bad Name' })).status).toBe(400)
    expect((await J('PATCH', '/api/captains/cap-vega?project=tortuga', { name: 'cap-orion' })).status).toBe(400)
    await J('PATCH', '/api/captains/cap-vega?project=tortuga', { archived: true })
    expect((await list()).some((s) => s.agent.handle === 'cap-vega')).toBe(false)
    await J('PATCH', '/api/captains/cap-vega?project=tortuga', { archived: false })
    expect((await list()).some((s) => s.agent.handle === 'cap-vega')).toBe(true)
  })

  test('resume: 409 with the attach line when open, 400 for opencode with the manual command, else a window', async () => {
    const open = await J('POST', '/api/captains/cap-orion/resume?project=tortuga')
    expect(open.status).toBe(409)
    expect((await open.json()).error).toContain('tmux attach')
    const codex = await J('POST', '/api/captains/cap-deneb/resume?project=tortuga')
    expect(codex.status).toBe(400)
    expect((await codex.json()).error).toContain('opencode -s')
    const ok = await J('POST', '/api/captains/cap-vega/resume?project=tortuga').then((x) => x.json())
    expect(ok.attach).toContain('tmux attach')
    expect(ok.agent_id).toBe('ag_vega')
  })

  test('start with name + title creates the captain row first and returns agent_id', async () => {
    const res = await J('POST', '/api/captain/start', { cwd: '~/code/tortuga-audit', title: 'Audit log for ledger edits', name: 'cap-audit' }).then((x) => x.json())
    expect(res.agent_id).toMatch(/^ag_/)
    const s = (await list()).find((x) => x.agent.id === res.agent_id)!
    expect(s.agent.handle).toBe('cap-audit')
    expect(s.agent.captain.title).toBe('Audit log for ledger edits')
    expect((await J('POST', '/api/captain/start', { cwd: '~/code/tortuga', name: 'cap-audit' })).status).toBe(400)
  })
})
