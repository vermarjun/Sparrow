// Board v2 data + rules for the mock server: rich seed tickets and a PATCH that follows BOARD-CONTRACT §2
// (events, history, later/blocked clearing, check ticks). The real server is the source of truth; this is close enough for the UI.
import type { Card, CardCheck, CardCreateReq, CardLevel, CardNote, CardPatchReq, CardState, CardTransition } from '../../src/shared/types'
import { formatSpan, parseLevel } from '../../src/shared/cards'

type Path = [minsAgo: number, state: CardState, by?: string][]
type Spec = Partial<Omit<Card, 'id' | 'state' | 'title' | 'history'>> & { path?: Path; comments?: [minsAgo: number, by: string, text: string][]; events?: [minsAgo: number, by: string, text: string][] }

const STATE_NAME: Record<CardState, string> = { proposed: 'proposed', todo: 'todo', in_progress: 'in_progress', review: 'review', done: 'done', dropped: 'dropped' }

export function seedCards(now = Date.now()): Card[] {
  const t = (minsAgo: number) => now - minsAgo * 60_000
  const H = 60, D = 24 * 60
  const C = (id: number, state: CardState, title: string, spec: Spec = {}): Card => {
    const { path, comments = [], events = [], ...rest } = spec
    const steps: Path = path ?? [[(30 - id) * D / 3 + 90, state]]
    const history: CardTransition[] = steps.map(([m, to, by], i) => ({ at: t(m), by: by ?? (i === 0 ? 'ag_cap' : 'user'), from: i === 0 ? null : steps[i - 1][1], to }))
    const moves: CardNote[] = history.slice(1).map((h) => ({ at: h.at, by: h.by, text: `moved ${STATE_NAME[h.from!]} → ${STATE_NAME[h.to]}`, kind: 'event' }))
    const notes: CardNote[] = [
      ...moves,
      ...events.map(([m, by, text]) => ({ at: t(m), by, text, kind: 'event' as const })),
      ...comments.map(([m, by, text]) => ({ at: t(m), by, text, kind: 'comment' as const })),
    ].sort((a, b) => a.at - b.at)
    return {
      id, project_id: 'tortuga', title, details: '', category: null, state, position: id, assignee_id: null, created_by: 'ag_cap', notes,
      created_at: history[0].at, updated_at: notes.at(-1)?.at ?? history.at(-1)!.at,
      context: '', problem: '', approach: '', checks: [], tags: [], urgent: false, impact: null, effort: null, estimate_min: null,
      blocked_on: null, blocked_at: null, later_at: null, history, ...rest,
    }
  }
  const ck = (...items: [string, boolean][]): CardCheck[] => items.map(([text, done]) => ({ text, done }))

  const cards: Card[] = [
    // ---------------------------------------------------------------- done
    C(1, 'done', 'Set up CI for the web package', {
      category: 'infra', assignee_id: 'ag_leo', created_by: 'ag_cap', impact: 'medium', effort: 'low', estimate_min: 120, tags: ['ci'],
      context: 'Builds only ran on laptops, so a broken main went unnoticed for a day last week.',
      problem: 'Observed: web builds only run locally. Expected: every PR runs typecheck, lint, tests and build.',
      approach: 'One workflow file that installs from the lockfile, then runs the four package scripts. Cache the install.',
      checks: ck(['PRs show a green or red check', true], ['Cold run under 4 minutes', true]),
      path: [[9 * D, 'proposed'], [8 * D, 'todo', 'user'], [2 * D, 'in_progress', 'ag_leo'], [2 * D - 80, 'review', 'ag_leo'], [2 * D - 95, 'done', 'user']],
    }),
    C(2, 'done', 'Move session tokens to HttpOnly cookies', {
      category: 'auth', assignee_id: 'ag_maya', created_by: 'ag_cap', impact: 'high', effort: 'medium', estimate_min: 120, tags: ['security'],
      context: 'The security review flagged tokens in localStorage. It is the first item on the hardening list and the login work builds on it.',
      problem: 'Observed: the session token is readable by any script on the page. Expected: it lives in an HttpOnly, SameSite=Lax cookie and the API reads it from there.',
      approach: 'Set the cookie on login, read it in the auth middleware, keep the Authorization header working for one release so old clients do not break.',
      checks: ck(['Token is not readable from JavaScript', true], ['Existing sessions keep working after deploy', true], ['Logout clears the cookie', true]),
      path: [[6 * D, 'proposed'], [5 * D + 20, 'todo', 'user'], [5 * D, 'in_progress', 'ag_maya'], [5 * D - 140, 'review', 'ag_maya'], [5 * D - 200, 'done', 'user']],
      comments: [[5 * D - 135, 'ag_maya', 'Cookie set in `login.ts`, middleware reads it first and falls back to the header. 12 new tests, all green.']],
    }),
    C(3, 'done', 'Document the REST error format', {
      category: 'docs', assignee_id: 'ag_juno', created_by: 'ag_cap', impact: 'low', effort: 'low', estimate_min: 45,
      checks: ck(['Every error code has an example', true], ['Linked from the README', true]),
      path: [[7 * D, 'todo'], [5 * D, 'in_progress', 'ag_juno'], [5 * D - 40, 'review', 'ag_juno'], [5 * D - 50, 'done', 'user']],
    }),

    // ---------------------------------------------------------------- review
    C(6, 'review', 'Verify the login limiter under concurrent requests', {
      category: 'auth', assignee_id: 'ag_iris', created_by: 'ag_cap', impact: 'medium', effort: 'low', estimate_min: 45, tags: ['pr-62'],
      context: 'Maya opened PR #62 for the limiter. A second pair of eyes has to try to break it before it merges.',
      problem: 'Observed: the limiter has only been tested one request at a time. Expected: it holds with parallel logins from one IP.',
      approach: 'Run the suite, fire 50 parallel logins from one address, and check the counter and the Retry-After header.',
      checks: ck(['Suite result posted on the ticket', true], ['50 parallel logins produce exactly 5 attempts and 45 refusals', true], ['Retry-After matches the remaining window', false]),
      path: [[3 * D, 'todo', 'ag_cap'], [2 * H, 'in_progress', 'ag_iris'], [25, 'review', 'ag_iris']],
      comments: [[26, 'ag_iris', 'Parallel test passes now. Retry-After is off by one second at the window edge; noted in the PR.']],
      events: [[2 * H, 'ag_cap', 'assigned to @iris']],
    }),
    C(7, 'review', 'Dark mode colors for the settings page', {
      category: 'ui', assignee_id: 'ag_kit', created_by: 'ag_vega', impact: 'high', effort: 'low', estimate_min: 90, tags: ['ux'],
      context: 'Settings is the one page that still flashes white in dark mode. Support has had four reports.',
      problem: 'Observed: settings uses hard-coded hex colors. Expected: it follows the theme tokens like every other page.',
      approach: 'Swap the hex values for tokens, check contrast in both themes, and add a screenshot test for each.',
      checks: ck(['No hard-coded colors left on the page', true], ['Contrast passes in both themes', true], ['Screenshot tests for light and dark', true]),
      path: [[2 * D, 'todo', 'ag_vega'], [5 * H, 'in_progress', 'ag_kit'], [50, 'review', 'ag_kit']],
      comments: [[52, 'ag_kit', 'All 31 colors moved to tokens. axe reports 0 issues in both themes.']],
    }),

    // ---------------------------------------------------------------- in progress
    C(4, 'in_progress', 'Rate limit POST /login', {
      category: 'auth', assignee_id: 'ag_maya', urgent: true, impact: 'high', effort: 'medium', estimate_min: 240, tags: ['security', 'login'],
      context: 'Credential stuffing showed up in last Thursday\'s logs: 11k failed logins from 300 addresses in one hour. Security wants it before the next release.',
      problem: 'Observed: nothing limits failed logins, so a script can try passwords all day. Expected: 5 failed tries per account and address in 15 minutes, then a 429 with Retry-After.',
      approach: 'Sliding-window counter in Redis keyed by account and IP. A successful login resets it. Add one audit line per lockout.\n\nRisk: users behind a shared office IP. The key includes the account, so one noisy neighbour cannot lock everyone out.',
      checks: ck(['5 failed tries in 15 minutes return 429 with Retry-After', true], ['A successful login resets the counter', true], ['Unit tests for the window maths', true], ['End-to-end test for the 429 path', false], ['p95 login latency unchanged', false]),
      path: [[4 * D, 'proposed'], [4 * D - 40, 'todo', 'user'], [5 * H, 'in_progress', 'ag_maya']],
      comments: [[60, 'ag_maya', 'Limiter and 17 unit tests passing. Wiring it into the login handler now.'], [4, 'ag_maya', 'Wired in; 23/23 auth tests pass. Next: the end-to-end 429 test.']],
      events: [[4 * D - 100, 'user', 'marked urgent'], [5 * H, 'ag_cap', 'assigned to @maya']],
    }),
    C(5, 'in_progress', 'Retry failed webhooks with exponential backoff', {
      category: 'api', assignee_id: 'ag_sage', created_by: 'ag_orion', impact: 'high', effort: 'high', estimate_min: 480, tags: ['webhooks'],
      context: 'Customers lose events whenever their endpoint is down for a minute. Three of them asked for retries this month.',
      problem: 'Observed: a webhook that gets a 5xx or times out is dropped after one try. Expected: it is retried with growing delays until it succeeds or the retry budget runs out.',
      approach: 'Queue each delivery with an attempt counter. Delay doubles from one minute with jitter. After the last attempt, move it to a dead-letter list the customer can replay.',
      checks: ck(['A failing endpoint is retried on the backoff schedule', true], ['Jitter keeps retries from arriving together', false], ['Exhausted deliveries land in the dead-letter list', false], ['Retry budget is configurable per customer', false]),
      path: [[6 * D, 'proposed'], [5 * D, 'todo', 'user'], [3 * H, 'in_progress', 'ag_sage']],
      comments: [[20, 'ag_sage', 'Need a call on the retry budget before I wire the dead-letter list. Asked in the thread.']],
      events: [[3 * H, 'ag_orion', 'assigned to @sage']],
    }),

    // ---------------------------------------------------------------- to do
    C(8, 'todo', 'Webhook delivery log page', {
      category: 'ui', impact: 'medium', effort: 'high', estimate_min: 480, tags: ['webhooks'],
      context: 'Support cannot tell a customer whether their webhook was delivered without reading server logs.',
      problem: 'Observed: delivery results are only in the logs. Expected: a page that lists attempts per endpoint with status, latency and a replay button.',
      approach: 'A paged table fed by the delivery records the retry work already writes. Replay posts to the existing replay endpoint.',
      checks: ck(['Attempts listed per endpoint', false], ['Failed deliveries can be replayed', false]),
      path: [[6 * D, 'proposed'], [4 * D, 'todo', 'user']],
    }),
    C(9, 'todo', 'Provision Redis for rate limit counters in staging', {
      category: 'infra', impact: 'medium', effort: 'low', estimate_min: 60,
      context: 'The limiter needs a Redis instance in staging before the end-to-end test can run there.',
      problem: 'Observed: staging has no Redis. Expected: a small instance reachable from the API, with its URL in the secret store.',
      checks: ck(['Instance reachable from the staging API', false], ['URL stored as a secret', false]),
      blocked_on: 'Ops: staging network access', blocked_at: t(2 * D),
      path: [[3 * D, 'proposed'], [2 * D + 30, 'todo', 'user']],
      events: [[2 * D, 'user', 'blocked on Ops: staging network access']],
    }),
    C(10, 'todo', 'Add a dead-letter queue for exhausted webhooks', {
      category: 'api', impact: 'high', effort: 'medium', estimate_min: 180, tags: ['webhooks'],
      problem: 'Observed: a delivery that exhausts its retries just disappears. Expected: it is kept for 30 days and can be replayed from the API.',
      approach: 'Write exhausted deliveries to a table with the payload and the last error. Expose list and replay endpoints.',
      checks: ck(['Exhausted deliveries are stored with their last error', false], ['Replay endpoint re-queues one delivery', false]),
      path: [[3 * D, 'proposed'], [2 * D, 'todo', 'user']],
    }),
    C(11, 'todo', 'Rewrite the API reference landing page', {
      category: 'docs', impact: 'low', effort: 'low', estimate_min: 60,
      path: [[2 * D, 'todo']],
    }),
    C(12, 'todo', 'Native desktop app wrapper', {
      category: 'ui', impact: 'low', effort: 'high', estimate_min: 960, later_at: t(2 * D), tags: ['spike'],
      context: 'A customer asked once. Nothing depends on it, so it waits.',
      path: [[12 * D, 'todo']],
      events: [[2 * D, 'user', 'shelved under Later']],
    }),

    // ---------------------------------------------------------------- proposed
    C(13, 'proposed', 'Audit log for failed and locked-out logins', {
      category: 'auth', created_by: 'ag_cap', impact: 'high', effort: 'medium', estimate_min: 240, tags: ['compliance'],
      context: 'Security asked for it in the same review as the rate limiter: every lockout should leave a trace.',
      problem: 'Observed: failed logins are logged as plain text lines nobody can query. Expected: a structured record per failure and per lockout.',
      approach: 'Write an append-only table with account, address, reason and time. Reuse the audit line the limiter already emits.',
      checks: ck(['Every failure and lockout writes a record', false], ['Records cannot be edited through the API', false]),
      path: [[1 * D + 3 * H, 'proposed', 'ag_cap']],
    }),
    C(14, 'proposed', 'Publish webhook signature verification docs', {
      category: 'docs', created_by: 'ag_juno', impact: 'medium', effort: 'low', estimate_min: 45, tags: ['webhooks'],
      context: 'Juno noticed that customers keep asking how to verify the signature header.',
      problem: 'Observed: the signing scheme is only described in a code comment. Expected: a docs page with an example in three languages.',
      path: [[20 * H, 'proposed', 'ag_juno']],
    }),
    C(15, 'proposed', 'Move to a managed Postgres', {
      category: 'infra', created_by: 'ag_cap', impact: 'high', effort: 'high', estimate_min: 960, tags: ['database'],
      context: 'The self-hosted instance needs a person every time there is a major upgrade.',
      problem: 'Observed: upgrades and backups are manual. Expected: a managed instance with automatic backups and point-in-time restore.',
      approach: 'Dry-run a restore on a copy, compare costs of two providers, then plan the cutover with a read-only window.',
      path: [[5 * D, 'proposed', 'ag_cap']],
    }),
    C(16, 'proposed', 'Per-tenant rate limits on the public API', {
      category: 'api', created_by: 'ag_orion', impact: 'medium', effort: 'high', estimate_min: 720, tags: ['rate-limit'],
      context: 'Follows the login limiter. Large customers share infrastructure with small ones.',
      problem: 'Observed: one tenant can use all API capacity. Expected: a configurable limit per tenant with clear headers.',
      path: [[3 * D, 'proposed', 'ag_orion']],
    }),
    C(17, 'proposed', 'Keyboard shortcuts for the settings page', {
      category: 'ui', created_by: 'ag_kit', impact: 'low', effort: 'low', estimate_min: 60, tags: ['ux'],
      problem: 'Observed: the settings page is mouse-only. Power users would like to move between sections with j and k.',
      path: [[4 * D, 'proposed', 'ag_kit']],
    }),
    C(18, 'proposed', 'Animated onboarding tour', {
      category: 'ui', created_by: 'ag_vega', impact: 'low', effort: 'high', estimate_min: 600,
      details: 'Idea from a design review: a guided tour on first login. Nobody has asked for it yet.',
      path: [[8 * D, 'proposed', 'ag_vega']],
    }),

    // ---------------------------------------------------------------- dropped
    C(19, 'dropped', 'Support SAML single sign-on in v1', { category: 'auth', path: [[9 * D, 'proposed'], [8 * D, 'dropped', 'user']] }),
  ]
  // The second project keeps one plain card.
  const other = C(20, 'todo', 'Export the ledger as CSV', { category: 'api', assignee_id: 'ag_noor', impact: 'high', effort: 'low', estimate_min: 90, path: [[2 * D, 'todo']] })
  cards.push({ ...other, project_id: 'tortuga-ledger' })
  // One card keeps a v1 note without a kind.
  const three = cards.find((c) => c.id === 3)!
  three.notes.push({ at: t(5 * D - 45), by: 'ag_juno', text: 'Example payloads are in docs/errors.md.' })
  return cards.sort((a, b) => a.id - b.id)
}

