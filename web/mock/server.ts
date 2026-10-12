#!/usr/bin/env bun
// Mock Sparrow server for UI development and screenshots.
//   bun mock/server.ts [--port 4140] [--quiet] [--no-live]
// Implements the GET endpoints the UI reads, SSE /api/events, POST/PATCH /api/cards,
// and serves web/dist (SPA fallback) when it exists. Every request is logged to stdout
// and kept in memory: GET /__log returns it, POST /__log/reset clears it.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type {
  Agent, Call, Card, CardCreateReq, CardPatchReq, CardState, MessageKind, MessageView, Project, Resume, ServerEvent,
} from '../../src/shared/types'

const { values: argv } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: 'string' }, quiet: { type: 'boolean' }, 'no-live': { type: 'boolean' }, dist: { type: 'string' } },
})
const PORT = Number(argv.port ?? process.env.MOCK_PORT ?? 4140)
const DIST = resolve(argv.dist ?? join(import.meta.dir, '..', 'dist'))
const LIVE = !argv['no-live']

// ---------------------------------------------------------------- seed
// A wide (~170 col) Codex-style screen, like a real crash snapshot.
const IRIS_SCREEN = [
  '╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.162.1)   model: gpt-5.5 medium   directory: ~/Desktop/plutus   approval: never   sandbox: danger-full-access                                       │',
  '╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '',
  '• Ran bun test test/export --timeout 120000 2>&1 | tee /tmp/export-test.log',
  '  └ ✓ csv quoting > commas, quotes and embedded newlines round-trip through papaparse.unparse and papaparse.parse (12 cases) [41.22ms]',
  '    ✓ csv newlines (4) [3.10ms]',
  '    … export 50k rows via GET /api/export?from=2024-01-01&to=2026-10-01 (streaming, Content-Disposition: attachment; filename=ledger-2024-01-01_2026-10-01.csv)',
  '    error: JavaScript heap out of memory — allocation failed at Array.prototype.join (src/export/csv.ts:88:22) while buffering 50,000 rows before writing the response',
  '',
  '• Explored',
  '  └ Read src/export/csv.ts, src/api/export.ts',
  '',
  '▌ Session terminated (exit -1)',
].join('\n')

