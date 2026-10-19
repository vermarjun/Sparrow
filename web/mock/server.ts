#!/usr/bin/env bun
// Mock Sparrow server for UI development and screenshots.
//   bun mock/server.ts [--port 4140] [--quiet] [--no-live] [--doctor-done] [--no-projects]
// Implements the GET endpoints the UI reads, SSE /api/events, POST/PATCH /api/cards,
// and the U1 endpoints (catalog, doctor, resumes, captain; see mock/u1.ts),
// and serves web/dist (SPA fallback) when it exists. Every request is logged to stdout
// and kept in memory: GET /__log returns it, POST /__log/reset clears it.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type {
  CardCreateReq, CardPatchReq, MessageKind, MessageView, ServerEvent,
} from '../../src/shared/types'
import { parseCardRef } from '../../src/shared/cards'
import { createCard, patchCard } from './cards'
import { createCaptains } from './captains'
import { dm, seed } from './seed'
import { createU1 } from './u1'

const { values: argv } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' }, quiet: { type: 'boolean' }, 'no-live': { type: 'boolean' }, dist: { type: 'string' },
    'doctor-done': { type: 'boolean' }, 'no-projects': { type: 'boolean' },
  },
})
const PORT = Number(argv.port ?? process.env.MOCK_PORT ?? 4140)
const DIST = resolve(argv.dist ?? join(import.meta.dir, '..', 'dist'))
const LIVE = !argv['no-live'] && !argv['no-projects']

// ---------------------------------------------------------------- seed (mock/seed.ts: multi-captain world)

// ---------------------------------------------------------------- state + server
const db = seed()
if (argv['no-projects']) { db.projects.length = 0; db.agents.length = 0; db.messages.length = 0; db.cards.length = 0 }
const screens = db.screens
type Sub = { project: string | null; send: (ev: ServerEvent) => void }
const subs = new Set<Sub>()
const log: { at: number; method: string; path: string; body?: unknown }[] = []

function emit(ev: ServerEvent) {
  for (const s of subs) if (!s.project || ev.project_id === '*' || s.project === ev.project_id) s.send(ev)
}
const captains = createCaptains(db, emit)
const u1 = createU1({ agents: db.agents, emit, startCaptain: captains.start }, { doctorMs: Number(process.env.MOCK_DOCTOR_MS ?? 8000), doctorDone: !!argv['doctor-done'] })
const json = (data: unknown, status = 200) => Response.json(data, { status })
const err = (status: number, error: string) => json({ error }, status)

function threadsFor(project: string) {
  const rows = new Map<string, { thread: string; label: string; members: string[]; last: MessageView; count: number }>()
  for (const m of db.messages) {
    if (m.project_id !== project) continue
    const r = rows.get(m.thread)
    if (r) { r.last = m; r.count++ } else {
      const members = m.thread_label.replace(/^dm /, '').split(' ↔ ').map((h) => h.slice(1))
      rows.set(m.thread, { thread: m.thread, label: m.thread_label, members, last: m, count: 1 })
    }
  }
  return [...rows.values()].sort((a, b) => b.last.created_at - a.last.created_at)
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.json().catch(() => undefined)
  if (p.startsWith('/api/') || p.startsWith('/__')) {
    if (p !== '/__log') {
      log.push({ at: Date.now(), method: req.method, path: p + url.search, body })
      if (!argv.quiet) console.log(`${new Date().toISOString().slice(11, 23)} ${req.method} ${p}${url.search}${body ? ' ' + JSON.stringify(body) : ''}`)
    }
  }
  const project = url.searchParams.get('project')

  if (p === '/__log') return json(log)
  if (p === '/__log/reset' && req.method === 'POST') { log.length = 0; return json({ ok: true }) }
  if (p === '/api/health') return json({ ok: true, version: 'mock', pid: process.pid, started_at: Date.now() })
  if (p === '/api/projects') {
    return json(db.projects.map((pr) => ({
      ...pr,
      agents: db.agents.filter((a) => a.project_id === pr.id && a.kind !== 'human').length,
      working: db.agents.filter((a) => a.project_id === pr.id && a.state === 'working').length,
      cards: db.cards.filter((c) => c.project_id === pr.id).length,
    })))
  }
  const capRes = await captains.handle(req, url, body)
  if (capRes) return capRes
  const u1res = await u1.handle(req, p, body)
  if (u1res) return u1res
  if (p === '/api/agents') return json(db.agents.filter((a) => !project || a.project_id === project).sort((a, b) => b.created_at - a.created_at))
  let m: RegExpMatchArray | null
  if ((m = p.match(/^\/api\/agents\/([^/]+)$/))) {
    const agent = db.agents.find((a) => a.id === m![1] || a.handle === m![1].replace(/^@/, ''))
    if (!agent) return err(404, 'no such agent')
    return json({
      agent,
      calls: db.calls.filter((c) => c.agent_id === agent.id).sort((a, b) => b.started_at - a.started_at).slice(0, 20),
      children: db.agents.filter((a) => a.parent_id === agent.id),
    })
  }
  if ((m = p.match(/^\/api\/agents\/([^/]+)\/screen$/))) {
    const agent = db.agents.find((a) => a.id === m![1])
    if (!agent) return err(404, 'no such agent')
    const s = screens.get(agent.id)
    const live = agent.state === 'working'
    return json({ text: s?.text ?? '', live, at: live ? Date.now() : (s?.at ?? null) })
  }
  if (p === '/api/threads') return json(project ? threadsFor(project) : [])
  if (p === '/api/messages') {
    const thread = url.searchParams.get('thread')
    const after = Number(url.searchParams.get('after') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 100)
    const list = db.messages.filter((x) => (!project || x.project_id === project) && (!thread || x.thread === thread) && x.seq > after)
    return json(list.slice(-limit))
  }
  if (p === '/api/cards' && req.method === 'GET') return json(db.cards.filter((c) => !project || c.project_id === project))
  const ctx = () => ({
    cards: db.cards,
    agentHandle: (ref: string) => {
      const h = ref.replace(/^@/, '')
      const a = db.agents.find((x) => x.id === ref || x.handle === h)
      return a ? { id: a.id, handle: a.handle } : null
    },
  })
  if (p === '/api/cards' && req.method === 'POST') {
    const b = body as CardCreateReq & { project?: string }
    if (!b?.title || !b.project) return err(400, 'title and project are required')
    const made = createCard(ctx(), b.project, b)
    if (typeof made === 'string') return err(400, made)
    db.cards.push(made)
    emit({ type: 'card.updated', project_id: made.project_id, card: made })
    return json({ card: made })
  }
  if ((m = p.match(/^\/api\/cards\/([^/]+)$/))) {
    const id = parseCardRef(decodeURIComponent(m[1]))
    const card = id == null ? undefined : db.cards.find((c) => c.id === id)
    if (!card) return err(404, 'no such card')
    if (req.method === 'GET') return json(card)
    if (req.method === 'PATCH') {
      const fail = patchCard({ ...ctx(), cards: db.cards }, card, (body ?? {}) as CardPatchReq)
      if (fail) return err(400, fail)
      emit({ type: 'card.updated', project_id: card.project_id, card })
      return json({ card })
    }
  }
  if (p === '/api/events') {
    let sub: Sub
    let ping: ReturnType<typeof setInterval>
    const stream = new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder()
        const write = (s: string) => { try { ctrl.enqueue(enc.encode(s)) } catch { /* closed */ } }
        sub = { project, send: (ev) => write(`data: ${JSON.stringify(ev)}\n\n`) }
        subs.add(sub)
        write(': connected\n\n')
        ping = setInterval(() => write(': ping\n\n'), 15000)
        req.signal.addEventListener('abort', () => { subs.delete(sub); clearInterval(ping) })
      },
      cancel() { subs.delete(sub); clearInterval(ping) },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
  }
  if (p.startsWith('/api/')) return err(404, `mock: ${req.method} ${p} is not implemented (the UI should not call it)`)

  // static web/dist with SPA fallback
  if (existsSync(DIST)) {
    const file = Bun.file(join(DIST, p === '/' ? 'index.html' : p))
    if (p !== '/' && !p.includes('..') && (await file.exists())) return new Response(file)
    return new Response(Bun.file(join(DIST, 'index.html')))
  }
  return new Response('web/dist not built; run `bun run build` or use `bun run dev:mock`', { status: 404 })
}

