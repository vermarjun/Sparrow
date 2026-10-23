import { describe, expect, test } from 'bun:test'
import {
  addTags, appendCheck, categoryOptions, checkProgress, editCheck, hasText, moveCheck, newCategory, nextActions, parseEstimateInput,
  footerActions, foldMoves, movesLabel, parseMove, prettyEvent, removeCheck, removeTag,
} from '../src/lib/sheetLogic'
import { mkCard } from './cardFixtures'

const ck = (...t: string[]) => t.map((text) => ({ text, done: false }))

describe('estimate input', () => {
  test('accepts 2h, 90m, 1d, 1h 30m', () => {
    expect(parseEstimateInput('2h')).toEqual({ ok: true, min: 120 })
    expect(parseEstimateInput('90m')).toEqual({ ok: true, min: 90 })
    expect(parseEstimateInput('1d')).toEqual({ ok: true, min: 480 })
    expect(parseEstimateInput(' 1h 30m ')).toEqual({ ok: true, min: 90 })
  })
  test('empty clears, junk errors with a hint', () => {
    expect(parseEstimateInput('  ')).toEqual({ ok: true, min: null })
    const r = parseEstimateInput('soon')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('2h')
    expect(parseEstimateInput('0h').ok).toBe(false)
  })
})

describe('tags', () => {
  test('lowercases, trims, splits on commas and dedupes', () => {
    expect(addTags(['ui'], ' UI, Perf ,  ,api')).toEqual(['ui', 'perf', 'api'])
  })
  test('caps at 12 tags and 32 chars', () => {
    const many = Array.from({ length: 14 }, (_, i) => `t${i}`).join(',')
    expect(addTags([], many)).toHaveLength(12)
    expect(addTags([], 'x'.repeat(50))[0]).toHaveLength(32)
  })
  test('removeTag', () => expect(removeTag(['a', 'b'], 'a')).toEqual(['b']))
})

describe('category combobox', () => {
  const cards = [
    mkCard(1, { category: 'ui' }), mkCard(2, { category: 'db' }), mkCard(3, { category: 'ui' }), mkCard(4, { category: null }),
    mkCard(5, { category: 'other', project_id: 'zed' }),
  ]
  test('most used first, project scoped, filtered by query', () => {
    expect(categoryOptions(cards, 'tortuga', '')).toEqual([{ name: 'ui', count: 2 }, { name: 'db', count: 1 }])
    expect(categoryOptions(cards, 'tortuga', 'D')).toEqual([{ name: 'db', count: 1 }])
  })
  test('names the page already knows are offered too, after the used ones', () => {
    expect(categoryOptions(cards, 'tortuga', '', ['infra', 'ui']).map((o) => o.name)).toEqual(['ui', 'db', 'infra'])
  })
  test('offers a new category only when it is not an existing one', () => {
    const opts = categoryOptions(cards, 'tortuga', 'ui')
    expect(newCategory(opts, 'UI')).toBeNull()
    expect(newCategory(opts, 'Billing ')).toBe('billing')
    expect(newCategory(opts, '  ')).toBeNull()
  })
})

describe('checklist edits', () => {
  test('moveCheck reorders and ignores out-of-range moves', () => {
    expect(moveCheck(ck('a', 'b', 'c'), 0, 2).map((c) => c.text)).toEqual(['b', 'c', 'a'])
    expect(moveCheck(ck('a', 'b', 'c'), 2, 1).map((c) => c.text)).toEqual(['a', 'c', 'b'])
    const same = ck('a', 'b')
    expect(moveCheck(same, 0, -1)).toBe(same)
    expect(moveCheck(same, 1, 2)).toBe(same)
  })
  test('editCheck keeps done state; blank text removes the item', () => {
    const cs = [{ text: 'a', done: true }, { text: 'b', done: false }]
    expect(editCheck(cs, 0, '  A2 ')).toEqual([{ text: 'A2', done: true }, { text: 'b', done: false }])
    expect(editCheck(cs, 1, '   ')).toEqual([{ text: 'a', done: true }])
  })
  test('appendCheck / removeCheck', () => {
    expect(appendCheck(ck('a'), ' b ')).toEqual([...ck('a'), { text: 'b', done: false }])
    expect(appendCheck(ck('a'), '  ')).toEqual(ck('a'))
    expect(removeCheck(ck('a', 'b'), 0)).toEqual(ck('b'))
  })
  test('checkProgress copes with none', () => {
    expect(checkProgress(undefined)).toEqual({ done: 0, total: 0, pct: 0 })
    expect(checkProgress([{ text: 'a', done: true }, { text: 'b', done: false }, { text: 'c', done: true }])).toEqual({ done: 2, total: 3, pct: 67 })
  })
})

