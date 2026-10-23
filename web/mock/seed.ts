// Demo world for the mock server and the README screenshots: project tortuga (card prefix TOR) with three captains
// (one working, one waiting on you, one idle) plus an archived one, and a second project, tortuga-ledger.
// Updates travel on the dm thread with the parent, like the real server (core.ts, docs/DESIGN.md).
import type { Agent, Call, CaptainInfo, Card, HarnessName, MessageKind, MessageView, Project } from '../../src/shared/types'
import { seedCards } from './cards'

const HOME = '/home/demo'
const min = 60_000

export const dm = (a: string, b: string) => `dm:${[a, b].sort().join(':')}`

// What the working agents' tmux panes look like in the Screen peek (Claude Code and Codex TUIs).
export const MAYA_SCREEN = `╭────────────────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code!                                  │
│   cwd: ~/code/tortuga-auth                                 │
╰────────────────────────────────────────────────────────────╯

> [sparrow] 1 new message for @maya (project tortuga):
  ── task from @captain · card #4 ──
  Add rate limiting to login …

⏺ Read(src/auth/login.ts)
  ⎿  Read 96 lines

⏺ Write(src/auth/rateLimit.ts)
  ⎿  Wrote 88 lines to src/auth/rateLimit.ts

⏺ Update(src/auth/login.ts)
  ⎿  Updated with 14 additions and 2 removals

⏺ Bash(bun test test/auth)
  ⎿  23 pass
     0 fail
     Ran 23 tests across 4 files. [1.42s]

⏺ Bash(sparrow update "limiter wired into POST /login; 23/23 pass")
  ⎿  Update posted.

✻ Writing the 429 end-to-end test… (2m 41s · ↓ 3.1k tokens)
`

