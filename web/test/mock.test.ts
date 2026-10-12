// The mock server mirrors the real API shapes the UI relies on (CONTRACT §4).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Card, ServerEvent } from '../../src/shared/types'

const PORT = 4143
let proc: ReturnType<typeof Bun.spawn>
const U = `http://127.0.0.1:${PORT}`

beforeAll(async () => {
  proc = Bun.spawn(['bun', `${import.meta.dir}/../mock/server.ts`, '--port', String(PORT), '--quiet', '--no-live', '--dist', '/nonexistent'], { stdout: 'ignore', stderr: 'inherit' })
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
    expect(projects.map((p: { id: string }) => p.id)).toContain('plutus')
    const agents = await fetch(`${U}/api/agents?project=plutus`).then((r) => r.json())
    const states = new Set(agents.map((a: { state: string }) => a.state))
    for (const s of ['working', 'queued', 'crashed', 'waiting', 'idle']) expect(states.has(s)).toBe(true)
    const threads = await fetch(`${U}/api/threads?project=plutus`).then((r) => r.json())
    expect(threads[0].thread).toBe('group')
    const kinds = new Set<string>()
    for (const t of threads) for (const m of await fetch(`${U}/api/messages?project=plutus&thread=${encodeURIComponent(t.thread)}`).then((r) => r.json())) kinds.add(m.kind)
    expect([...kinds].sort()).toEqual(['chat', 'question', 'result', 'system', 'task', 'update'])
  })

  test('PATCH a card emits card.updated on SSE and is logged', async () => {
    await fetch(`${U}/__log/reset`, { method: 'POST' })
    const ctrl = new AbortController()
    const res = await fetch(`${U}/api/events?project=plutus`, { signal: ctrl.signal })
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