export function seed(now = Date.now()) {
  const min = 60_000
  const t = (minsAgo: number) => now - minsAgo * min
  const projects: Project[] = [
    { id: 'plutus', name: 'plutus', root: '/Users/vermarjun/Desktop/plutus', created_at: t(60 * 26) },
    { id: 'sparrow', name: 'sparrow', root: '/Users/vermarjun/Desktop/SWEFactory/sparrow', created_at: t(60 * 3) },
  ]
  const base = {
    project_id: 'plutus', model: null, effort: null, can_hire: [], last_end_reason: null, last_update: null,
    last_update_at: null, tmux_window_id: null, session_id: null, call_id: null, tmux_session: 'sparrow-plutus',
  }
  const A = (a: Partial<Agent> & Pick<Agent, 'id' | 'handle' | 'resume' | 'title' | 'harness' | 'state' | 'depth'>): Agent => ({
    ...base, kind: 'agent', parent_id: null, cwd: '/Users/vermarjun/Desktop/plutus', tmux_window: a.handle,
    last_seen_at: null, created_at: t(120), updated_at: t(1), ...a,
  } as Agent)
  const agents: Agent[] = [
    A({ id: 'ag_cap', handle: 'captain', kind: 'human', resume: 'captain', title: 'Captain', harness: 'human', state: 'idle', depth: 0, can_hire: ['*'], tmux_session: '', tmux_window: '', last_seen_at: t(2), created_at: t(180) }),
    A({ id: 'ag_maya', handle: 'maya', resume: 'sub-captain', title: 'Sub-captain', harness: 'claude', model: 'opus', effort: 'high', state: 'waiting', depth: 1, parent_id: 'ag_cap', can_hire: ['builder', 'builder-codex', 'verifier', 'researcher', 'presenter'], session_id: '3f9c2e1a-7b44-4c1e-9a0d-5e2c8b7d1f60', last_end_reason: 'wait', last_update: 'waiting: @james on the export endpoint, @iris on review', last_update_at: t(31), last_seen_at: t(31), created_at: t(170) }),
    A({ id: 'ag_james', handle: 'james', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'working', depth: 2, parent_id: 'ag_maya', session_id: '9b1d07c2-2a8e-4f5b-b3c1-1e6a2d9f4c88', call_id: 'call_j3', tmux_window_id: '@17', cwd: '/Users/vermarjun/Desktop/plutus-wt/export-csv', last_update: 'CSV writer done; 14/14 tests pass. Next: wire /api/export and stream large files', last_update_at: t(4), last_seen_at: t(1), created_at: t(150) }),
    A({ id: 'ag_leo', handle: 'leo', resume: 'builder', title: 'Builder', harness: 'claude', model: 'sonnet', effort: 'medium', state: 'queued', depth: 2, parent_id: 'ag_maya', created_at: t(12) }),
    A({ id: 'ag_iris', handle: 'iris', resume: 'verifier', title: 'Verifier', harness: 'codex', model: 'gpt-5.5', effort: 'medium', state: 'crashed', depth: 2, parent_id: 'ag_maya', session_id: '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b', last_end_reason: 'crashed', last_update: 'running the integration suite against PR #41', last_update_at: t(22), last_seen_at: t(19), created_at: t(60) }),
    A({ id: 'ag_omar', handle: 'omar', resume: 'researcher', title: 'Researcher', harness: 'opencode', model: 'opencode/glm-5.1', effort: null, state: 'idle', depth: 1, parent_id: 'ag_cap', session_id: 'ses_6a1f9c03e2ffeX8kq', last_end_reason: 'done', last_update: 'Compared 3 CSV libs; papaparse wins on streaming', last_update_at: t(95), last_seen_at: t(88), created_at: t(140) }),
    A({ id: 'ag_nina', handle: 'nina', resume: 'presenter', title: 'Presenter', harness: 'opencode', state: 'retired', depth: 1, parent_id: 'ag_cap', last_end_reason: 'released', created_at: t(300), last_update: 'deck v1 shipped', last_update_at: t(240) }),
    // second project
    { ...A({ id: 'ag_cap2', handle: 'captain', kind: 'human', resume: 'captain', title: 'Captain', harness: 'human', state: 'idle', depth: 0, can_hire: ['*'], tmux_session: '', tmux_window: '', cwd: '/Users/vermarjun/Desktop/SWEFactory/sparrow' }), project_id: 'sparrow' },
    { ...A({ id: 'ag_ada', handle: 'ada', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', state: 'idle', depth: 1, parent_id: 'ag_cap2', cwd: '/Users/vermarjun/Desktop/SWEFactory/sparrow', tmux_session: 'sparrow-sparrow' }), project_id: 'sparrow' },
  ]

  const calls: Call[] = [
    { id: 'call_m1', agent_id: 'ag_maya', started_at: t(168), ended_at: t(150), end_reason: 'wait', exit_code: null, resumed: false, nudges: 0, restarts: 0, prompt: '' },
    { id: 'call_m2', agent_id: 'ag_maya', started_at: t(96), ended_at: t(31), end_reason: 'wait', exit_code: null, resumed: true, nudges: 0, restarts: 0, prompt: '' },
    { id: 'call_j1', agent_id: 'ag_james', started_at: t(149), ended_at: t(118), end_reason: 'ask', exit_code: null, resumed: false, nudges: 0, restarts: 0, prompt: '' },
    { id: 'call_j2', agent_id: 'ag_james', started_at: t(112), ended_at: t(64), end_reason: 'crashed', exit_code: 137, resumed: true, nudges: 1, restarts: 0, prompt: '' },
    { id: 'call_j3', agent_id: 'ag_james', started_at: t(63), ended_at: null, end_reason: null, exit_code: null, resumed: true, nudges: 0, restarts: 1, prompt: '' },
    { id: 'call_i1', agent_id: 'ag_iris', started_at: t(58), ended_at: t(40), end_reason: 'crashed', exit_code: 1, resumed: false, nudges: 0, restarts: 0, prompt: '' },
    { id: 'call_i2', agent_id: 'ag_iris', started_at: t(39), ended_at: t(19), end_reason: 'crashed', exit_code: -1, resumed: true, nudges: 0, restarts: 1, prompt: '' },
    { id: 'call_o1', agent_id: 'ag_omar', started_at: t(139), ended_at: t(88), end_reason: 'done', exit_code: null, resumed: false, nudges: 2, restarts: 0, prompt: '' },
  ]

  const byId = new Map(agents.map((a) => [a.id, a]))
  const dm = (a: string, b: string) => `dm:${[a, b].sort().join(':')}`
  let seq = 0
  const messages: MessageView[] = []
  const msg = (from: string, thread: string, kind: MessageKind, text: string, minsAgo: number, extra: Partial<MessageView> = {}) => {
    const fromA = byId.get(from)
    const project_id = fromA?.project_id ?? 'plutus'
    let to: string[] = []
    let label = 'group'
    if (thread.startsWith('dm:')) {
      const [x, y] = thread.slice(3).split(':').map((id) => byId.get(id)!).sort((p, q) => p.depth - q.depth)
      label = `dm @${x.handle} ↔ @${y.handle}`
      to = [x, y].filter((p) => p.id !== from).map((p) => p.id)
    } else {
      to = [...text.matchAll(/@([a-z][a-z0-9-]*)/g)].map((m) => agents.find((a) => a.handle === m[1] && a.project_id === project_id)?.id).filter((x): x is string => !!x && x !== from)
    }
    const m: MessageView = {
      seq: ++seq, id: `msg_${seq}`, project_id, thread, from_id: fromA ? from : 'system', kind, text,
      mentions: kind === 'update' ? [] : to, card_id: null, meta: {}, created_at: t(minsAgo),
      from_handle: fromA?.handle ?? 'system', thread_label: label, to_handles: to.map((id) => byId.get(id)!.handle), ...extra,
    }
    messages.push(m)
    return m
  }
  const CM = dm('ag_cap', 'ag_maya'), MJ = dm('ag_maya', 'ag_james'), ML = dm('ag_maya', 'ag_leo'), MI = dm('ag_maya', 'ag_iris'), CO = dm('ag_cap', 'ag_omar'), CN = dm('ag_cap', 'ag_nina')
  msg('ag_cap', CN, 'task', 'Make a 6-slide deck on the export plan for Friday.', 300)
  msg('ag_nina', CN, 'result', 'Deck is at `docs/export-plan.html` (6 slides, speaker notes included).', 240, { meta: { status: 'ok' } })
  msg('ag_cap', CM, 'task', 'Ship **CSV export** for the ledger (card #3). Split it: one builder on the writer + endpoint, a verifier on the PR. Report back when it is merged-ready.', 170, { card_id: 3 })
  msg('ag_cap', CO, 'task', 'Which CSV library streams best in Bun? Compare 3, cite sources, keep it short.', 140)
  msg('ag_maya', 'group', 'update', 'Plan: @james builds the writer + endpoint, then a verifier reviews the PR.', 160)
  msg('ag_maya', MJ, 'task', 'Build the CSV writer and `/api/export` in `~/Desktop/plutus-wt/export-csv`. Stream rows, RFC 4180 quoting, tests for commas/quotes/newlines. Card #3.', 150, { card_id: 3 })
  msg('ag_james', 'group', 'update', 'reading ledger schema; writer goes in src/export/csv.ts', 146)
  msg('ag_omar', 'group', 'update', 'searching: bun csv streaming benchmarks', 132)
  msg('ag_james', MJ, 'question', 'Should amounts be exported as **minor units** (integers) or formatted decimals? The UI shows decimals, the DB stores minor units.', 118)
  msg('system', MJ, 'system', '@james is waiting on your answer.', 117)
  msg('ag_maya', MJ, 'chat', 'Formatted decimals with 2 places, no thousands separator. Add a `--raw` flag later if anyone asks.', 112)
  msg('ag_omar', CO, 'result', '## CSV libraries for Bun\n\n| lib | streaming | notes |\n|---|---|---|\n| papaparse | yes | mature, 7 KB |\n| csv-stringify | yes | node streams only |\n| fast-csv | yes | heavier |\n\n**Pick papaparse.** Sources: npm docs, 2 benchmark posts (links in `notes/csv.md`).', 88, { meta: { status: 'ok' } })
  msg('ag_james', 'group', 'update', 'writer + 9 tests passing; starting endpoint', 75)
  msg('system', MJ, 'system', '@james crashed (exit 137); restarting on the same session.', 64, { meta: { about: 'ag_james', exit_code: 137 } })
  msg('ag_maya', 'group', 'chat', '@omar thanks — @james use papaparse for the endpoint stream, see notes/csv.md', 60)
  msg('ag_maya', MI, 'task', 'Review PR #41 (CSV export). Run the suite, try a 50k-row export, check quoting. Report pass/fail with evidence.', 58)
  msg('ag_iris', 'group', 'update', 'running the integration suite against PR #41', 22)
  // Same text shape as T1 (core.ts): notice + "\nLast screen:\n<screen>\nSend @x a message to resume it."
  msg('system', MI, 'system', `@iris crashed (exit -1) and its automatic restart was already used.\nLast screen:\n${IRIS_SCREEN}\nSend @iris a message to resume it.`, 19, { meta: { about: 'ag_iris', exit_code: -1, screen: IRIS_SCREEN } })
  msg('ag_maya', ML, 'task', 'Add a "Download CSV" button to the ledger page that calls `/api/export`. Card #6.', 12, { card_id: 6 })
  msg('ag_maya', CM, 'update', 'waiting: @james on the export endpoint, @iris on review', 31)
  msg('ag_james', 'group', 'update', 'endpoint streams with papaparse; 14/14 tests pass', 8)
  msg('ag_james', MJ, 'chat', 'Endpoint is up behind `GET /api/export?from=&to=`. @maya want a progress header for big exports?', 6)
  msg('ag_james', 'group', 'update', 'CSV writer done; 14/14 tests pass. Next: wire /api/export and stream large files', 4)
  msg('ag_maya', CM, 'question', 'The verifier (@iris) ran out of memory on the 50k-row test. Raise the test limit to 10k rows, or should I have @james fix the memory use first?', 3)
  msg('ag_cap2', dm('ag_cap2', 'ag_ada'), 'task', 'Write the README quickstart.', 30)
  msg('ag_ada', dm('ag_cap2', 'ag_ada'), 'result', 'Quickstart added (`README.md` §1). Took 4 commands end to end.', 20, { meta: { status: 'ok' } })

  const C = (id: number, state: CardState, position: number, title: string, extra: Partial<Card> = {}): Card => ({
    id, project_id: 'plutus', title, details: '', category: null, state, position, assignee_id: null, created_by: 'ag_cap', notes: [], created_at: t(200 - id * 5), updated_at: t(100 - id * 3), ...extra,
  })
  const cards: Card[] = [
    C(1, 'done', 1, 'Ledger schema: amounts in minor units', { category: 'db', assignee_id: 'ag_james', notes: [{ at: t(190), by: 'ag_james', text: 'migration 0007 applied' }] }),
    C(2, 'done', 2, 'Research: CSV library for Bun', { category: 'research', assignee_id: 'ag_omar', notes: [{ at: t(88), by: 'ag_omar', text: 'papaparse — see notes/csv.md' }] }),
    C(3, 'in_progress', 1, 'CSV export for the ledger', { category: 'export', assignee_id: 'ag_james', details: 'Stream rows, RFC 4180 quoting.\n\n**Acceptance**\n- 50k rows export in < 3 s\n- commas, quotes, newlines round-trip\n- `GET /api/export?from=&to=`', notes: [{ at: t(150), by: 'ag_maya', text: 'assigned to @james' }, { at: t(75), by: 'ag_james', text: 'writer + 9 tests passing' }, { at: t(8), by: 'ag_james', text: 'endpoint streams; 14/14 tests' }] }),
    C(4, 'review', 1, 'PR #41 review: export quoting + memory', { category: 'export', assignee_id: 'ag_iris', notes: [{ at: t(58), by: 'ag_maya', text: 'assigned to @iris' }, { at: t(19), by: 'system', text: '@iris crashed: out of memory on 50k rows' }] }),
    C(5, 'todo', 1, 'Date-range picker on the ledger page', { category: 'ui' }),
    C(6, 'in_progress', 2, 'Download CSV button', { category: 'ui', assignee_id: 'ag_leo', notes: [{ at: t(12), by: 'ag_maya', text: 'assigned to @leo (queued)' }] }),
    C(7, 'todo', 2, 'Rate-limit /api/export', { category: 'server' }),
    C(8, 'proposed', 1, 'Export as XLSX too', { category: 'export', created_by: 'ag_omar', details: 'papaparse can’t, but SheetJS streams. Users asked twice.' }),
    C(9, 'proposed', 2, 'Progress header for long exports', { category: 'export', created_by: 'ag_james' }),
    C(10, 'todo', 3, 'Docs: export API in README', { category: 'docs' }),
    C(11, 'dropped', 1, 'PDF statements (out of scope for v1)', { category: 'export' }),
    { ...C(12, 'todo', 1, 'README quickstart', { assignee_id: 'ag_ada' }), project_id: 'sparrow' },
  ]

  const resumes: Resume[] = [
    ['sub-captain', 'Sub-captain', 'claude', 'opus', 'high', ['builder', 'builder-codex', 'verifier', 'researcher', 'presenter'], 'Owns one slice: plans, hires, reviews, reports.'],
    ['builder', 'Builder', 'claude', 'opus', 'high', [], 'Implements one task end to end in the given folder, runs it, reports evidence.'],
    ['builder-codex', 'Builder (Codex)', 'codex', 'gpt-5.5', 'medium', [], 'Same as builder, on Codex.'],
    ['verifier', 'Verifier', 'codex', 'gpt-5.5', 'medium', [], 'Read-only checker: runs tests, tries edge cases, reports pass/fail with evidence.'],
    ['researcher', 'Researcher', 'opencode', 'opencode/glm-5.1', null, [], 'Reads widely, cites sources, writes a short digest.'],
    ['presenter', 'Presenter', 'opencode', null, null, [], 'Turns findings into a short HTML deck.'],
  ].map(([slug, title, harness, model, effort, can_hire, description]) => ({
    slug, title, harness, model, effort, can_hire, description, limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: `You are a ${title}.`, path: `~/.sparrow/resumes/${slug}.md`,
  }) as Resume)

  return { projects, agents, calls, messages, cards, resumes, nextSeq: () => ++seq }
}

const JAMES_SCREEN = `╭────────────────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code!                                  │
│   cwd: ~/Desktop/plutus-wt/export-csv                      │
╰────────────────────────────────────────────────────────────╯

> [sparrow] 1 new message for @james (project plutus):
  ── task from @maya · 12:10 · card #3 ──
  Build the CSV writer and /api/export …

⏺ Read(src/ledger/schema.ts)
  ⎿  Read 84 lines

⏺ Write(src/export/csv.ts)
  ⎿  Wrote 112 lines to src/export/csv.ts

⏺ Bash(bun test test/export)
  ⎿  14 pass
     0 fail
     Ran 14 tests across 2 files. [212ms]

⏺ Bash(sparrow update "CSV writer done; 14/14 tests pass. Next: wire /api/export")
  ⎿  Posted update.
`

// ---------------------------------------------------------------- state + server
const db = seed()
const screens = new Map<string, { text: string; at: number }>([
  ['ag_james', { text: JAMES_SCREEN, at: Date.now() }],
  ['ag_iris', { text: IRIS_SCREEN, at: Date.now() - 19 * 60_000 }],
])
type Sub = { project: string | null; send: (ev: ServerEvent) => void }
const subs = new Set<Sub>()
const log: { at: number; method: string; path: string; body?: unknown }[] = []

function emit(ev: ServerEvent) {
  for (const s of subs) if (!s.project || s.project === ev.project_id) s.send(ev)
}
const json = (data: unknown, status = 200) => Response.json(data, { status })
const err = (status: number, error: string) => json({ error }, status)

function threadsFor(project: string) {
  const rows = new Map<string, { thread: string; label: string; members: string[]; last: MessageView; count: number }>()
  for (const m of db.messages) {
    if (m.project_id !== project) continue
    const r = rows.get(m.thread)
    if (r) { r.last = m; r.count++ } else {
      const members = m.thread === 'group' ? [] : m.thread_label.replace(/^dm /, '').split(' ↔ ').map((h) => h.slice(1))
      rows.set(m.thread, { thread: m.thread, label: m.thread_label, members, last: m, count: 1 })
    }
  }
  return [...rows.values()].sort((a, b) => (a.thread === 'group' ? -1 : b.thread === 'group' ? 1 : b.last.created_at - a.last.created_at))
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
  if (p === '/api/resumes') return json(db.resumes)
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
  if (p === '/api/cards' && req.method === 'POST') {
    const b = body as CardCreateReq & { project?: string }
    if (!b?.title || !b.project) return err(400, 'title and project are required')
    const inCol = db.cards.filter((c) => c.project_id === b.project && c.state === (b.state ?? 'todo'))
    const card: Card = {
      id: Math.max(...db.cards.map((c) => c.id)) + 1, project_id: b.project, title: b.title, details: b.details ?? '', category: b.category ?? null,
      state: b.state ?? 'todo', position: Math.max(0, ...inCol.map((c) => c.position)) + 1, assignee_id: null, created_by: 'user', notes: [],
      created_at: Date.now(), updated_at: Date.now(),
    }
    db.cards.push(card)
    emit({ type: 'card.updated', project_id: card.project_id, card })
    return json({ card })
  }
  if ((m = p.match(/^\/api\/cards\/(\d+)$/)) && req.method === 'PATCH') {
    const card = db.cards.find((c) => c.id === Number(m![1]))
    if (!card) return err(404, 'no such card')
    const b = (body ?? {}) as CardPatchReq
    if (b.state) card.state = b.state
    if (typeof b.position === 'number') card.position = b.position
    if (b.title) card.title = b.title
    if (typeof b.details === 'string') card.details = b.details
    if (b.note) card.notes.push({ at: Date.now(), by: 'user', text: b.note })
    card.updated_at = Date.now()
    emit({ type: 'card.updated', project_id: card.project_id, card })
    return json({ card })
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
const SCRIPT: [string, string, MessageKind, string][] = [
  ['ag_james', 'group', 'update', 'added Content-Disposition + filename with the date range'],
  ['ag_james', 'group', 'update', '50k-row export: 1.9 s, 38 MB peak (was 410 MB)'],
  ['ag_maya', 'group', 'chat', '@james nice — push it and I will re-hire @iris on the same session'],
  ['ag_james', 'group', 'update', 'pushed to PR #41; running the full suite once more'],
  ['ag_james', 'group', 'update', 'suite green: 61/61'],
]
let step = 0
function liveTick() {
  const [from, thread, kind, text] = SCRIPT[step % SCRIPT.length]
  step++
  const a = db.agents.find((x) => x.id === from)!
  const prev = db.messages[db.messages.length - 1]
  const seq = db.nextSeq()
  const to = [...text.matchAll(/@([a-z][a-z0-9-]*)/g)].map((m) => db.agents.find((x) => x.handle === m[1] && x.project_id === a.project_id)).filter((x) => x && x.id !== from) as Agent[]
  const m: MessageView = {
    ...prev, seq, id: `msg_${seq}`, project_id: a.project_id, thread, from_id: from, kind, text, mentions: kind === 'update' ? [] : to.map((x) => x.id),
    card_id: kind === 'update' ? 3 : null, meta: {}, created_at: Date.now(), from_handle: a.handle, thread_label: 'group', to_handles: to.map((x) => x.handle),
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