export const LEO_SCREEN = `╭───────────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.162.1)  model: gpt-6.1-sol high             │
│    directory: ~/code/tortuga-auth                               │
╰───────────────────────────────────────────────────────────────╯

• Explored
  └ Read docs/auth.md, src/auth/session.ts

• Edited docs/auth.md (+42 -3)
  └ new "Lockouts" section: 5 tries / 15 min, 429 + Retry-After

• Ran bun test test/auth/e2e.test.ts
  └ ✓ sixth failed login from one address returns 429 [96ms]
    ✓ Retry-After counts down with the window [41ms]
    2 pass, 0 fail

• Ran sparrow update "e2e 429 path covered; docs/auth.md updated"
  └ Update posted.

▌ Working (1m 08s · esc to interrupt)
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
    { id: 'tortuga', name: 'tortuga', root: `${HOME}/code/tortuga`, created_at: t(60 * 24 * 9) },
    { id: 'tortuga-ledger', name: 'tortuga-ledger', root: `${HOME}/code/tortuga-ledger`, created_at: t(60 * 30) },
  ]
  const agents: Agent[] = []
  const byId = new Map<string, Agent>()
  const put = (a: Agent) => { agents.push(a); byId.set(a.id, a); return a }

  const captain = (c: CaptainSpec) => put({
    id: c.id, project_id: c.project ?? 'tortuga', handle: c.handle, kind: 'human', resume: 'captain', title: 'Captain', harness: 'human',
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

  // ------------------------------------------------------------------ tortuga · @captain: rate limiting for login (working, 5 hires)
  const authCwd = `${HOME}/code/tortuga-auth`
  captain({ id: 'ag_cap', handle: 'captain', cwd: authCwd, title: 'Rate limiting for login', branch: 'feat/login-rate-limit', harness: 'claude', origin: 'terminal', session_id: '5d1e0c7a-3b2f-4a19-8e6d-0c4b7a9f2e13', last_seen: 5, created: 60 * 6 })
  hire('ag_cap', { id: 'ag_maya', handle: 'maya', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'working', session_id: '9b1d07c2-2a8e-4f5b-b3c1-1e6a2d9f4c88', tmux_window_id: '@17', last_run: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high', at: t(63) }, upd: ['limiter wired into POST /login; 23/23 auth tests pass', 4], seen: 1, created: 300 })
  hire('ag_cap', { id: 'ag_leo', handle: 'leo', resume: 'builder-codex', title: 'Builder (Codex)', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'working', tmux_window_id: '@18', upd: ['e2e 429 path covered; docs/auth.md has a Lockouts section', 3], seen: 1, created: 125 })
  hire('ag_cap', { id: 'ag_iris', handle: 'iris', resume: 'verifier', title: 'Verifier', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'idle', last_end_reason: 'done', upd: ['PASS: 6/6 checks on PR #62', 25], seen: 25, created: 110 })
  hire('ag_cap', { id: 'ag_juno', handle: 'juno', resume: 'researcher', title: 'Researcher', harness: 'opencode', model: 'opencode-go/kimi-k3', state: 'idle', last_end_reason: 'done', upd: ['reading the Upstash and Cloudflare docs on sliding windows', 285], seen: 262, created: 310 })
  hire('ag_cap', { id: 'ag_pip', handle: 'pip', resume: 'deckhand', title: 'Deckhand', harness: 'claude', model: 'haiku', effort: 'medium', state: 'queued', created: 2 })

  // ------------------------------------------------------------------ tortuga · @cap-orion: webhook retries (waiting on you; sub-captain @sage has two hires)
  const hooksCwd = `${HOME}/code/tortuga-webhooks`
  captain({ id: 'ag_orion', handle: 'cap-orion', cwd: hooksCwd, title: 'Webhook retries with backoff', branch: 'feat/webhook-backoff', harness: 'claude', origin: 'sparrow', session_id: '7f3a9c21-8d4e-4b6a-9f10-2e5c7d8a1b34', last_seen: 25, created: 60 * 5, window: { session: 'sparrow-tortuga-cap-orion', window: 'cap-orion', id: '@52' } })
  hire('ag_orion', { id: 'ag_sage', handle: 'sage', resume: 'sub-captain', title: 'Sub-captain', harness: 'claude', model: 'opus', effort: 'high', state: 'waiting', can_hire: ['builder', 'builder-codex', 'verifier', 'researcher', 'deckhand', 'advisor'], last_end_reason: 'ask', upd: ['waiting on your call: retry budget (5 vs 8 attempts)', 17], created: 200 })
  hire('ag_sage', { id: 'ag_otto', handle: 'otto', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'idle', last_end_reason: 'done', upd: ['backoff scheduler + 14 tests', 40], created: 185 })
  hire('ag_sage', { id: 'ag_vera', handle: 'vera', resume: 'verifier', title: 'Verifier', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'idle', last_end_reason: 'done', upd: ['failing endpoint retried on schedule', 30], created: 38 })

  // ------------------------------------------------------------------ tortuga · @cap-vega: dark mode for settings (idle, everything read)
  captain({ id: 'ag_vega', handle: 'cap-vega', cwd: `${HOME}/code/tortuga-dark`, title: 'Dark mode for settings', branch: 'feat/settings-dark-mode', harness: 'claude', origin: 'terminal', session_id: 'c2b8e4f1-6a3d-4e7b-a0c9-8f1d2e3b4a56', last_seen: 30, created: 60 * 4 })
  hire('ag_vega', { id: 'ag_kit', handle: 'kit', resume: 'builder-codex', title: 'Builder (Codex)', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'idle', last_end_reason: 'done', upd: ['31 colors moved to tokens; axe clean in both themes', 55], created: 140 })
  hire('ag_vega', { id: 'ag_ana', handle: 'ana', resume: 'advisor', title: 'Advisor', harness: 'claude', model: 'opus', effort: 'medium', state: 'idle', last_end_reason: 'done', upd: ['recommends following the OS setting by default', 62], created: 70 })

  // ------------------------------------------------------------------ tortuga · @cap-deneb: archived spike
  captain({ id: 'ag_deneb', handle: 'cap-deneb', cwd: `${HOME}/code/tortuga`, title: 'Spike: queue libraries for webhooks', branch: 'spike/queue-libs', harness: 'opencode', origin: 'terminal', session_id: 'ses_7b2e0d14f9aaY3mzQ', last_seen: 60 * 24 * 4, created: 60 * 24 * 5, archived: 60 * 24 * 4 })
  hire('ag_deneb', { id: 'ag_rex', handle: 'rex', resume: 'researcher', title: 'Researcher', harness: 'opencode', model: 'opencode-go/kimi-k3', state: 'retired', last_end_reason: 'released', upd: ['compared three queue libraries', 60 * 24 * 4 - 60], created: 60 * 24 * 5 })

  // ------------------------------------------------------------------ tortuga-ledger: one captain, one hire
  captain({ id: 'ag_cap2', handle: 'captain', project: 'tortuga-ledger', cwd: `${HOME}/code/tortuga-ledger`, title: 'Ledger CSV export', branch: 'feat/csv-export', harness: 'claude', origin: 'terminal', session_id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', last_seen: 18, created: 60 * 30 })
  hire('ag_cap2', { id: 'ag_noor', handle: 'noor', resume: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: 'high', state: 'idle', last_end_reason: 'done', upd: ['streams 50k rows in 1.9 s', 24], created: 31 })

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

  // @captain fleet: rate limiting for login
  const CJ = dm('ag_cap', 'ag_juno'), CM = dm('ag_cap', 'ag_maya'), CL = dm('ag_cap', 'ag_leo'), CI = dm('ag_cap', 'ag_iris'), CP = dm('ag_cap', 'ag_pip')
  msg('ag_cap', CJ, 'task', 'Research: token bucket vs sliding window for login rate limiting on Redis. What do Upstash, Cloudflare and Stripe do? One page, with a recommendation.', 310)
  msg('ag_juno', CJ, 'update', 'reading the Upstash and Cloudflare docs on sliding windows', 285)
  msg('ag_juno', CJ, 'result', [
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
  ].join('\n'), 262, ok(41 * min))
  msg('ag_cap', CM, 'task', [
    'Add **rate limiting to login** (card #4). You own it end to end.',
    '',
    '## Goal',
    'Stop credential stuffing without locking out real users: 5 failed tries per account + IP in 15 minutes, then a 429 with `Retry-After`.',
    '',
    '## Context',
    '- Login is `POST /login` in `src/auth/login.ts`. Redis is already a dependency (`src/lib/redis.ts`).',
    '- @juno is researching the algorithm; use his recommendation.',
    '- Security asked for an audit line per lockout (card #13 covers the full audit log later).',
    '',
    '## Acceptance',
    '- Unit tests for the limiter, an e2e test for the 429 path (@leo), docs in `docs/auth.md`.',
    '- No change in p95 login latency (measure before and after).',
    '',
    'Report back with the PR link and test output.',
  ].join('\n'), 290, { card_id: 4 })
  msg('ag_maya', CM, 'update', 'reading src/auth/login.ts and the redis helper', 240)
  msg('ag_maya', CM, 'question', 'Should a **successful** login reset the counter for that account + IP, or let it expire?', 190)
  msg('ag_cap', CM, 'chat', 'Reset it on success. A user who finally gets it right should not stay half-locked.', 185)
  msg('ag_maya', CM, 'update', 'limiter + 17 unit tests passing; wiring into POST /login', 120)
  msg('system', CM, 'system', '@maya was quiet for 15 minutes and got a nudge. It answered with an update.', 95, { meta: { about: 'ag_maya' } })
  msg('ag_cap', CL, 'task', 'Write the end-to-end test for the 429 path (6th failed login from one address) and document lockouts in `docs/auth.md`. Card #4. @maya owns the limiter; do not edit `src/auth/rateLimit.ts`.', 125, { card_id: 4 })
  msg('ag_leo', CL, 'update', 'e2e harness boots the app with an in-memory Redis', 100)
  msg('ag_cap', CI, 'task', 'Verify PR #62 (login rate limit): run `bun test`, hit `POST /login` 6 times from one IP and check the 429 + `Retry-After`, fire 50 parallel logins and compare p95 before/after. Pass/fail per check, with evidence.', 110, { card_id: 6 })
  msg('ag_iris', CI, 'result', [
    '## Result',
    '**Failed**: 4 of 6 checks pass; the limiter is not atomic and `Retry-After` is off at the window edge.',
    '## Evidence',
    '| check | result |',
    '|---|---|',
    '| `bun test` (auth) | PASS · 23/23 |',
    '| 6th failed login → 429 | PASS |',
    '| `Retry-After` matches the window | FAIL · 899 s, expected 900 s |',
    '| 50 parallel logins → 5 attempts, 45 refusals | FAIL · 7 attempts got through |',
    '| counter resets after a successful login | PASS |',
    '| p95 latency before/after | PASS · 41 ms → 42 ms |',
    '## Next',
    'Make the `ZADD` + `EXPIRE` pair atomic (one `MULTI`) and round `Retry-After` up. Re-verify after the fix.',
  ].join('\n'), 70, status('failed', 38 * min))
  msg('ag_cap', CM, 'chat', 'Iris found two failures on PR #62: the counter races under parallel logins and `Retry-After` is off by a second. Please fix both.', 68)
  msg('ag_maya', CM, 'update', 'fixed: ZADD + EXPIRE in one MULTI, Retry-After rounds up (c91e4ad)', 50)
  msg('ag_cap', CI, 'task', 'Re-verify PR #62 at c91e4ad. Same six checks.', 45)
  msg('ag_iris', CI, 'result', [
    '## Result',
    '**Pass**: 6/6 checks on PR #62 at `c91e4ad`.',
    '## Evidence',
    '| check | result |',
    '|---|---|',
    '| `bun test` (auth) | PASS · 23/23 |',
    '| `Retry-After` matches the window | PASS · 900 s |',
    '| 50 parallel logins → 5 attempts, 45 refusals | PASS |',
    '| p95 latency before/after | PASS · 41 ms → 42 ms |',
    '## Files',
    '`src/auth/rateLimit.ts`, `test/auth/rateLimit.test.ts`',
    '## Next',
    'none',
  ].join('\n'), 25, ok(19 * min))
  msg('ag_leo', CL, 'update', 'e2e 429 path covered; docs/auth.md has a Lockouts section', 3)
  msg('ag_maya', CM, 'update', 'limiter wired into POST /login; 23/23 auth tests pass', 4)
  msg('ag_cap', CP, 'task', 'Bump the lockfile (`bun install`) and check that `bun install --frozen-lockfile` passes on the CI image. One-shot: report when done.', 2)

  // @cap-orion fleet: webhook retries; sage asks for a decision
  const OS = dm('ag_orion', 'ag_sage'), SO = dm('ag_sage', 'ag_otto'), SV = dm('ag_sage', 'ag_vera')
  msg('ag_orion', OS, 'task', [
    'Add **retries with exponential backoff to webhook delivery** (card #5).',
    '',
    '## Goal',
    'A customer endpoint that is down for a few minutes must not lose events. Retry with growing delays, then park the delivery for replay.',
    '',
    '## Context',
    '- Delivery runs in `src/webhooks/deliver.ts`; today a 5xx or a timeout drops the event.',
    '- Delay doubles from one minute with ±20 % jitter.',
    '',
    '## Acceptance',
    '- Tests for the schedule and for a flapping endpoint; the dead-letter list is card #10 and out of scope here.',
    '',
    'Hire a builder and a verifier. Ask me about anything that changes customer-visible behaviour.',
  ].join('\n'), 200, { card_id: 5 })
  msg('ag_sage', OS, 'update', 'Plan: @otto builds the scheduler, @vera verifies once the PR is up.', 190)
  msg('ag_sage', SO, 'task', 'Build the retry scheduler in `src/webhooks/retry.ts`: delay = 1 min × 2^attempt with ±20 % jitter, attempt counter on the delivery row, worker picks due retries. Tests for the schedule and a flapping endpoint. Report with test output.', 185, { card_id: 5 })
  msg('ag_otto', SO, 'update', 'reading the queue worker and the delivery table', 170)
  msg('system', SO, 'system', '@otto crashed (exit 137); restarting on the same session.', 150, { meta: { about: 'ag_otto', exit_code: 137 } })
  msg('ag_otto', SO, 'update', 'scheduler in; jitter test flaky, seeding the RNG', 100)
  msg('ag_otto', SO, 'result', '## Result\nBackoff scheduler in `src/webhooks/retry.ts`; deliveries retry at 1, 2, 4, 8 and 16 minutes with ±20 % jitter.\n## Evidence\n`bun test test/webhooks` → **14 pass, 0 fail**. A flapping endpoint (down 3 minutes) delivers on the third retry.\n## Files\n`src/webhooks/retry.ts`, `src/webhooks/deliver.ts`, `test/webhooks/retry.test.ts`\n## Next\nThe retry budget (how many attempts) is hard-coded to 5 until someone decides.', 40, ok(2 * 60 * min + 25 * min))
  msg('ag_sage', SV, 'task', 'Verify the retry scheduler on branch `feat/webhook-backoff`: run `bun test`, point a webhook at a test endpoint that fails twice, and check the delivery times against the schedule. Pass/fail with evidence.', 38)
  msg('ag_vera', SV, 'update', 'endpoint failing twice, then healthy; reading delivery timestamps', 34)
  msg('ag_vera', SV, 'result', '## Result\n**Pass**: the failing endpoint was retried on schedule and delivered on attempt 3.\n## Evidence\n`bun test` → 61 pass, 0 fail. Attempt times: +0 s, +62 s, +189 s (expected 60 / 180 ± 20 %).\n## Next\nnone', 30, ok(8 * min))
  msg('ag_sage', OS, 'question', 'Retry budget: give up after **5 attempts (~31 min)** or **8 attempts (~4 h)**? Longer is friendlier to customers with slow incident response, but a dead endpoint then holds queue slots for hours. I need this before I build the dead-letter hand-off.', 18)
  msg('ag_sage', OS, 'update', 'waiting on your call: retry budget (5 vs 8 attempts)', 17)

  // @cap-vega fleet: finished and read
  const VK = dm('ag_vega', 'ag_kit'), VA = dm('ag_vega', 'ag_ana')
  msg('ag_vega', VK, 'task', 'Dark mode for the settings page (card #7): move every hard-coded color to tokens, check contrast in both themes, add screenshot tests.', 140, { card_id: 7 })
  msg('ag_kit', VK, 'update', 'swapping hard-coded hex for tokens in 6 files', 120)
  msg('ag_vega', VA, 'task', 'Question for you: should settings follow the OS theme by default, or only change when the user flips the toggle?', 70)
  msg('ag_ana', VA, 'result', '## Result\nFollow the OS by default, remember an explicit choice.\n## Evidence\nEvery other page already does this; a page that disagrees reads as a bug. Support tickets in the last month: 4 about the white flash, 0 asking for manual-only.\n## Next\nnone', 62, ok(7 * min))
  msg('ag_kit', VK, 'result', '## Result\nSettings now follows the theme tokens and the OS setting.\n## Evidence\n31 colors moved to tokens; `bun test test/ui` → **18 pass, 0 fail**; axe reports 0 issues in light and dark.\n## Files\n`src/ui/settings/*.tsx`, `test/ui/settings.shot.test.ts`\n## Next\nnone', 55, ok(1 * 60 * min + 20 * min))

  // @cap-deneb (archived)
  const DR = dm('ag_deneb', 'ag_rex')
  msg('ag_deneb', DR, 'task', 'Spike: compare BullMQ, Graphile Worker and a plain Postgres table for webhook retries: throughput, ops cost, failure modes.', 60 * 24 * 5)
  msg('ag_rex', DR, 'result', '## Result\nA plain Postgres table with `SKIP LOCKED` is enough at our volume (≈ 40 events/s peak) and adds no new service.\n## Evidence\nBenchmarks and trade-offs in `notes/queues.md`.\n## Next\nnone', 60 * 24 * 4 - 60, ok(2 * 60 * min))

  // tortuga-ledger
  const LN = dm('ag_cap2', 'ag_noor')
  msg('ag_cap2', LN, 'task', 'Add a streaming CSV export for the ledger (card #20). 50k rows must not buffer in memory.', 30)
  msg('ag_noor', LN, 'update', 'writer + 9 tests passing; starting the endpoint', 24)
  msg('ag_noor', LN, 'result', '## Result\n`GET /api/export?from=&to=` streams the ledger as RFC 4180 CSV.\n## Evidence\n`bun test test/export` → **14 pass, 0 fail**; 50k rows in 1.9 s, 38 MB peak.\n## Next\nnone', 20, ok(10 * min))

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
  call('ag_maya', 289, 186, 'ask'); call('ag_maya', 184, null, null, { nudges: 1 })
  call('ag_leo', 124, null, null)
  call('ag_iris', 109, 70, 'done'); call('ag_iris', 44, 25, 'done')
  call('ag_juno', 309, 262, 'done', { nudges: 1 })
  call('ag_sage', 199, 190, 'wait'); call('ag_sage', 18, 17, 'ask')
  call('ag_otto', 184, 150, 'crashed', { exit_code: 137 }); call('ag_otto', 149, 40, 'done', { restarts: 1 })
  call('ag_vera', 37, 30, 'done')
  call('ag_kit', 139, 55, 'done'); call('ag_ana', 69, 62, 'done'); call('ag_rex', 60 * 24 * 5, 60 * 24 * 4 - 60, 'done'); call('ag_noor', 30, 20, 'done')

  // ------------------------------------------------------------------ cards (assignees are set in mock/cards.ts)
  const cards = seedCards(now)

  const screens = new Map<string, { text: string; at: number }>([
    ['ag_maya', { text: MAYA_SCREEN, at: now }],
    ['ag_leo', { text: LEO_SCREEN, at: now }],
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
