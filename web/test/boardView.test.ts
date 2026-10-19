import { describe, expect, test } from 'bun:test'
import type { CardState } from '@shared/types'
import type { ColumnView } from '../src/lib/boardFilter'
import { capDone, columnTip, doneInsight, oldestShelved } from '../src/lib/boardView'
import { mkCard } from './cardFixtures'

const DAY = 86400000
const NOW = 100 * DAY
const empty = (): Record<CardState, ColumnView> => ({ proposed: { active: [], later: [] }, todo: { active: [], later: [] }, in_progress: { active: [], later: [] }, review: { active: [], later: [] }, done: { active: [], later: [] }, dropped: { active: [], later: [] } })

describe('capDone', () => {
  test('keeps the last 7 days and counts the rest', () => {
    const g = empty()
    g.done.active = [
      mkCard(1, { state: 'done', updated_at: NOW - 1 * DAY }),
      mkCard(2, { state: 'done', updated_at: NOW - 6 * DAY }),
      mkCard(3, { state: 'done', updated_at: NOW - 9 * DAY }),
      mkCard(4, { state: 'done', updated_at: NOW - 30 * DAY }),
    ]
    const { groups, older } = capDone(g, NOW)
    expect(groups.done.active.map((c) => c.id)).toEqual([1, 2])
    expect(older).toBe(2)
    expect(g.done.active.length).toBe(4) // input untouched
  })
  test('nothing older, nothing folded', () => {
    const g = empty()
    g.done.active = [mkCard(1, { state: 'done', updated_at: NOW })]
    expect(capDone(g, NOW).older).toBe(0)
  })
})

describe('later line', () => {
  test('oldest shelved card', () => {
    expect(oldestShelved([], NOW)).toBe('')
    expect(oldestShelved([mkCard(1, { later_at: NOW - 21 * DAY }), mkCard(2, { later_at: NOW - 2 * DAY })], NOW)).toBe('oldest 21d')
  })
})

describe('count tooltip', () => {
  test('plain count when nothing is special', () => {
    expect(columnTip('review', [mkCard(1, { state: 'review' })], [], NOW, null)).toEqual(['1 ticket'])
  })
  test('estimate, urgent, blocked, stale and Later', () => {
    const active = [
      mkCard(1, { state: 'proposed', urgent: true, estimate_min: 120, created_at: NOW - 20 * DAY }),
      mkCard(2, { state: 'proposed', blocked_on: 'IT', estimate_min: 60, created_at: NOW - 1 * DAY }),
    ]
    const lines = columnTip('proposed', active, [mkCard(3, { state: 'proposed', later_at: NOW })], NOW, null)
    expect(lines[0]).toBe('3 tickets (1 in Later)')
    expect(lines).toContain('~3h of work')
    expect(lines).toContain('1 urgent')
    expect(lines).toContain('1 blocked')
    expect(lines.some((l) => l.startsWith('1 proposed over'))).toBe(true)
  })
  test('Done carries the insight line', () => {
    expect(columnTip('done', [], [], NOW, '4 done this week · est 0.8× median').at(-1)).toBe('4 done this week · est 0.8× median')
    expect(columnTip('todo', [], [], NOW, 'x')).toEqual(['0 tickets'])
  })
  test('insight is null with nothing done', () => {
    expect(doneInsight([mkCard(1, { state: 'todo' })], NOW)).toBeNull()
    expect(doneInsight([mkCard(1, { state: 'done', updated_at: NOW - DAY })], NOW)).toContain('1 done this week')
  })
})