// ---------------------------------------------------------------- rules

const LEVELS = new Set(['low', 'medium', 'high'])

export interface MockCtx {
  cards: Card[]
  agentHandle: (idOrHandle: string) => { id: string; handle: string } | null
  now?: number
}

function eventNote(by: string, text: string, now: number): CardNote { return { at: now, by, text, kind: 'event' } }

/** Apply a PATCH like the server does: events, history, side effects. Returns an error string on invalid input. */
export function patchCard(ctx: MockCtx, card: Card, b: CardPatchReq): string | null {
  const now = ctx.now ?? Date.now()
  const by = 'user'
  const events: string[] = []
  const edited: string[] = []

  if (b.title !== undefined) { const v = String(b.title).trim(); if (!v || v.length > 200) return 'title must be 1-200 characters'; if (v !== card.title) { card.title = v; edited.push('title') } }
  for (const k of ['details', 'context', 'problem', 'approach'] as const) {
    if (b[k] !== undefined) { if (typeof b[k] !== 'string' || b[k]!.length > 20000) return `${k} must be text up to 20000 characters`; if (b[k] !== card[k]) { card[k] = b[k]!; edited.push(k) } }
  }
  if (b.category !== undefined) { const v = b.category?.trim().toLowerCase() || null; if (v !== card.category) { card.category = v; edited.push('category') } }
  if (b.tags !== undefined) {
    const tags = [...new Set(b.tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean))]
    if (tags.length > 12 || tags.some((x) => x.length > 32 || x.includes(','))) return 'tags: at most 12, each up to 32 characters, no commas'
    if (tags.join('|') !== card.tags.join('|')) { card.tags = tags; edited.push('tags') }
  }
  if (b.checks !== undefined) {
    const checks = b.checks.map((c) => (typeof c === 'string' ? { text: c.trim(), done: false } : { text: c.text.trim(), done: !!c.done })).filter((c) => c.text)
    if (checks.length > 30 || checks.some((c) => c.text.length > 500)) return 'checks: at most 30 items of up to 500 characters'
    if (JSON.stringify(checks) !== JSON.stringify(card.checks)) { card.checks = checks; edited.push('done-when') }
  }
  if (b.check) {
    const c = card.checks[b.check.index]
    if (!c) return `no check at index ${b.check.index}`
    if (c.done !== b.check.done) { c.done = b.check.done; events.push(`${b.check.done ? 'checked' : 'unchecked'} "${c.text}"`) }
  }
  for (const k of ['impact', 'effort'] as const) {
    if (b[k] !== undefined) {
      const v = b[k] === null ? null : parseLevel(b[k]) as CardLevel | null
      if (b[k] !== null && !LEVELS.has(String(v))) return `${k} must be low, medium or high`
      if (v !== card[k]) { card[k] = v; edited.push(k === 'impact' ? 'return' : 'effort') }
    }
  }
  if (b.estimate_min !== undefined) {
    if (b.estimate_min !== null && !(Number.isFinite(b.estimate_min) && b.estimate_min > 0)) return 'estimate_min must be a positive number of minutes'
    if (b.estimate_min !== card.estimate_min) { card.estimate_min = b.estimate_min; edited.push('estimate') }
  }
  if (typeof b.urgent === 'boolean' && b.urgent !== card.urgent) { card.urgent = b.urgent; events.push(b.urgent ? 'marked urgent' : 'cleared urgent') }
  if (b.blocked_on !== undefined) {
    const on = b.blocked_on?.trim() || null
    if (on && !card.blocked_on) { card.blocked_on = on; card.blocked_at = now; events.push(`blocked on ${on}`) }
    else if (on && on !== card.blocked_on) { card.blocked_on = on; events.push(`blocked on ${on}`) }
    else if (!on && card.blocked_on) { events.push(`unblocked after ${formatSpan(now - (card.blocked_at ?? now))}`); card.blocked_on = null; card.blocked_at = null }
  }
  if (typeof b.later === 'boolean') {
    if (b.later && !card.later_at) { card.later_at = now; events.push('shelved under Later') }
    if (!b.later && card.later_at) { card.later_at = null; events.push('back from Later') }
  }
  if (b.assignee !== undefined) {
    const a = b.assignee && b.assignee !== 'none' ? ctx.agentHandle(b.assignee === 'me' ? 'captain' : b.assignee) : null
    if (b.assignee && b.assignee !== 'none' && !a) return `no agent ${b.assignee}. Use @handle of an agent in this project, or none.`
    if ((a?.id ?? null) !== card.assignee_id) { card.assignee_id = a?.id ?? null; events.push(a ? `assigned to @${a.handle}` : 'unassigned') }
  }
  if (b.state && b.state !== card.state) {
    const from = card.state
    card.state = b.state
    card.history.push({ at: now, by, from, to: b.state })
    events.unshift(`moved ${from} → ${b.state}`)
    if ((b.state === 'in_progress' || b.state === 'review' || b.state === 'done') && card.later_at) { card.later_at = null; events.push('back from Later') }
    if ((b.state === 'done' || b.state === 'dropped') && card.blocked_on) { card.blocked_on = null; card.blocked_at = null; events.push('unblocked') }
  }
  if (typeof b.position === 'number') card.position = b.position
  if (edited.length) events.push(`edited ${edited.join(', ')}`)
  for (const text of events) card.notes.push(eventNote(by, text, now))
  if (b.note) { if (!b.note.trim()) return 'note must not be empty'; card.notes.push({ at: now, by, text: b.note, kind: 'comment' }) }
  card.updated_at = now
  return null
}

export function createCard(ctx: MockCtx, project: string, b: CardCreateReq): Card | string {
  const now = ctx.now ?? Date.now()
  const title = (b.title ?? '').trim()
  if (!title || title.length > 200) return 'title must be 1-200 characters'
  const state: CardState = b.state ?? 'todo'
  const inCol = ctx.cards.filter((c) => c.project_id === project && c.state === state)
  const card: Card = {
    id: Math.max(0, ...ctx.cards.map((c) => c.id)) + 1, project_id: project, title, details: '', category: null, state,
    position: Math.max(0, ...inCol.map((c) => c.position)) + 1, assignee_id: null, created_by: 'user', notes: [],
    created_at: now, updated_at: now, context: '', problem: '', approach: '', checks: [], tags: [], urgent: false, impact: null, effort: null,
    estimate_min: null, blocked_on: null, blocked_at: null, later_at: null, history: [{ at: now, by: 'user', from: null, to: state }],
  }
  const { title: _t, state: _s, assignee, ...fields } = b
  const err = patchCard({ ...ctx, now }, card, { ...fields, ...(assignee ? { assignee } : {}) })
  if (err) return err
  card.notes = card.notes.filter((n) => n.kind === 'comment') // a new ticket starts with a clean timeline
  return card
}
