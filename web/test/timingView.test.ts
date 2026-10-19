import { describe, expect, test } from 'bun:test'
import { ratioTone, ratioWord, timingView } from '../src/lib/timingView'
import { DAY, HOUR, mkCard } from './cardFixtures'

const T0 = 1_760_000_000_000

describe('ratio presentation', () => {
  test('tone thresholds: green ≤ 1.1, amber ≤ 1.5, red above', () => {
    expect([0.5, 1, 1.1, 1.11, 1.5, 1.51, 3].map(ratioTone)).toEqual(['ok', 'ok', 'ok', 'warn', 'warn', 'bad', 'bad'])
    expect(ratioTone(null)).toBe('none')
  })
  test('words', () => {
    expect(ratioWord(1.3)).toBe('1.3× over')
    expect(ratioWord(0.8)).toBe('0.8× under')
    expect(ratioWord(1.02)).toBe('on estimate')
  })
})

describe('timingView', () => {
  const done = mkCard(1, {
    state: 'done', created_at: T0, estimate_min: 120, created_by: 'ag_cap',
    history: [
      { at: T0, by: 'ag_cap', from: null, to: 'proposed' },
      { at: T0 + DAY, by: 'user', from: 'proposed', to: 'todo' },
      { at: T0 + 2 * DAY, by: 'ag_maya', from: 'todo', to: 'in_progress' },
      { at: T0 + 2 * DAY + 2 * HOUR + 10 * 60_000, by: 'ag_maya', from: 'in_progress', to: 'review' },
      { at: T0 + 2 * DAY + 2 * HOUR + 35 * 60_000, by: 'user', from: 'review', to: 'done' },
    ],
  })
  const v = timingView(done, T0 + 5 * DAY)
  test('milestones carry dates and who', () => {
    expect(v.milestones.map((m) => [m.key, m.at != null])).toEqual([['proposed', true], ['accepted', true], ['started', true], ['review', true], ['done', true]])
    expect(v.milestones[0].label).toBe('Proposed')
    expect(v.milestones[1].by).toBe('user')
  })
  test('stack bar covers each state the ticket sat in, summing to 100%', () => {
    expect(v.segments.map((s) => s.state)).toEqual(['proposed', 'todo', 'in_progress', 'review'])
    expect(v.segments.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100)
    expect(v.segments.find((s) => s.state === 'in_progress')!.label).toBe('Build 2h 10m')
  })
  test('estimate vs build: the ratio ignores review time', () => {
    expect(v.estimate).toBe('2h')
    expect(v.build).toBe('2h 10m')
    expect(v.review).toBe('25m')
    expect(v.active).toBe('2h 35m')
    expect(v.verdict).toBe('1.1× over')
    expect(v.tone).toBe('ok')
  })
  test('a legacy card (no history, no estimate) still renders', () => {
    const l = timingView(mkCard(2, { state: 'proposed' }), 1_000_000 + DAY)
    expect(l.estimate).toBe('no estimate')
    expect(l.active).toBe('not started')
    expect(l.build).toBe('not started')
    expect(l.review).toBe('—')
    expect(l.tone).toBe('none')
    expect(l.milestones.filter((m) => m.at != null).map((m) => m.key)).toEqual(['proposed'])
  })
  test('reopened is surfaced', () => {
    const r = mkCard(3, { state: 'in_progress', history: [
      { at: 1, by: 'a', from: null, to: 'todo' }, { at: 2, by: 'a', from: 'todo', to: 'review' }, { at: 3, by: 'a', from: 'review', to: 'in_progress' },
    ] })
    expect(timingView(r, 10).reopened).toBe(1)
  })
})
