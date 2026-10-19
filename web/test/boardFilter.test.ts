import { describe, expect, test } from 'bun:test'
import { NO_FILTERS, cardMatches, categoriesOf, filterCards, groupColumns, hasFilters, isShelved, matchesQuery, orderColumn, summarize, summaryText } from '../src/lib/boardFilter'
import { DAY, mkCard } from './cardFixtures'

describe('search', () => {
  const c = mkCard(12, { title: 'Retry ring on reconnect', context: 'Asked by Maya', problem: 'drops frames', approach: 'backoff', details: 'legacy notes', tags: ['tower'], category: 'Server', checks: [{ text: 'no gap in log', done: false }] })
  test('matches key, #id, title, sections, tags, category, checks', () => {
    for (const q of ['PLU-12', 'plu-12', '#12', 'retry', 'maya', 'frames', 'backoff', 'legacy', 'tower', 'server', 'gap in log']) expect(matchesQuery(c, q)).toBe(true)
  })
  test('every term must match; unknown terms fail', () => {
    expect(matchesQuery(c, 'retry frames')).toBe(true)
    expect(matchesQuery(c, 'retry nothing')).toBe(false)
    expect(matchesQuery(c, '   ')).toBe(true)
  })
})

describe('exact ticket refs', () => {
  const cards = [3, 30, 31, 39, 300].map((id) => mkCard(id, { title: id === 3 ? 'Plain' : `About SPA-3 item ${id}`, project_id: 'spa' }))
  const ids = (q: string) => cards.filter((c) => matchesQuery(c, q)).map((c) => c.id)
  test('a key or number matches that ticket only', () => {
    expect(ids('SPA-3')).toEqual([3])
    expect(ids('spa-3')).toEqual([3])
    expect(ids('#3')).toEqual([3])
    expect(ids('3')).toEqual([3])
    expect(ids(' 30 ')).toEqual([30])
  })
  test('anything else stays a substring search', () => {
    expect(ids('SPA')).toEqual([3, 30, 31, 39, 300])
    expect(ids('item 3')).toEqual([30, 31, 39, 300])
    expect(ids('SPA-3 item')).toEqual([30, 31, 39, 300])
  })
})

describe('urgent and blocked are live-only', () => {
  const cards = [
    mkCard(1, { urgent: true, state: 'todo' }), mkCard(2, { urgent: true, state: 'done' }), mkCard(3, { urgent: true, state: 'dropped' }),
    mkCard(4, { blocked_on: 'x', state: 'review' }), mkCard(5, { blocked_on: 'x', state: 'done' }), mkCard(6, { blocked_on: 'x', state: 'dropped' }),
  ]
  test('filters drop done and dropped cards, matching the summary counts', () => {
    expect(filterCards(cards, { ...NO_FILTERS, urgent: true }).map((c) => c.id)).toEqual([1])
    expect(filterCards(cards, { ...NO_FILTERS, blocked: true }).map((c) => c.id)).toEqual([4])
    const s = summarize(cards, cards)
    expect([s.urgent, s.blocked]).toEqual([1, 1])
  })
})