// ---------------------------------------------------------------- live activity
// Two working fleets keep moving: @james (under @maya, @captain's fleet) and @zoe (under @kai, @cap-orion's fleet).
const SCRIPT: [from: string, to: string, kind: MessageKind, text: string][] = [
  ['ag_james', 'ag_maya', 'update', 'added Content-Disposition + filename with the date range'],
  ['ag_zoe', 'ag_kai', 'update', 'e2e: 6th POST /login from one IP → 429, Retry-After: 900'],
  ['ag_james', 'ag_maya', 'update', '50k-row export: 1.9 s, 38 MB peak (was 410 MB)'],
  ['ag_zoe', 'ag_kai', 'update', 'p95 POST /login 41 ms → 42 ms with the limiter'],
  ['ag_maya', 'ag_james', 'chat', 'Nice. Push it and I will re-hire @iris on the same session.'],
  ['ag_james', 'ag_maya', 'update', 'pushed to PR #41; running the full suite once more'],
  ['ag_zoe', 'ag_kai', 'update', 'docs/auth.md: lockout section + audit line format'],
  ['ag_james', 'ag_maya', 'update', 'suite green: 61/61'],
]
let step = 0
function liveTick() {
  const [from, toId, kind, text] = SCRIPT[step % SCRIPT.length]
  step++
  const a = db.agents.find((x) => x.id === from)!
  const b = db.agents.find((x) => x.id === toId)!
  const [x, y] = [a, b].sort((p, q) => p.depth - q.depth)
  const seq = db.nextSeq()
  const m: MessageView = {
    seq, id: `msg_${String(seq).padStart(4, '0')}`, project_id: a.project_id, thread: dm(a.id, b.id), from_id: from, kind, text,
    mentions: kind === 'update' ? [] : [b.id], card_id: null, meta: {}, created_at: Date.now(), from_handle: a.handle,
    thread_label: `dm @${x.handle} ↔ @${y.handle}`, to_handles: [b.handle],
  }
  db.messages.push(m)
  emit({ type: 'message.created', project_id: m.project_id, message: m })
  a.last_seen_at = Date.now()
  if (kind === 'update') {
    a.last_update = text
    a.last_update_at = Date.now()
    const s = screens.get(a.id)
    if (s) s.text += `\n⏺ Bash(sparrow update "${text}")\n  ⎿  Posted update.\n`
  }
  a.updated_at = Date.now()
  emit({ type: 'agent.updated', project_id: a.project_id, agent: a })
}

if (import.meta.main) {
  const server = Bun.serve({ port: PORT, hostname: '127.0.0.1', idleTimeout: 0, fetch: handle })
  if (LIVE) setInterval(liveTick, Number(process.env.MOCK_TICK_MS ?? 6000))
  console.log(`sparrow mock on http://127.0.0.1:${server.port}${existsSync(DIST) ? ' (serving web/dist)' : ''}`)
}

export { handle }
