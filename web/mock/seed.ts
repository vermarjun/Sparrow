// Multi-captain seed for the mock server (docs/plans/multi-captain.md §7).
// Project plutus: 8 captains in every status (2 working with nested fleets, one with a sub-captain that has its own
// hires; 1 with a pending question; 1 with unread results; idle ones; 1 archived; 1 without a title).
// Project sparrow: 2 captains. Updates travel on the dm thread with the parent, like the real server (core.ts).
import type { Agent, Call, CaptainInfo, Card, HarnessName, MessageKind, MessageView, Project } from '../../src/shared/types'
import { seedCards } from './cards'

const HOME = '/Users/vermarjun'
const min = 60_000

export const dm = (a: string, b: string) => `dm:${[a, b].sort().join(':')}`

// A wide (~170 col) Codex-style screen, like a real crash snapshot.
export const IRIS_SCREEN = [
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

export const JAMES_SCREEN = `╭────────────────────────────────────────────────────────────╮
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

export const ZOE_SCREEN = `╭───────────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.162.1)  model: gpt-6.1-sol high             │
│    directory: ~/Desktop/plutus-feat1                            │
╰───────────────────────────────────────────────────────────────╯

• Explored
  └ Read src/auth/login.ts, src/auth/session.ts, src/lib/redis.ts

• Edited src/auth/rateLimit.ts (+88 -0)
  └ sliding-window counter keyed by ip + account, 5 tries / 15 min

• Ran bun test test/auth
  └ 23 pass, 0 fail  [1.42s]

• Ran sparrow update "limiter wired into POST /login; 23/23 auth tests pass"
  └ Update posted.

▌ Working (2m 41s · esc to interrupt)
`

export const KIT_SCREEN = `╭────────────────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code!                                  │
│   cwd: ~/Desktop/SWEFactory/sparrow-captains-ui            │
╰────────────────────────────────────────────────────────────╯

⏺ Read(web/src/lib/captains.ts)
  ⎿  Read 212 lines

⏺ Update(web/src/components/shell/Sidebar.tsx)
  ⎿  Updated with 41 additions and 7 removals

⏺ Bash(cd web && bun run typecheck)
  ⎿  (no output)