describe('footer actions', () => {
  const ids = (state: Parameters<typeof nextActions>[0]['state'], later_at: number | null = null) => nextActions({ state, later_at }).map((a) => a.id)
  test('one set per state', () => {
    expect(ids('proposed')).toEqual(['accept', 'later', 'drop'])
    expect(ids('todo')).toEqual(['start', 'later'])
    expect(ids('in_progress')).toEqual(['review'])
    expect(ids('review')).toEqual(['approve', 'back'])
    expect(ids('done')).toEqual(['reopen'])
    expect(ids('dropped')).toEqual(['restore'])
  })
  test('patches carry the right state', () => {
    const by = (s: Parameters<typeof nextActions>[0]['state']) => Object.fromEntries(nextActions({ state: s, later_at: null }).map((a) => [a.id, a.patch]))
    expect(by('proposed').accept).toEqual({ state: 'todo' })
    expect(by('proposed').drop).toEqual({ state: 'dropped' })
    expect(by('todo').start).toEqual({ state: 'in_progress' })
    expect(by('review').approve).toEqual({ state: 'done' })
    expect(by('review').back).toEqual({ state: 'in_progress' })
  })
  test('approve is the green action; a shelved card offers Bring back', () => {
    expect(nextActions({ state: 'review', later_at: null })[0].tone).toBe('approve')
    const a = nextActions({ state: 'proposed', later_at: 5 })
    expect(a[1]).toMatchObject({ id: 'unlater', label: 'Bring back', patch: { later: false } })
  })
})

describe('foldMoves', () => {
  const MIN = 60_000, DAY = 24 * 60 * MIN
  const mv = (at: number, from: string, to: string) => ({ at, by: 'user', text: `moved ${from} → ${to}`, kind: 'event' as const })
  const ev = (at: number, text = 'edited title') => ({ at, by: 'user', text, kind: 'event' as const })
  const cm = (at: number) => ({ at, by: 'user', text: `hi ${at}`, kind: 'comment' as const })
  test('parseMove reads moved a → b and nothing else', () => {
    expect(parseMove(mv(1, 'todo', 'in_progress'))).toEqual({ from: 'todo', to: 'in_progress' })
    expect(parseMove(ev(1))).toBeNull()
    expect(parseMove(ev(1, 'moved the goalposts'))).toBeNull()
    expect(parseMove(ev(1, 'moved nowhere → done'))).toBeNull()
    expect(parseMove({ at: 1, by: 'user', text: 'moved todo → done', kind: 'comment' })).toBeNull()
  })
  test('two or more consecutive moves fold into one line with the path and span', () => {
    const items = foldMoves([mv(0, 'proposed', 'todo'), mv(DAY, 'todo', 'in_progress'), mv(5 * DAY, 'in_progress', 'review'), mv(5 * DAY + MIN, 'review', 'done')])
    expect(items).toHaveLength(1)
    const it = items[0]
    expect(it.kind).toBe('moves')
    if (it.kind === 'moves') {
      expect(it.path).toEqual(['proposed', 'todo', 'in_progress', 'review', 'done'])
      expect(it.notes).toHaveLength(4)
      expect(movesLabel(it.path, it.spanMs)).toBe('Moved Proposed → To do → In progress → Review → Done · over 5d')
    }
  })
  test('a lone move, comments and other events stay; a comment splits two runs', () => {
    const items = foldMoves([mv(1, 'todo', 'in_progress'), ev(2), mv(3, 'in_progress', 'review'), mv(4, 'review', 'done'), cm(5), mv(6, 'done', 'todo'), mv(7, 'todo', 'in_progress')])
    expect(items.map((i) => i.kind)).toEqual(['note', 'note', 'moves', 'note', 'moves'])
    const ids = items.map((i) => (i.kind === 'moves' ? i.id : -1))
    expect(ids).toEqual([-1, -1, 2, -1, 5])
  })
  test('a back-and-forth keeps every state it visited', () => {
    const [it] = foldMoves([mv(1, 'in_progress', 'review'), mv(2, 'review', 'in_progress'), mv(3, 'in_progress', 'review')])
    expect(it.kind === 'moves' && it.path).toEqual(['in_progress', 'review', 'in_progress', 'review'])
  })
  test('movesLabel leaves the span out under a minute', () => expect(movesLabel(['todo', 'done'], 30_000)).toBe('Moved To do → Done'))
  test('legacy notes without a kind are comments and never fold; empty is empty', () => {
    const legacy = { at: 1, by: 'ag_x', text: 'moved todo → done' }
    expect(foldMoves([legacy, legacy]).every((i) => i.kind === 'note')).toBe(true)
    expect(foldMoves([])).toEqual([])
  })
})

describe('footerActions', () => {
  test('unblocked cards get the plain next actions', () => {
    expect(footerActions({ state: 'todo', later_at: null, blocked_on: null })).toEqual(nextActions({ state: 'todo', later_at: null }))
  })
  test('blocked: Unblock is primary and the state moves go quiet', () => {
    const a = footerActions({ state: 'todo', later_at: null, blocked_on: 'IT' })
    expect(a[0]).toMatchObject({ id: 'unblock', tone: 'primary', patch: { blocked_on: null } })
    expect(a.filter((x) => x.tone === 'primary')).toHaveLength(1)
    expect(a.find((x) => x.id === 'start')?.tone).toBe('quiet')
  })
  test('done and dropped ignore a stale block', () => {
    expect(footerActions({ state: 'done', later_at: null, blocked_on: 'IT' }).map((x) => x.id)).toEqual(['reopen'])
  })
})

describe('small helpers', () => {
  test('prettyEvent names the states in move events and leaves the rest alone', () => {
    expect(prettyEvent('moved todo → in_progress')).toBe('Moved To do → In progress')
    expect(prettyEvent('moved review → done')).toBe('Moved Review → Done')
    expect(prettyEvent('assigned to @maya')).toBe('assigned to @maya')
    expect(prettyEvent('edited title, approach')).toBe('edited title, approach')
  })
  test('hasText', () => {
    expect(hasText('  ')).toBe(false)
    expect(hasText(null)).toBe(false)
    expect(hasText('x')).toBe(true)
  })
})
