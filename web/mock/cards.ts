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
      id, project_id: 'plutus', title, details: '', category: null, state, position: id, assignee_id: null, created_by: 'ag_cap', notes,
      created_at: history[0].at, updated_at: notes.at(-1)?.at ?? history.at(-1)!.at,
      context: '', problem: '', approach: '', checks: [], tags: [], urgent: false, impact: null, effort: null, estimate_min: null,
      blocked_on: null, blocked_at: null, later_at: null, history, ...rest,
    }
  }
  const ck = (...items: [string, boolean][]): CardCheck[] => items.map(([text, done]) => ({ text, done }))

  const cards: Card[] = [
    // ---------------------------------------------------------------- done
    C(1, 'done', 'Store ledger amounts in minor units', {
      category: 'db', assignee_id: 'ag_james', impact: 'high', effort: 'medium', estimate_min: 120, tags: ['migration'],
      context: 'Maya flagged rounding drift in last month\'s statements. Every export and the new reports build on exact amounts.',
      problem: 'Observed: amounts are stored as floats, so 0.1 + 0.2 style drift shows up in totals. Expected: integer minor units everywhere.',
      approach: 'Add an integer column next to the old one, backfill it, switch every reader, then drop the float column in a follow-up.',
      checks: ck(['Totals match the bank for the last 12 months', true], ['No float column is read anywhere', true], ['Migration can be re-run safely', true]),
      path: [[10 * D, 'proposed'], [9 * D + 20, 'todo', 'user'], [9 * D, 'in_progress', 'ag_james'], [9 * D - 140, 'review', 'ag_james'], [9 * D - 155, 'done', 'user']],
      comments: [[9 * D - 200, 'ag_james', 'Migration 0007 applied on the sandbox copy. 4 rows needed manual rounding, listed in the PR.']],
    }),
    C(2, 'done', 'Compare CSV libraries for Bun', {
      category: 'research', assignee_id: 'ag_omar', created_by: 'ag_maya', impact: 'medium', effort: 'low', estimate_min: 60,
      context: 'Needed before we commit to a library for the export work.',
      problem: 'We have no data on which CSV library streams large files and handles quoting correctly.',
      approach: 'Try three libraries on a 50k-row sample and write up speed, memory and quoting behaviour in notes/csv.md.',
      checks: ck(['Three libraries compared', true], ['Recommendation written in notes/csv.md', true]),
      path: [[6 * D, 'todo', 'ag_maya'], [6 * D - 30, 'in_progress', 'ag_omar'], [6 * D - 65, 'review', 'ag_omar'], [6 * D - 75, 'done', 'user']],
      comments: [[6 * D - 64, 'ag_omar', 'papaparse wins on streaming; see notes/csv.md.']],
    }),
    C(27, 'done', 'Add pagination to the ledger API', {
      category: 'server', assignee_id: 'ag_james', impact: 'medium', effort: 'medium', estimate_min: 90,
      problem: 'Observed: GET /api/ledger returns every row. Expected: pages of 100 with a cursor.',
      approach: 'Cursor pagination on the entry date and id. Keep the old response shape behind a flag for one release.',
      checks: ck(['Default page size is 100', true], ['Cursor survives inserts between pages', true], ['Old shape still available with ?all=1', true]),
      path: [[7 * D, 'todo'], [5 * D, 'in_progress', 'ag_james'], [5 * D - 100, 'review', 'ag_james'], [5 * D - 125, 'in_progress', 'user'], [5 * D - 185, 'review', 'ag_james'], [5 * D - 215, 'done', 'user']],
      comments: [[5 * D - 120, 'user', 'Cursor breaks when two entries share a timestamp. Please fix before it goes in.']],
    }),
    C(28, 'done', 'Write the export plan one-pager', {
      category: 'docs', assignee_id: 'ag_maya', impact: 'medium', effort: 'low', estimate_min: 60,
      context: 'Friday review with finance. They want to see scope and dates.',
      checks: ck(['One page, no jargon', true], ['Covers CSV now, XLSX later', true]),
      path: [[4 * D, 'proposed'], [4 * D - 10, 'todo', 'user'], [3 * D, 'in_progress', 'ag_maya'], [3 * D - 50, 'review', 'ag_maya'], [3 * D - 60, 'done', 'user']],
    }),
    C(29, 'done', 'Set up CI for the web package', {
      category: 'infra', assignee_id: 'ag_leo', impact: 'medium', effort: 'low', estimate_min: 120, tags: ['ci'],
      problem: 'Observed: web builds only run locally. Expected: every PR runs typecheck, lint, tests and build.',
      approach: 'One workflow file that installs with the lockfile, then runs the four package scripts. Cache the install.',
      checks: ck(['PRs show a green or red check', true], ['Cold run under 4 minutes', true]),
      path: [[9 * D, 'proposed'], [8 * D, 'todo', 'user'], [2 * D, 'in_progress', 'ag_leo'], [2 * D - 80, 'review', 'ag_leo'], [2 * D - 95, 'done', 'user']],
    }),

    // ---------------------------------------------------------------- review
    C(4, 'review', 'Review export quoting and memory use (PR #41)', {
      category: 'export', assignee_id: 'ag_iris', created_by: 'ag_maya', impact: 'medium', effort: 'low', estimate_min: 45, tags: ['pr-41'],
      context: 'James opened PR #41 for the CSV writer. Maya wants a second pair of eyes before it merges.',
      problem: 'Observed: the 50k-row test ran out of memory on the verifier. Expected: export streams in constant memory.',
      approach: 'Run the integration suite, profile the memory use, and report where rows are buffered.',
      checks: ck(['Suite result posted on the ticket', true], ['Memory peak under 200 MB for 50k rows', false], ['Quoting verified for commas, quotes and newlines', true]),
      path: [[3 * D, 'todo', 'ag_maya'], [2 * D, 'in_progress', 'ag_iris'], [90, 'review', 'ag_iris']],
      comments: [[19, 'system', '@iris crashed: out of memory on 50k rows. It needs a smaller sample or a memory fix first.'], [60, 'ag_iris', 'Quoting is fine. The memory failure is in `csv.ts` where rows are joined before writing.']],
      events: [[2 * D, 'ag_maya', 'assigned to @iris']],
    }),
    C(26, 'review', 'Hotfix: negative balances shown without a sign', {
      category: 'ui', assignee_id: 'ag_leo', urgent: true, impact: 'high', effort: 'low', estimate_min: 60,
      context: 'Finance reported two statements where a debit looked like a credit. Raised in the Monday sync.',
      problem: 'Observed: -120.00 renders as 120.00 in the balance column. Expected: a minus sign and red text.',
      approach: 'Format with the sign always visible and add a test with a negative balance.',
      checks: ck(['Negative balances show a minus sign', true], ['A test covers a negative balance', true]),
      path: [[3 * H, 'todo', 'ag_maya'], [2 * H + 40, 'in_progress', 'ag_leo'], [35, 'review', 'ag_leo']],
      comments: [[36, 'ag_leo', 'Fixed in `format.ts`, 2 tests added. Ready for a look.']],
      events: [[3 * H, 'user', 'marked urgent']],
    }),

    // ---------------------------------------------------------------- in progress
    C(3, 'in_progress', 'CSV export for the ledger', {
      category: 'export', assignee_id: 'ag_james', urgent: true, impact: 'high', effort: 'medium', estimate_min: 240, tags: ['csv', 'finance'],
      context: 'Finance asked for a monthly CSV of the ledger for their audit. Raised by Shubhankar on Monday, due before month end.',
      problem: 'Observed: the only way to get ledger data out is copy and paste from the table. Expected: a button that downloads every row for a date range as a correct CSV.',
      approach: 'Stream rows from the database to the response so big ranges do not use much memory. Quote fields the standard way. The endpoint takes a from and to date.\n\nRisk: very large ranges. We cap at 12 months for now.',
      details: 'Older notes: papaparse for quoting, see notes/csv.md.',
      checks: ck(['50k rows export in under 3 seconds', true], ['Commas, quotes and newlines round-trip', true], ['The endpoint takes a from and to date', true], ['Download button on the ledger page', false], ['Ranges over 12 months are rejected with a clear message', false]),
      path: [[5 * D, 'proposed'], [5 * D - 40, 'todo', 'user'], [2 * D, 'in_progress', 'ag_james']],
      comments: [[75, 'ag_james', 'Writer and 9 tests passing. Starting on the endpoint.'], [8, 'ag_james', 'Endpoint streams; 14/14 tests. Next: the 12 month cap.']],
      events: [[5 * D - 100, 'user', 'marked urgent'], [2 * D, 'ag_maya', 'assigned to @james']],
    }),
    C(6, 'in_progress', 'Download CSV button on the ledger page', {
      category: 'ui', assignee_id: 'ag_leo', impact: 'high', effort: 'low', estimate_min: 90,
      context: 'Follows the CSV export ticket. The button is what finance will actually click.',
      problem: 'Observed: no way to start an export from the page. Expected: a Download CSV button that uses the current date range.',
      approach: 'Add the button next to the date picker. It calls the export endpoint and shows a spinner while the file downloads.',
      checks: ck(['Button uses the selected date range', false], ['Spinner while downloading', false]),
      blocked_on: 'James: export endpoint not merged yet', blocked_at: t(5 * H),
      path: [[3 * D, 'todo', 'ag_maya'], [6 * H, 'in_progress', 'ag_leo']],
      events: [[5 * H, 'user', 'blocked on James: export endpoint not merged yet']],
    }),
    C(25, 'in_progress', 'Backfill missing currencies on old ledger rows', {
      category: 'db', assignee_id: 'ag_omar', impact: 'medium', effort: 'medium', estimate_min: 90, tags: ['migration'],
      problem: 'Observed: 312 rows from 2023 have no currency, so exports show a blank column. Expected: every row has a currency.',
      approach: 'Infer the currency from the account, write a report of anything ambiguous, and leave ambiguous rows for a human.',
      checks: ck(['Report of ambiguous rows attached', false], ['No row without a currency except the ambiguous ones', false]),
      path: [[2 * D, 'todo', 'ag_maya'], [50, 'in_progress', 'ag_omar']],
    }),
    C(33, 'in_progress', 'Tidy the ledger table row actions', {
      category: 'ui', assignee_id: 'ag_leo', impact: 'low', effort: 'low', estimate_min: 45,
      path: [[2 * D, 'todo'], [20, 'in_progress', 'ag_leo']],
    }),

    // ---------------------------------------------------------------- to do
    C(5, 'todo', 'Date-range picker on the ledger page', {
      category: 'ui', impact: 'high', effort: 'low', estimate_min: 90, tags: ['finance'],
      context: 'Needed by the Download CSV button, and finance keeps asking for it.',
      problem: 'Observed: the ledger always shows the current month. Expected: pick any range, with presets for this month, last month and this year.',
      approach: 'A compact picker with three presets and two date inputs. The range lives in the URL so it can be shared.',
      checks: ck(['Presets work', false], ['Range is in the URL', false], ['Invalid ranges are rejected inline', false]),
      path: [[4 * D, 'proposed'], [3 * D, 'todo', 'user']],
    }),
    C(7, 'todo', 'Rate-limit the export endpoint', {
      category: 'server', impact: 'medium', effort: 'medium', estimate_min: 120,
      context: 'A heavy export can slow the whole ledger for everyone.',
      problem: 'Observed: nothing stops a user from starting ten exports at once. Expected: a sensible limit with a clear message.',
      approach: 'Allow two exports per user at a time and return a clear message for the third.',
      checks: ck(['Third concurrent export is refused with a message', false], ['Limit is configurable', false]),
      path: [[3 * D, 'todo']],
    }),
    C(10, 'todo', 'Document the export API in the README', {
      category: 'docs', impact: 'low', effort: 'low', estimate_min: 30, details: 'Parameters, an example curl, and the 12 month cap.',
      path: [[2 * D, 'todo']],
    }),
    C(21, 'todo', 'Rotate the NetSuite API key', {
      category: 'security', urgent: true, impact: 'high', effort: 'low', estimate_min: 30, tags: ['compliance'],
      context: 'The key is older than 90 days. Security asked for rotation by Friday.',
      problem: 'Observed: the sandbox key was last rotated 112 days ago. Expected: rotated within 90 days.',
      approach: 'Request a new key, update the secret store, restart the sync job, and confirm one sync run succeeds.',
      checks: ck(['New key in the secret store', false], ['Old key revoked', false], ['One successful sync run', false]),
      blocked_on: 'IT: NetSuite sandbox access', blocked_at: t(2 * D),
      path: [[5 * D, 'proposed'], [4 * D, 'todo', 'user']],
      events: [[2 * D, 'user', 'blocked on IT: NetSuite sandbox access']],
    }),
    C(24, 'todo', 'Fix tab order on the new-entry form', {
      category: 'ui', impact: 'medium', effort: 'low', estimate_min: 30,
      path: [[2 * D, 'proposed'], [1 * D, 'todo', 'user']],
    }),
    C(32, 'todo', 'Spike: streaming parser for 1M-row imports', {
      category: 'research', impact: 'high', effort: 'high', estimate_min: 480, tags: ['import', 'performance', 'spike'],
      context: 'Sales wants to promise 1M-row imports to a big customer. We need to know what is realistic.',
      problem: 'Observed: the importer reads the whole file into memory and fails around 200k rows.',
      approach: 'Prototype a streaming parser, measure memory and time at 1M rows, and write up what it would take to ship.',
      checks: ck(['Prototype runs on a 1M-row file', false], ['Memory and time numbers written up', false]),
      path: [[6 * D, 'proposed'], [5 * D, 'todo', 'user']],
    }),
    C(22, 'todo', 'Replace hand-rolled date parsing', {
      category: 'server', impact: 'low', effort: 'medium', estimate_min: 180, later_at: t(2 * D),
      path: [[10 * D, 'todo']],
      events: [[2 * D, 'user', 'shelved under Later']],
    }),
    C(23, 'todo', 'Import OFX bank statements', {
      category: 'billing', impact: 'high', effort: 'high', estimate_min: 960, later_at: t(4 * D), tags: ['import'],
      context: 'Two customers asked. Not needed until next quarter.',
      path: [[12 * D, 'todo']],
      events: [[4 * D, 'user', 'shelved under Later']],
    }),

    // ---------------------------------------------------------------- proposed
    C(13, 'proposed', 'Fix wrong totals when a ledger has refunds', {
      category: 'billing', created_by: 'ag_maya', urgent: true, impact: 'high', effort: 'medium', estimate_min: 180, tags: ['bug', 'finance'],
      context: 'Reported by finance on Tuesday. Two customers saw totals that disagree with their bank.',
      problem: 'Observed: a refund is added to the total instead of subtracted. Expected: refunds reduce the total.',
      approach: 'Treat refunds as negative amounts at the point they are read, then add a test with a mixed ledger.',
      checks: ck(['Refunds reduce the total', false], ['Mixed ledger test added', false], ['Past statements for the two customers are regenerated', false]),
      path: [[1 * D + 3 * H, 'proposed', 'ag_maya']],
    }),
    C(20, 'proposed', 'Cache the category totals query', {
      category: 'db', created_by: 'ag_james', impact: 'medium', effort: 'low', estimate_min: 45, tags: ['performance'],
      context: 'James noticed it while profiling the export.',
      problem: 'Observed: the dashboard runs the same totals query on every load, 400 ms each time.',
      approach: 'Cache the result for one minute and clear it when an entry is written.',
      path: [[20 * H, 'proposed', 'ag_james']],
    }),
    C(18, 'proposed', 'Audit log for ledger edits', {
      category: 'security', created_by: 'ag_cap', impact: 'high', effort: 'medium', estimate_min: 300, tags: ['compliance'],
      context: 'Needed for the next audit. Asked by security.',
      problem: 'Observed: edits to ledger entries leave no trace. Expected: who changed what and when.',
      approach: 'Write an append-only record for every edit with the old and new values and the user.',
      checks: ck(['Every edit writes a record', false], ['Records cannot be edited', false]),
      path: [[3 * D, 'proposed']],
    }),
    C(14, 'proposed', 'Keyboard shortcuts for the ledger table', {
      category: 'ui', created_by: 'ag_leo', impact: 'low', effort: 'medium', estimate_min: 240, tags: ['ux'],
      problem: 'Observed: the table is mouse-only. Power users would like to move with j and k.',
      path: [[5 * D, 'proposed', 'ag_leo']],
    }),
    C(15, 'proposed', 'Reconcile duplicate bank feed entries', {
      category: 'billing', created_by: 'ag_omar', impact: 'high', effort: 'high', estimate_min: 480, tags: ['bank-feed'],
      context: 'Omar found 41 duplicates while backfilling currencies.',
      problem: 'Observed: the bank feed sometimes delivers an entry twice. Expected: duplicates are detected and merged.',
      approach: 'Match on amount, date and reference. Show likely duplicates for a person to confirm before merging.',
      blocked_on: 'IT: bank feed credentials', blocked_at: t(1 * D),
      path: [[4 * D, 'proposed', 'ag_omar']],
      events: [[1 * D, 'user', 'blocked on IT: bank feed credentials']],
    }),
    C(19, 'proposed', 'Email a monthly statement to each customer', {
      category: 'billing', created_by: 'ag_cap', impact: 'medium', effort: 'medium', estimate_min: 360,
      path: [[6 * D, 'proposed']],
    }),
    C(16, 'proposed', 'Dark mode for the dashboard', {
      category: 'ui', created_by: 'ag_leo', impact: 'low', effort: 'medium', estimate_min: 300, later_at: t(1 * D), tags: ['ux'],
      path: [[9 * D, 'proposed', 'ag_leo']],
      events: [[1 * D, 'user', 'shelved under Later']],
    }),
    C(17, 'proposed', 'Multi-currency totals', {
      category: 'billing', created_by: 'ag_maya', impact: 'medium', effort: 'high', estimate_min: 960, later_at: t(3 * D),
      context: 'Only matters once we have a customer outside the euro area.',
      path: [[11 * D, 'proposed', 'ag_maya']],
      events: [[3 * D, 'user', 'shelved under Later']],
    }),
    // legacy cards from before v2: only title, details, category, notes
    C(8, 'proposed', 'Export as XLSX too', { category: 'export', created_by: 'ag_omar', details: 'papaparse can’t, but SheetJS streams. Users asked twice.', path: [[7 * D, 'proposed', 'ag_omar']] }),
    C(9, 'proposed', 'Progress header for long exports', { category: 'export', created_by: 'ag_james', path: [[8 * D, 'proposed', 'ag_james']] }),
    C(31, 'proposed', 'Let users push a ledger export straight to Google Sheets through the Drive API instead of downloading a CSV and uploading it by hand every month', {
      category: 'integration', created_by: 'ag_cap', details: 'Idea from the finance call. Needs an OAuth app; check whether the Workspace admin allows it.', path: [[13 * D, 'proposed']],
    }),

    // ---------------------------------------------------------------- dropped
    C(11, 'dropped', 'PDF statements (out of scope for v1)', { category: 'export', path: [[9 * D, 'proposed'], [8 * D, 'dropped', 'user']] }),
    C(30, 'dropped', 'Native desktop wrapper', { category: 'infra', path: [[14 * D, 'proposed'], [12 * D, 'dropped', 'user']] }),
  ]
  // The other project keeps one plain legacy card.
  const other = C(12, 'todo', 'README quickstart', { assignee_id: 'ag_ada', path: [[2 * D, 'todo']] })
  cards.push({ ...other, project_id: 'sparrow' })
  // The ledger legacy cards also have notes like v1 (no kind) on one of them.
  const nine = cards.find((c) => c.id === 9)!
  nine.notes.push({ at: t(2 * D), by: 'ag_james', text: 'Header could be X-Export-Progress; needs a decision.' })
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