✻ Shimmying… (1m 12s · ↓ 3.1k tokens)
`

export interface Seed {
  projects: Project[]
  agents: Agent[]
  calls: Call[]
  messages: MessageView[]
  cards: Card[]
  screens: Map<string, { text: string; at: number }>
  nextSeq: () => number
}

type AgentSpec = Partial<Agent> & Pick<Agent, 'id' | 'handle' | 'resume' | 'title' | 'harness' | 'state'>
type CaptainSpec = {
  id: string; handle: string; project?: string; cwd: string; title: string | null; branch: string | null
  harness: CaptainInfo['harness']; origin: CaptainInfo['origin']; session_id: string | null
  last_seen: number; created: number; archived?: number; window?: { session: string; window: string; id: string }
}

export function seed(now = Date.now()): Seed {
  const t = (minsAgo: number) => now - minsAgo * min
  const projects: Project[] = [
    { id: 'plutus', name: 'plutus', root: `${HOME}/Desktop/plutus`, created_at: t(60 * 24 * 9) },
    { id: 'sparrow', name: 'sparrow', root: `${HOME}/Desktop/SWEFactory/sparrow`, created_at: t(60 * 30) },
  ]
  const agents: Agent[] = []
  const byId = new Map<string, Agent>()
  const put = (a: Agent) => { agents.push(a); byId.set(a.id, a); return a }

  const captain = (c: CaptainSpec) => put({
    id: c.id, project_id: c.project ?? 'plutus', handle: c.handle, kind: 'human', resume: 'captain', title: 'Captain', harness: 'human',
    model: null, effort: null, can_hire: ['*'], parent_id: null, depth: 0, cwd: c.cwd,
    tmux_session: c.window?.session ?? '', tmux_window: c.window?.window ?? '', tmux_window_id: c.window?.id ?? null,
    session_id: c.session_id, state: 'idle', call_id: null, last_end_reason: null, last_update: null, last_update_at: null,
    last_seen_at: t(c.last_seen), resume_hash: null, last_run: null, fleet_id: c.id,
    captain: { title: c.title, branch: c.branch, harness: c.harness, origin: c.origin, archived_at: c.archived != null ? t(c.archived) : null },
    created_at: t(c.created), updated_at: t(c.last_seen),
  })
  // A hire: fleet_id and depth come from the parent; tmux session follows §3.6 (root handle 'captain' → sparrow-<project>).
  const hire = (parent: string, a: AgentSpec & { created: number; seen?: number; upd?: [string, number] }) => {
    const p = byId.get(parent)!
    const root = byId.get(p.fleet_id)!
    const project = p.project_id
    const tmux = root.handle === 'captain' ? `sparrow-${project}` : `sparrow-${project}-${root.handle}`
    const { created, seen, upd, ...rest } = a
    return put({
      project_id: project, kind: 'agent', model: null, effort: null, can_hire: [], parent_id: parent, depth: p.depth + 1,
      cwd: p.cwd, tmux_session: tmux, tmux_window: a.handle, tmux_window_id: a.state === 'working' ? `@${30 + agents.length}` : null,
      session_id: a.state === 'queued' ? null : fakeSession(a.harness as HarnessName, a.id), call_id: a.state === 'working' ? `call_${a.id.slice(3)}_open` : null,
      last_end_reason: null, last_update: upd?.[0] ?? null, last_update_at: upd ? t(upd[1]) : null,
      last_seen_at: seen != null ? t(seen) : upd ? t(upd[1]) : null, resume_hash: null,
      last_run: a.state === 'queued' ? null : { harness: a.harness, model: a.model ?? null, effort: a.effort ?? null, at: t(Math.max(1, (upd?.[1] ?? 10) + 5)) },
      fleet_id: root.id, captain: null, created_at: t(created), updated_at: t(Math.min(created, upd?.[1] ?? created)),
      ...rest,
    } as Agent)
  }

  // ------------------------------------------------------------------ plutus · @captain — CSV export (sub-captain @maya with hires)
  captain({ id: 'ag_cap', handle: 'captain', cwd: `${HOME}/Desktop/plutus`, title: 'CSV export for the ledger', branch: 'feat/csv-export', harness: 'claude', origin: 'terminal', session_id: '5d1e0c7a-3b2f-4a19-8e6d-0c4b7a9f2e13', last_seen: 5, created: 60 * 26 })
  hire('ag_cap', { id: 'ag_maya', handle: 'maya', resume: 'sub-captain', title: 'Sub-captain', harness: 'claude', model: 'opus', effort: 'high', state: 'waiting', can_hire: ['builder', 'builder-codex', 'verifier', 'researcher', 'presenter'], session_id: '3f9c2e1a-7b44-4c1e-9a0d-5e2c8b7d1f60', last_end_reason: 'wait', upd: ['waiting: @james on the export endpoint, @iris on review', 31], created: 170 })
  hire('ag_maya', { id: 'ag_james', handle: 'james', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'working', session_id: '9b1d07c2-2a8e-4f5b-b3c1-1e6a2d9f4c88', call_id: 'call_j3', tmux_window_id: '@17', last_run: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high', at: t(63) }, cwd: `${HOME}/Desktop/plutus-wt/export-csv`, upd: ['CSV writer done; 14/14 tests pass. Next: wire /api/export and stream large files', 4], seen: 1, created: 150 })
  hire('ag_maya', { id: 'ag_leo', handle: 'leo', resume: 'builder', title: 'Builder', harness: 'claude', model: 'sonnet', effort: 'medium', state: 'queued', created: 12 })
  hire('ag_maya', { id: 'ag_iris', handle: 'iris', resume: 'verifier', title: 'Verifier', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', state: 'crashed', session_id: '0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b', last_end_reason: 'crashed', upd: ['running the integration suite against PR #41', 22], seen: 19, created: 60 })
  hire('ag_cap', { id: 'ag_omar', handle: 'omar', resume: 'researcher', title: 'Researcher', harness: 'opencode', model: 'opencode/glm-5.1', state: 'idle', session_id: 'ses_6a1f9c03e2ffeX8kq', last_end_reason: 'done', upd: ['Compared 3 CSV libs; papaparse wins on streaming', 95], seen: 88, created: 140 })
  hire('ag_cap', { id: 'ag_nina', handle: 'nina', resume: 'presenter', title: 'Presenter', harness: 'opencode', state: 'retired', last_end_reason: 'released', upd: ['deck v1 shipped', 240], created: 300 })

  // ------------------------------------------------------------------ plutus · @cap-orion — rate limiting (working, sub-captain @kai with hires)
  const orionCwd = `${HOME}/Desktop/plutus-feat1`
  captain({ id: 'ag_orion', handle: 'cap-orion', cwd: orionCwd, title: 'Rate limiting for login', branch: 'feat/login-rate-limit', harness: 'claude', origin: 'sparrow', session_id: '7f3a9c21-8d4e-4b6a-9f10-2e5c7d8a1b34', last_seen: 9, created: 60 * 5, window: { session: 'sparrow-plutus-cap-orion', window: 'cap-orion', id: '@52' } })
  hire('ag_orion', { id: 'ag_kai', handle: 'kai', resume: 'sub-captain', title: 'Sub-captain', harness: 'claude', model: 'opus', effort: 'high', state: 'waiting', can_hire: ['builder', 'builder-codex', 'verifier'], last_end_reason: 'wait', upd: ['waiting: @zoe on the limiter, @finn queued for review', 14], created: 280 })
  hire('ag_kai', { id: 'ag_zoe', handle: 'zoe', resume: 'builder-codex', title: 'Builder (Codex)', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'working', upd: ['limiter wired into POST /login; 23/23 auth tests pass', 3], seen: 1, created: 240 })
  hire('ag_kai', { id: 'ag_finn', handle: 'finn', resume: 'verifier', title: 'Verifier', harness: 'claude', model: 'sonnet', effort: 'medium', state: 'queued', created: 8 })
  hire('ag_orion', { id: 'ag_ravi', handle: 'ravi', resume: 'researcher', title: 'Researcher', harness: 'claude', model: 'sonnet', state: 'idle', last_end_reason: 'done', upd: ['reading the Upstash and Cloudflare docs on sliding windows', 250], created: 285 })

  // ------------------------------------------------------------------ plutus · @cap-vega — duplicate invoice emails (needs you: question)
  captain({ id: 'ag_vega', handle: 'cap-vega', cwd: `${HOME}/Desktop/plutus-wt/dup-invoice`, title: 'Fix duplicate invoice emails', branch: 'fix/dup-invoice-email', harness: 'claude', origin: 'terminal', session_id: 'c2b8e4f1-6a3d-4e7b-a0c9-8f1d2e3b4a56', last_seen: 40, created: 60 * 3 })
  hire('ag_vega', { id: 'ag_mia', handle: 'mia', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'waiting', last_end_reason: 'ask', upd: ['idempotency key on the send job; need a call on the backfill', 24], created: 150 })
  hire('ag_vega', { id: 'ag_theo', handle: 'theo', resume: 'researcher', title: 'Researcher', harness: 'claude', model: 'sonnet', state: 'idle', last_end_reason: 'done', upd: ['tracing the invoice.sent webhook retries', 50], created: 170 })

  // ------------------------------------------------------------------ plutus · @cap-lyra — bank feed v2 (needs you: unread results, Codex captain)
  captain({ id: 'ag_lyra', handle: 'cap-lyra', cwd: `${HOME}/Desktop/plutus-wt/bank-feed`, title: 'Bank feed reconciliation v2', branch: 'feat/bank-feed-v2', harness: 'codex', origin: 'terminal', session_id: '0199b1e2-4c5d-7e6f-8a9b-0c1d2e3f4a5b', last_seen: 75, created: 60 * 8 })
  hire('ag_lyra', { id: 'ag_sam', handle: 'sam', resume: 'builder-codex', title: 'Builder (Codex)', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'idle', last_end_reason: 'done', upd: ['matcher handles split payments; 31 tests', 58], created: 400 })
  hire('ag_lyra', { id: 'ag_ivy', handle: 'ivy', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'idle', last_end_reason: 'done', upd: ['Plaid sandbox returns 401; checking the keys', 46], created: 380 })
  hire('ag_lyra', { id: 'ag_noah', handle: 'noah', resume: 'verifier', title: 'Verifier', harness: 'claude', model: 'sonnet', effort: 'medium', state: 'idle', last_end_reason: 'done', upd: ['running the reconciliation suite on main + PR #57', 36], created: 120 })

  // ------------------------------------------------------------------ plutus · @cap-sirius — Postgres 17 (idle, done)
  captain({ id: 'ag_sirius', handle: 'cap-sirius', cwd: `${HOME}/Desktop/plutus-wt/pg17`, title: 'Upgrade to Postgres 17', branch: 'chore/postgres-17', harness: 'claude', origin: 'sparrow', session_id: '4e6f8a0b-1c2d-4e3f-9a5b-6c7d8e9f0a1b', last_seen: 60 * 19, created: 60 * 30 })
  hire('ag_sirius', { id: 'ag_eli', handle: 'eli', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'retired', last_end_reason: 'released', upd: ['pg_upgrade dry run clean on a prod snapshot', 60 * 23], created: 60 * 29 })
  hire('ag_sirius', { id: 'ag_ana', handle: 'ana', resume: 'verifier', title: 'Verifier', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', state: 'idle', last_end_reason: 'done', upd: ['re-running 412 tests against pg17', 60 * 21], created: 60 * 24 })

  // ------------------------------------------------------------------ plutus · @cap-rigel — dark mode (idle, OpenCode captain)
  captain({ id: 'ag_rigel', handle: 'cap-rigel', cwd: `${HOME}/Desktop/plutus-wt/dark-mode`, title: 'Dark mode for the dashboard', branch: 'feat/dark-mode', harness: 'opencode', origin: 'terminal', session_id: 'ses_7b2e0d14f9aaY3mzQ', last_seen: 60 * 44, created: 60 * 50 })
  hire('ag_rigel', { id: 'ag_lea', handle: 'lea', resume: 'builder', title: 'Builder', harness: 'opencode', model: 'opencode/glm-5.1', state: 'idle', last_end_reason: 'done', upd: ['swapping hard-coded hex for tokens in 38 files', 60 * 46], created: 60 * 49 })

  // ------------------------------------------------------------------ plutus · @cap-altair — no title yet (fallback: branch), no hires
  captain({ id: 'ag_altair', handle: 'cap-altair', cwd: `${HOME}/Desktop/plutus-wt/ci-flakes`, title: null, branch: 'chore/ci-flakes', harness: 'claude', origin: 'sparrow', session_id: '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d', last_seen: 60 * 3, created: 60 * 3 + 10 })

  // ------------------------------------------------------------------ plutus · @cap-deneb — archived spike
  captain({ id: 'ag_deneb', handle: 'cap-deneb', cwd: `${HOME}/Desktop/plutus`, title: 'Spike: Plaid vs TrueLayer', branch: 'spike/open-banking', harness: 'claude', origin: 'terminal', session_id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b', last_seen: 60 * 24 * 4, created: 60 * 24 * 5, archived: 60 * 24 * 4 })
  hire('ag_deneb', { id: 'ag_otto', handle: 'otto', resume: 'researcher', title: 'Researcher', harness: 'claude', state: 'retired', last_end_reason: 'released', upd: ['pricing pages + API docs for both', 60 * 24 * 5 - 30], created: 60 * 24 * 5 })

  // ------------------------------------------------------------------ sparrow · two captains
  const spCwd = `${HOME}/Desktop/SWEFactory/sparrow`
  captain({ id: 'ag_cap2', handle: 'captain', project: 'sparrow', cwd: spCwd, title: 'README quickstart', branch: 'main', harness: 'claude', origin: 'terminal', session_id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', last_seen: 18, created: 60 * 30 })
  hire('ag_cap2', { id: 'ag_ada', handle: 'ada', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', state: 'idle', last_end_reason: 'done', upd: ['trying the 4 quickstart commands on a clean HOME', 24], created: 31 })
  captain({ id: 'ag_sorion', handle: 'cap-orion', project: 'sparrow', cwd: `${spCwd}-captains-ui`, title: 'Multi-captain web UI', branch: 'multi-captain-ui', harness: 'claude', origin: 'sparrow', session_id: '6d7e8f9a-0b1c-4d2e-8f3a-4b5c6d7e8f9a', last_seen: 2, created: 90, window: { session: 'sparrow-sparrow-cap-orion', window: 'cap-orion', id: '@61' } })
  hire('ag_sorion', { id: 'ag_kit', handle: 'kit', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'working', upd: ['sidebar groups + status glyphs in; typecheck clean', 2], seen: 1, created: 70 })

  // ------------------------------------------------------------------ messages
  let seq = 0
  const messages: MessageView[] = []
  const msg = (from: string, thread: string, kind: MessageKind, text: string, minsAgo: number, extra: Partial<MessageView> = {}) => {
    const fromA = byId.get(from)
    const [x, y] = thread.slice(3).split(':').map((id) => byId.get(id)!).sort((p, q) => p.depth - q.depth)
    const to = [x, y].filter((p) => p.id !== from)
    const m: MessageView = {
      seq: ++seq, id: `msg_${String(seq).padStart(4, '0')}`, project_id: x.project_id, thread, from_id: fromA ? from : 'system', kind, text,
      mentions: kind === 'update' ? [] : to.map((p) => p.id), card_id: null, meta: {}, created_at: t(minsAgo),
      from_handle: fromA?.handle ?? 'system', thread_label: `dm @${x.handle} ↔ @${y.handle}`, to_handles: to.map((p) => p.handle), ...extra,
    }
    messages.push(m)
    return m
  }
  const ok = (call_ms: number) => ({ meta: { status: 'ok', call_ms } })
  const status = (s: 'ok' | 'blocked' | 'failed', call_ms: number) => ({ meta: { status: s, call_ms } })

  // @captain fleet
  const CM = dm('ag_cap', 'ag_maya'), MJ = dm('ag_maya', 'ag_james'), ML = dm('ag_maya', 'ag_leo'), MI = dm('ag_maya', 'ag_iris'), CO = dm('ag_cap', 'ag_omar'), CN = dm('ag_cap', 'ag_nina')
  msg('ag_cap', CN, 'task', 'Make a 6-slide deck on the export plan for Friday: why finance needs it, the streaming design, the test plan, the rollout. Keep it skimmable.', 300)
  msg('ag_nina', CN, 'result', '## Result\nDeck is at `docs/export-plan.html` (6 slides, speaker notes included).\n## Evidence\nOpened it in Chrome at 1440 and 390 px; no overflow.\n## Next\nnone', 240, ok(41 * min))
  msg('ag_cap', CM, 'task', [
    'Ship **CSV export** for the ledger (card #3). You own it end to end.',
    '',
    '## Goal',
    'Finance downloads any date range of the ledger as CSV from the ledger page, in one click, for up to 1M rows.',
    '',
    '## Context',
    '- Ledger rows live in `src/ledger/` (schema in `schema.ts`). Amounts are stored in minor units.',
    '- Card #3 is the umbrella; #6 is the button, #4 the review.',
    '- @omar is comparing CSV libraries for Bun in parallel; use whatever he recommends.',
    '',
    '## Split',
    '1. One builder on the writer + `GET /api/export` (streaming, RFC 4180 quoting).',
    '2. One builder on the **Download CSV** button once the endpoint exists.',
    '3. A verifier on the PR: suite green, a 50k-row export, quoting edge cases.',
    '',
    '## Acceptance',
    '- `bun test test/export` green, plus a 50k-row export under 5 s and 100 MB.',
    '- The button works in light and dark, and shows progress for big ranges.',
    '',
    'Report back when it is merge-ready, with the PR link and evidence.',
  ].join('\n'), 170, { card_id: 3 })
  msg('ag_cap', CO, 'task', 'Which CSV library streams best in Bun? Compare 3, cite sources, keep it short.', 140)
  msg('ag_maya', CM, 'update', 'Plan: @james builds the writer + endpoint, then a verifier reviews the PR.', 160)
  msg('ag_maya', MJ, 'task', [
    'Build the CSV writer and `/api/export` in `~/Desktop/plutus-wt/export-csv` (card #3).',
    '',
    '- Stream rows; never buffer the whole range in memory.',
    '- RFC 4180 quoting; tests for commas, quotes and embedded newlines.',
    '- `GET /api/export?from=&to=` with `Content-Disposition: attachment; filename=ledger-<from>_<to>.csv`.',
    '- Amounts: ask me if the format is unclear.',
    '',
    'Done when `bun test test/export` is green and a 50k-row export streams.',
  ].join('\n'), 150, { card_id: 3 })
  msg('ag_james', MJ, 'update', 'reading ledger schema; writer goes in src/export/csv.ts', 146)
  msg('ag_omar', CO, 'update', 'searching: bun csv streaming benchmarks', 132)
  msg('ag_james', MJ, 'question', 'Should amounts be exported as **minor units** (integers) or formatted decimals? The UI shows decimals, the DB stores minor units.', 118)
  msg('ag_maya', MJ, 'chat', 'Formatted decimals with 2 places, no thousands separator. Add a `--raw` flag later if anyone asks.', 112)
  msg('ag_omar', CO, 'result', '## CSV libraries for Bun\n\n| lib | streaming | notes |\n|---|---|---|\n| papaparse | yes | mature, 7 KB |\n| csv-stringify | yes | node streams only |\n| fast-csv | yes | heavier |\n\n**Pick papaparse.** Sources: npm docs, 2 benchmark posts (links in `notes/csv.md`).', 88, ok(51 * min))
  msg('ag_james', MJ, 'update', 'writer + 9 tests passing; starting endpoint', 75)
  msg('system', MJ, 'system', '@james crashed (exit 137); restarting on the same session.', 64, { meta: { about: 'ag_james', exit_code: 137 } })
  msg('ag_maya', MJ, 'chat', 'Use papaparse for the endpoint stream (see notes/csv.md, from @omar).', 60)
  msg('ag_maya', MI, 'task', 'Review PR #41 (CSV export). Run the suite, try a 50k-row export, check quoting. Report pass/fail with evidence.', 58, { card_id: 4 })
  msg('ag_maya', CM, 'update', 'waiting: @james on the export endpoint, @iris on review', 31)
  msg('ag_iris', MI, 'update', 'running the integration suite against PR #41', 22)
  msg('system', MI, 'system', `@iris crashed (exit -1) and its automatic restart was already used.\nLast screen:\n${IRIS_SCREEN}\nSend @iris a message to resume it.`, 19, { meta: { about: 'ag_iris', exit_code: -1, screen: IRIS_SCREEN } })
  msg('ag_maya', ML, 'task', 'Add a **Download CSV** button to the ledger page that calls `/api/export` with the current date range. Card #6. Match the existing toolbar buttons; show a progress toast for ranges over 10k rows.', 12, { card_id: 6 })
  msg('ag_james', MJ, 'update', 'endpoint streams with papaparse; 14/14 tests pass', 8)
  msg('ag_james', MJ, 'chat', 'Endpoint is up behind `GET /api/export?from=&to=`. Want a progress header for big exports?', 6)
  msg('ag_james', MJ, 'update', 'CSV writer done; 14/14 tests pass. Next: wire /api/export and stream large files', 4)
  msg('ag_maya', CM, 'question', 'The verifier (@iris) ran out of memory on the 50k-row test. Raise the test limit to 10k rows, or should I have @james fix the memory use first?', 3)

  // @cap-orion fleet
  const OK = dm('ag_orion', 'ag_kai'), KZ = dm('ag_kai', 'ag_zoe'), KF = dm('ag_kai', 'ag_finn'), OR = dm('ag_orion', 'ag_ravi')
  msg('ag_orion', OR, 'task', 'Research: token bucket vs sliding window for login rate limiting on Redis. What do Upstash, Cloudflare and Stripe do? One page, with a recommendation.', 285)
  msg('ag_orion', OK, 'task', [
    'Add **rate limiting to login** (card #7 covers the export endpoint later; this is auth only).',
    '',
    '## Goal',
    'Stop credential stuffing without locking out real users: 5 failed tries per account + IP in 15 minutes, then a 429 with `Retry-After`.',
    '',
    '## Context',
    '- Login is `POST /login` in `src/auth/login.ts`. Redis is already a dependency (`src/lib/redis.ts`).',
    '- @ravi is researching the algorithm; wait for his result before building.',
    '- Security asked for an audit line per lockout (see #18).',
    '',
    '## Acceptance',
    '- Unit tests for the limiter, an e2e test for the 429 path, docs in `docs/auth.md`.',
    '- No change in p95 login latency (measure before/after).',
    '',
    'Hire a builder and a verifier. Report when the PR is green.',
  ].join('\n'), 280)
  msg('ag_ravi', OR, 'update', 'reading the Upstash and Cloudflare docs on sliding windows', 250)
  msg('ag_ravi', OR, 'result', [
    '## Result',
    '**Sliding window log, keyed by `account + ip`**, stored as a Redis sorted set with a 15 min TTL.',
    '',
    '| approach | burst-safe | memory | used by |',
    '|---|---|---|---|',
    '| token bucket | no (refills allow bursts) | O(1) | Stripe API |',
    '| fixed window | no (edge bursts) | O(1) | many |',
    '| sliding log | **yes** | O(n) per key, n ≤ 5 | Cloudflare login |',
    '',
    '## Evidence',
    'Sources in `notes/rate-limit.md` (6 links). Prototype: 0.3 ms per check on local Redis.',
    '## Next',
    'none',
  ].join('\n'), 244, ok(41 * min))
  msg('ag_kai', OK, 'update', 'Plan: @zoe builds the limiter on @ravi\'s design; @finn verifies once the PR is up.', 242)
  msg('ag_kai', KZ, 'task', [
    'Build the login rate limiter in `~/Desktop/plutus-feat1`.',
    '',
    '- Sliding-window log in Redis (`ZADD` + `ZREMRANGEBYSCORE`), key `rl:login:<account>:<ip>`, 5 tries / 15 min.',
    '- On the 6th try: `429` with `Retry-After` and one audit line.',
    '- Tests: unit tests for the window maths, one e2e test for the 429 path.',
    '',
    'Report with the test output and before/after p95 for `POST /login`.',
  ].join('\n'), 240)
  msg('ag_zoe', KZ, 'update', 'reading src/auth/login.ts and the redis helper', 236)
  msg('ag_zoe', KZ, 'question', 'Should a **successful** login reset the counter for that account + IP, or let it expire?', 180)
  msg('ag_kai', KZ, 'chat', 'Reset it on success. A user who finally gets it right should not stay half-locked.', 176)
  msg('ag_zoe', KZ, 'update', 'limiter + 17 unit tests passing; wiring into POST /login', 60)
  msg('ag_kai', OK, 'update', 'waiting: @zoe on the limiter, @finn queued for review', 14)
  msg('ag_kai', KF, 'task', 'Verify PR #62 (login rate limit): run `bun test`, hit `POST /login` 6 times from one IP and check the 429 + `Retry-After`, and compare p95 before/after with `bun scripts/bench-login.ts`. Pass/fail with evidence.', 8)
  msg('ag_zoe', KZ, 'update', 'limiter wired into POST /login; 23/23 auth tests pass', 3)

  // @cap-vega fleet — a question for the captain, and a result it has not read
  const VM = dm('ag_vega', 'ag_mia'), VT = dm('ag_vega', 'ag_theo')
  msg('ag_vega', VT, 'task', 'Customers get the same invoice email 2–4 times since Tuesday. Find out why. Check the send job, the webhook retries and the deploy log. Root cause only, no fix yet.', 170)
  msg('ag_theo', VT, 'update', 'tracing the invoice.sent webhook retries', 50)
  msg('ag_vega', VM, 'task', [
    'Fix the duplicate invoice emails in `~/Desktop/plutus-wt/dup-invoice`.',
    '',
    'Make the send job idempotent: one email per invoice per version, whatever the retries. Add a regression test that replays a webhook three times.',
  ].join('\n'), 150)
  msg('ag_theo', VT, 'result', [
    '## Result',
    'Root cause: the **SES webhook timeout went from 10 s to 3 s** in Tuesday\'s deploy (`infra/ses.tf`). Our handler takes ~4 s, SES retries, and each retry re-enqueues `sendInvoiceEmail` with no idempotency key.',
    '## Evidence',
    '- 1,284 duplicate sends since Tue 14:02, all with 2–4 retries in the SES log.',
    '- `git log -p infra/ses.tf` → commit `a41f9e2`.',
    '## Next',
    'Idempotency key on the job (`invoice_id + version`), and put the timeout back to 10 s.',
  ].join('\n'), 35, ok(2 * 60 * min + 15 * min))
  msg('ag_mia', VM, 'update', 'idempotency key on the send job; need a call on the backfill', 24)
  msg('ag_mia', VM, 'question', 'The fix stops new duplicates. **1,284 customers already got duplicates.** Should I (a) do nothing, (b) send one apology email per affected customer, or (c) just log them for support? I need this before I write the migration.', 22)

  // @cap-lyra fleet — three results the captain has not read (ok, blocked, failed)
  const LS = dm('ag_lyra', 'ag_sam'), LI = dm('ag_lyra', 'ag_ivy'), LN = dm('ag_lyra', 'ag_noah')
  msg('ag_lyra', LS, 'task', [
    'Rewrite the bank feed matcher (card #15). Today it matches on amount + date only and double-counts split payments.',
    '',
    '- Match on amount, date ± 2 days, and payee similarity.',
    '- A payment split across 2–3 ledger rows must match once.',
    '- Keep the old matcher behind `MATCHER=v1` for a week.',
  ].join('\n'), 400, { card_id: 15 })
  msg('ag_lyra', LI, 'task', 'Wire the Plaid sandbox into `scripts/feed-replay.ts` so we can replay a real month of transactions against the new matcher.', 380)
  msg('ag_sam', LS, 'update', 'matcher handles split payments; 31 tests', 58)
  msg('ag_ivy', LI, 'update', 'Plaid sandbox returns 401; checking the keys', 46)
  msg('ag_sam', LS, 'result', '## Result\nNew matcher in `src/feed/match.ts`: amount, date ± 2 days, payee trigram similarity ≥ 0.6, split payments matched once.\n## Evidence\n`bun test test/feed` → **31 pass, 0 fail**. Replay of September: 2,118 matched (was 1,962), 0 double counts.\n## Files\n`src/feed/match.ts`, `src/feed/split.ts`, `test/feed/*.test.ts`\n## Next\n`MATCHER=v1` fallback stays until Oct 27.', 50, ok(5 * 60 * min + 42 * min))
  msg('ag_ivy', LI, 'result', '## Result\nBlocked: the Plaid sandbox keys in 1Password (`plutus/plaid-sandbox`) are revoked; every call returns `401 INVALID_API_KEYS`.\n## Evidence\n`curl https://sandbox.plaid.com/accounts/get` → 401 with both key pairs.\n## Next\nSomeone with Plaid dashboard access has to rotate the sandbox secret.', 44, status('blocked', 4 * 60 * min + 30 * min))
  msg('ag_lyra', LN, 'task', 'Verify PR #57 (matcher v2): full suite, plus the September replay. Pass/fail with evidence.', 40)
  msg('ag_noah', LN, 'update', 'running the reconciliation suite on main + PR #57', 36)
  msg('ag_noah', LN, 'result', '## Result\n**Failed**: 3 of 41 reconciliation tests fail on PR #57.\n## Evidence\n```\n✗ reconcile > refunds net against the original payment\n✗ reconcile > partial refund keeps the remainder open\n✗ reconcile > currency rounding (JPY)\n38 pass, 3 fail\n```\nAll three involve refunds; the split-payment logic treats a refund as a third split.\n## Next\nSend back to @sam with the failing tests.', 30, status('failed', 6 * min))

  // @cap-sirius fleet — all done and read
  const SE = dm('ag_sirius', 'ag_eli'), SA = dm('ag_sirius', 'ag_ana')
  msg('ag_sirius', SE, 'task', 'Upgrade the dev and CI databases to Postgres 17. Dry-run `pg_upgrade` on last night\'s prod snapshot first; list every extension and its pg17 status.', 60 * 29)
  msg('ag_eli', SE, 'update', 'pg_upgrade dry run clean on a prod snapshot', 60 * 23)
  msg('ag_eli', SE, 'result', '## Result\nDev + CI on Postgres 17.2. `pg_upgrade --check` clean; all 4 extensions (`pgcrypto`, `pg_trgm`, `uuid-ossp`, `pg_stat_statements`) supported.\n## Evidence\n`docker compose up` → pg 17.2; CI run #812 green.\n## Next\nProd upgrade window needs a decision from ops.', 60 * 22, ok(6 * 60 * min))
  msg('ag_sirius', SA, 'task', 'Run the whole suite against pg17 and compare query plans for the 10 slowest queries.', 60 * 22 - 10)
  msg('ag_ana', SA, 'result', '## Result\nFailed: 2 tests depend on the old `jsonb` key order.\n## Evidence\n`bun test` → 410 pass, 2 fail (`test/ledger/export-json.test.ts`).', 60 * 21 - 20, status('failed', 38 * min))
  msg('ag_sirius', SA, 'chat', 'Fixed the key-order assumption in a8c1d0e. Please re-run.', 60 * 21 - 40)
  msg('ag_ana', SA, 'update', 're-running 412 tests against pg17', 60 * 21)
  msg('ag_ana', SA, 'result', '## Result\nPass: 412/412 on pg17. 8 of the 10 slow queries got faster (median −18 %); none regressed.\n## Evidence\n`bun test` → 412 pass. Plans in `notes/pg17-plans.md`.', 60 * 20 - 50, ok(31 * min))

  // @cap-rigel fleet
  const RL = dm('ag_rigel', 'ag_lea')
  msg('ag_rigel', RL, 'task', 'Dark mode for the dashboard (card #16): move every hard-coded colour to tokens, add a theme toggle in the header, respect the OS setting by default.', 60 * 49, { card_id: 16 })
  msg('ag_lea', RL, 'update', 'swapping hard-coded hex for tokens in 38 files', 60 * 46)
  msg('ag_lea', RL, 'result', '## Result\nDark mode shipped behind the header toggle; follows the OS by default.\n## Evidence\nScreenshots of all 9 pages in both themes in `docs/dark-mode/`; contrast checked with axe (0 issues).', 60 * 45, ok(3 * 60 * min + 50 * min))

  // @cap-deneb (archived)
  const DO = dm('ag_deneb', 'ag_otto')
  msg('ag_deneb', DO, 'task', 'Spike: compare Plaid and TrueLayer for UK + EU bank feeds: coverage, pricing, webhook reliability.', 60 * 24 * 5)
  msg('ag_otto', DO, 'result', '## Result\nTrueLayer for UK/EU (better coverage, flat pricing); keep Plaid for US. Details in `notes/open-banking.md`.', 60 * 24 * 4 - 60, ok(2 * 60 * min))

  // sparrow project
  const AD = dm('ag_cap2', 'ag_ada'), SK = dm('ag_sorion', 'ag_kit')
  msg('ag_cap2', AD, 'task', 'Write the README quickstart: install, `sparrow up`, start a captain, hire a builder. Four commands, tested on a clean HOME.', 30)
  msg('ag_ada', AD, 'update', 'trying the 4 quickstart commands on a clean HOME', 24)
  msg('ag_ada', AD, 'result', '## Result\nQuickstart added (`README.md` §1). Took 4 commands end to end.', 20, ok(10 * min))
  msg('ag_sorion', SK, 'task', 'Build the captains sidebar: groups Needs you · Working · Idle, status glyphs, hue avatars, keyboard nav.', 70)
  msg('ag_kit', SK, 'update', 'sidebar groups + status glyphs in; typecheck clean', 2)

  // Agents carry their latest result (the real API adds last_result on read paths).
  for (const a of agents) {
    const r = [...messages].reverse().find((m) => m.from_id === a.id && m.kind === 'result')
    a.last_result = r ? { status: (r.meta.status as 'ok' | 'blocked' | 'failed') ?? 'ok', text: r.text, at: r.created_at } : null
  }

  // ------------------------------------------------------------------ calls (one per window lifetime)
  const calls: Call[] = []
  const call = (agent: string, started: number, ended: number | null, end_reason: Call['end_reason'], extra: Partial<Call> = {}) => {
    const a = byId.get(agent)!
    const c: Call = {
      id: `call_${agent.slice(3)}_${calls.filter((x) => x.agent_id === agent).length + 1}`, agent_id: agent, started_at: t(started), ended_at: ended == null ? null : t(ended),
      end_reason, exit_code: null, resumed: calls.some((x) => x.agent_id === agent), nudges: 0, restarts: 0, prompt: '',
      harness: a.harness === 'human' ? null : a.harness, model: a.model, effort: a.effort, ...extra,
    }
    calls.push(c)
    if (ended == null) a.call_id = c.id
    return c
  }
  call('ag_maya', 168, 150, 'wait'); call('ag_maya', 96, 31, 'wait')
  call('ag_james', 149, 118, 'ask'); call('ag_james', 112, 64, 'crashed', { exit_code: 137, nudges: 1 }); call('ag_james', 63, null, null, { restarts: 1 })
  call('ag_iris', 58, 40, 'crashed', { exit_code: 1 }); call('ag_iris', 39, 19, 'crashed', { exit_code: -1, restarts: 1 })
  call('ag_omar', 139, 88, 'done', { nudges: 2 }); call('ag_nina', 299, 240, 'done')
  call('ag_kai', 279, 242, 'wait'); call('ag_kai', 20, 14, 'wait')
  call('ag_zoe', 239, 180, 'ask'); call('ag_zoe', 176, null, null)
  call('ag_ravi', 284, 244, 'done')
  call('ag_theo', 169, 35, 'done'); call('ag_mia', 149, 22, 'ask')
  call('ag_sam', 399, 50, 'done'); call('ag_ivy', 379, 44, 'done'); call('ag_noah', 39, 30, 'done')
  call('ag_eli', 60 * 29, 60 * 22, 'done'); call('ag_ana', 60 * 22, 60 * 21 - 20, 'done'); call('ag_ana', 60 * 21 - 30, 60 * 20 - 50, 'done')
  call('ag_lea', 60 * 49, 60 * 45, 'done'); call('ag_otto', 60 * 24 * 5, 60 * 24 * 4 - 60, 'done')
  call('ag_ada', 30, 20, 'done'); call('ag_kit', 68, null, null)

  // ------------------------------------------------------------------ cards: spread over the fleets
  const cards = seedCards(now)
  const assign: Record<number, string> = { 7: 'ag_zoe', 18: 'ag_kai', 15: 'ag_sam', 23: 'ag_ivy', 26: 'ag_mia', 13: 'ag_theo', 25: 'ag_eli', 22: 'ag_ana', 16: 'ag_lea', 29: 'ag_altair', 21: 'ag_lyra' }
  for (const c of cards) if (assign[c.id]) c.assignee_id = assign[c.id]
  const c7 = cards.find((c) => c.id === 7)
  if (c7) c7.state = 'in_progress'
  const c16 = cards.find((c) => c.id === 16)
  if (c16) c16.state = 'done'

  const screens = new Map<string, { text: string; at: number }>([
    ['ag_james', { text: JAMES_SCREEN, at: now }],
    ['ag_iris', { text: IRIS_SCREEN, at: t(19) }],
    ['ag_zoe', { text: ZOE_SCREEN, at: now }],
    ['ag_kit', { text: KIT_SCREEN, at: now }],
  ])

  return { projects, agents, calls, messages, cards, screens, nextSeq: () => ++seq }
}

function fakeSession(h: HarnessName, id: string): string {
  let x = 0
  for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) >>> 0
  const hex = (n: number, len: number) => ((x * (n + 7)) >>> 0).toString(16).padStart(8, '0').repeat(2).slice(0, len)
  if (h === 'opencode') return `ses_${hex(1, 12)}X${id.slice(3, 6)}`
  if (h === 'codex') return `0199${hex(2, 4)}-${hex(3, 4)}-7${hex(4, 3)}-8${hex(5, 3)}-${hex(6, 12)}`
  return `${hex(7, 8)}-${hex(8, 4)}-4${hex(9, 3)}-9${hex(10, 3)}-${hex(11, 12)}`
}