describe('filters', () => {
  const cards = [
    mkCard(1, { urgent: true, category: 'ui', assignee_id: 'a1' }),
    mkCard(2, { blocked_on: 'IT access', category: 'db' }),
    mkCard(3, { impact: 'high', effort: 'low', category: 'UI' }),
    mkCard(4),
  ]
  const ids = (f: Partial<typeof NO_FILTERS>) => filterCards(cards, { ...NO_FILTERS, ...f }).map((c) => c.id)
  test('no filters keeps everything', () => { expect(ids({})).toEqual([1, 2, 3, 4]); expect(hasFilters(NO_FILTERS)).toBe(false) })
  test('urgent / blocked / quick wins', () => {
    expect(ids({ urgent: true })).toEqual([1])
    expect(ids({ blocked: true })).toEqual([2])
    expect(ids({ quick: true })).toEqual([3])
  })
  test('category is multi-select and case-insensitive', () => {
    expect(ids({ categories: ['ui'] })).toEqual([1, 3])
    expect(ids({ categories: ['ui', 'db'] })).toEqual([1, 2, 3])
  })
  test('assignee: an agent, or none', () => {
    expect(ids({ assignee: 'a1' })).toEqual([1])
    expect(ids({ assignee: 'none' })).toEqual([2, 3, 4])
  })
  test('filters combine with AND', () => {
    expect(ids({ urgent: true, categories: ['db'] })).toEqual([])
    expect(cardMatches(cards[0], { ...NO_FILTERS, q: 'card 1', urgent: true })).toBe(true)
    expect(hasFilters({ ...NO_FILTERS, q: 'x' })).toBe(true)
  })
  test('categoriesOf is distinct and sorted', () => { expect(categoriesOf(cards)).toEqual(['db', 'ui']) })
})

describe('columns', () => {
  const t0 = Date.now()
  const cards = [
    mkCard(1, { state: 'todo', position: 2, impact: 'low' }),
    mkCard(2, { state: 'todo', position: 1, impact: 'high', effort: 'low' }),
    mkCard(3, { state: 'todo', position: 3, later_at: 5 }),
    mkCard(4, { state: 'in_progress', position: 2, created_at: t0 }),
    mkCard(5, { state: 'in_progress', position: 1, created_at: t0 - DAY }),
    mkCard(6, { state: 'done', position: 1, updated_at: 10, history: [{ at: 1, by: 'user', from: null, to: 'todo' }, { at: 100, by: 'user', from: 'todo', to: 'done' }] }),
    mkCard(7, { state: 'done', position: 2, updated_at: 20, history: [{ at: 1, by: 'user', from: null, to: 'todo' }, { at: 300, by: 'user', from: 'todo', to: 'done' }] }),
    mkCard(8, { state: 'review', later_at: 9 }),
  ]
  test('manual order sorts by position, later cards split off under proposed/todo only', () => {
    const g = groupColumns(cards, 'manual')
    expect(g.todo.active.map((c) => c.id)).toEqual([2, 1])
    expect(g.todo.later.map((c) => c.id)).toEqual([3])
    expect(isShelved(cards[2])).toBe(true)
    expect(isShelved(cards[7])).toBe(false) // a shelved marker outside proposed/todo is ignored
    expect(g.review.active.map((c) => c.id)).toEqual([8])
  })
  test('the toolbar sort applies to proposed/todo only; in progress stays manual', () => {
    const g = groupColumns(cards, 'newest')
    expect(g.in_progress.active.map((c) => c.id)).toEqual([5, 4])
    expect(orderColumn('todo', cards.filter((c) => c.state === 'todo'), 'roi').map((c) => c.id)[0]).toBe(2)
  })
  test('done is most recently done first, whatever the sort', () => {
    expect(groupColumns(cards, 'oldest').done.active.map((c) => c.id)).toEqual([7, 6])
  })
})

describe('summary', () => {
  const cards = [
    mkCard(1, { urgent: true }), mkCard(2, { urgent: true, state: 'done' }), mkCard(3, { blocked_on: 'x' }),
    mkCard(4, { later_at: 1 }), mkCard(5, { later_at: 1, state: 'proposed' }),
  ]
  test('counts and wording', () => {
    const s = summarize(cards, cards)
    expect(s).toEqual({ total: 5, shown: 5, urgent: 1, blocked: 1, later: 2 })
    expect(summaryText(s)).toBe('5 tickets · 1 urgent · 1 blocked · 2 later')
  })
  test('filtered view says "x of y" and drops zero parts', () => {
    expect(summaryText(summarize([cards[0]], cards))).toBe('1 of 5 tickets · 1 urgent')
    expect(summaryText({ total: 1, shown: 1, urgent: 0, blocked: 0, later: 0 })).toBe('1 ticket')
  })
})
