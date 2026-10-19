import { describe, expect, test } from 'bun:test'
import { groupColumns } from '../src/lib/boardFilter'
import { boardOrder, columnStats, focusAfterRemoval, patchUndo, SHORTCUT_GROUPS, stepFocus, triageAction } from '../src/lib/triage'
import { DAY, mkCard } from './cardFixtures'

const NOW = 100 * DAY

describe('columnStats', () => {
  const cards = [
    mkCard(1, { state: 'proposed', estimate_min: 60, urgent: true, created_at: NOW - 20 * DAY }),
    mkCard(2, { state: 'proposed', estimate_min: 90, blocked_on: 'IT', created_at: NOW - 14 * DAY }),
    mkCard(3, { state: 'proposed', estimate_min: 500, later_at: NOW - DAY, urgent: true, created_at: NOW - 30 * DAY }),
    mkCard(4, { state: 'proposed', created_at: NOW - 3 * DAY }),
  ]
  test('sums estimates of non-shelved cards and counts urgent / blocked / stale', () => {
    expect(columnStats('proposed', cards, NOW)).toEqual({ estimate: 150, urgent: 1, blocked: 1, stale: 1 })
  })
  test('stale is Proposed only; exactly 14 days is not stale', () => {
    expect(columnStats('todo', cards, NOW).stale).toBe(0)
  })
  test('empty column', () => {
    expect(columnStats('todo', [], NOW)).toEqual({ estimate: 0, urgent: 0, blocked: 0, stale: 0 })
  })
})

describe('focus order', () => {
  const cards = [
    mkCard(1, { state: 'proposed', position: 1 }), mkCard(2, { state: 'proposed', position: 2, later_at: 5 }),
    mkCard(3, { state: 'todo', position: 1 }), mkCard(4, { state: 'done' }),
  ]
  const groups = groupColumns(cards, 'manual')
  const cols = [{ id: 'proposed' as const }, { id: 'todo' as const }, { id: 'done' as const }]
  test('column by column, Later only while its zone is open', () => {
    expect(boardOrder(groups, cols, { proposed: false, todo: false }).map((c) => c.id)).toEqual([1, 3, 4])
    expect(boardOrder(groups, cols, { proposed: true, todo: false }).map((c) => c.id)).toEqual([1, 2, 3, 4])
  })
  const order = cards
  test('j / k start at the ends, step and stop at the ends', () => {
    expect(stepFocus(order, null, 1)).toBe(1)
    expect(stepFocus(order, null, -1)).toBe(4)
    expect(stepFocus(order, 1, 1)).toBe(2)
    expect(stepFocus(order, 4, 1)).toBe(4)
    expect(stepFocus(order, 1, -1)).toBe(1)
    expect(stepFocus(order, 99, 1)).toBe(1) // the focused card left the board
    expect(stepFocus([], 1, 1)).toBeNull()
  })
  test('after removal the focus moves to the next card, else the previous', () => {
    expect(focusAfterRemoval(order, 2)).toBe(3)
    expect(focusAfterRemoval(order, 4)).toBe(3)
    expect(focusAfterRemoval([mkCard(1)], 1)).toBeNull()
    expect(focusAfterRemoval(order, 99)).toBeNull()
  })
})

describe('triageAction', () => {
  const proposed = mkCard(1, { state: 'proposed' })
  const todo = mkCard(2, { state: 'todo', urgent: true })
  const done = mkCard(3, { state: 'done' })
  const inProg = mkCard(4, { state: 'in_progress' })
  test('navigation works without a card; card keys need one', () => {
    expect(triageAction({ key: 'j' }, null)).toEqual({ kind: 'step', dir: 1 })
    expect(triageAction({ key: 'ArrowUp' }, null)).toEqual({ kind: 'step', dir: -1 })
    expect(triageAction({ key: 'a' }, null)).toBeNull()
    expect(triageAction({ key: 'Enter' }, null)).toBeNull()
  })
  test('a accepts Proposed only; l and d work on Proposed and To do', () => {
    expect(triageAction({ key: 'a' }, proposed)).toEqual({ kind: 'accept' })
    expect(triageAction({ key: 'a' }, todo)).toBeNull()
    expect(triageAction({ key: 'l' }, todo)).toEqual({ kind: 'later' })
    expect(triageAction({ key: 'd' }, proposed)).toEqual({ kind: 'drop' })
    expect(triageAction({ key: 'l' }, inProg)).toBeNull()
    expect(triageAction({ key: 'd' }, inProg)).toBeNull()
  })
  test('u toggles urgent, only while the ticket is open', () => {
    expect(triageAction({ key: 'u' }, proposed)).toEqual({ kind: 'patch', body: { urgent: true } })
    expect(triageAction({ key: 'u' }, todo)).toEqual({ kind: 'patch', body: { urgent: false } })
    expect(triageAction({ key: 'u' }, done)).toBeNull()
  })
  test('digits set return, shift+digits set effort (read from the physical key)', () => {
    expect(triageAction({ key: '1', code: 'Digit1' }, proposed)).toEqual({ kind: 'patch', body: { impact: 'low' } })
    expect(triageAction({ key: '3', code: 'Digit3' }, proposed)).toEqual({ kind: 'patch', body: { impact: 'high' } })
    expect(triageAction({ key: '@', code: 'Digit2', shiftKey: true }, proposed)).toEqual({ kind: 'patch', body: { effort: 'medium' } })
    expect(triageAction({ key: '1', code: 'Digit1' }, done)).toBeNull()
  })
  test('modifier chords belong to the browser', () => {
    expect(triageAction({ key: 'a', metaKey: true }, proposed)).toBeNull()
    expect(triageAction({ key: 'j', ctrlKey: true }, proposed)).toBeNull()
  })
  test('unknown keys are ignored', () => {
    expect(triageAction({ key: 'x' }, proposed)).toBeNull()
  })
})

describe('patchUndo (the Undo of u / 1-3 / ⇧1-3)', () => {
  const c = mkCard(7, { urgent: false, impact: 'low', effort: null })
  test('urgent toggles back', () => {
    expect(patchUndo(c, { urgent: true })).toEqual({ label: 'PLU-7 marked urgent', undo: { urgent: false } })
    expect(patchUndo({ ...c, urgent: true }, { urgent: false })).toEqual({ label: 'PLU-7 no longer urgent', undo: { urgent: true } })
  })
  test('return and effort restore the previous value, including "unset"', () => {
    expect(patchUndo(c, { impact: 'high' })).toEqual({ label: 'PLU-7 return high', undo: { impact: 'low' } })
    expect(patchUndo(c, { effort: 'medium' })).toEqual({ label: 'PLU-7 effort medium', undo: { effort: null } })
  })
  test('anything else has no undo', () => {
    expect(patchUndo(c, { title: 'x' })).toBeNull()
  })
})

describe('shortcut sheet', () => {
  const all = SHORTCUT_GROUPS.flatMap((g) => g.keys.map(([k]) => k)).join(' ')
  test('lists every key the board answers to', () => {
    for (const k of ['/', 'n', 't', '?', 'j', 'k', 'Enter', 'Esc', 'a', 'l', 'd', 'u', '1 2 3', '⇧1 ⇧2 ⇧3']) expect(all).toContain(k)
  })
  test('no group is empty', () => {
    for (const g of SHORTCUT_GROUPS) expect(g.keys.length).toBeGreaterThan(0)
  })
})
