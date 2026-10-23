import { describe, expect, test } from 'bun:test'
import { applyPatch } from '../src/lib/cardPatch'
import { eventIcon, noteKind, timeline, commentCount } from '../src/lib/activity'
import { briefFor, parseCheckLines, pickCommand, whoName } from '../src/lib/cardText'
import { fullDate } from '../src/lib/format'
import { mkCard } from './cardFixtures'

describe('applyPatch', () => {
  const base = mkCard(5, { state: 'todo', later_at: 50, blocked_on: 'x', blocked_at: 7, checks: [{ text: 'a', done: false }, { text: 'b', done: false }] })
  test('state change writes history and clears later when work starts', () => {
    const n = applyPatch(base, { state: 'in_progress' }, 100)
    expect(n.state).toBe('in_progress')
    expect(n.later_at).toBeNull()
    expect(n.history.at(-1)).toEqual({ at: 100, by: 'user', from: 'todo', to: 'in_progress' })
    expect(n.blocked_on).toBe('x') // only done / dropped clear it
    expect(applyPatch(base, { state: 'done' }, 100).blocked_on).toBeNull()
  })
  test('later, urgent, blocked, tags, category, markers', () => {
    expect(applyPatch(mkCard(1), { later: true }, 9).later_at).toBe(9)
    expect(applyPatch(base, { later: false }).later_at).toBeNull()
    expect(applyPatch(base, { urgent: true }).urgent).toBe(true)
    expect(applyPatch(base, { blocked_on: null }).blocked_at).toBeNull()
    expect(applyPatch(base, { blocked_on: 'y' }, 99)).toMatchObject({ blocked_on: 'y', blocked_at: 7 }) // already blocked: keep the date
    expect(applyPatch(mkCard(1), { blocked_on: 'y' }, 99).blocked_at).toBe(99)
    expect(applyPatch(base, { tags: [' A', 'a', 'b'] }).tags).toEqual(['a', 'b'])
    expect(applyPatch(base, { category: ' UI ' }).category).toBe('ui')
    expect(applyPatch(base, { impact: 'high', effort: null, estimate_min: 90 })).toMatchObject({ impact: 'high', effort: null, estimate_min: 90 })
  })
  test('check ticks one item; checks replaces and drops blanks', () => {
    expect(applyPatch(base, { check: { index: 1, done: true } }).checks.map((c) => c.done)).toEqual([false, true])
    expect(applyPatch(base, { checks: ['x', '  ', { text: 'y', done: true }] }).checks).toEqual([{ text: 'x', done: false }, { text: 'y', done: true }])
  })
  test('note appends a comment', () => {
    expect(applyPatch(base, { note: 'hi' }, 5).notes.at(-1)).toEqual({ at: 5, by: 'user', text: 'hi', kind: 'comment' })
  })
  test('does not mutate its input', () => {
    const before = JSON.stringify(base)
    applyPatch(base, { state: 'done', tags: ['z'], check: { index: 0, done: true } })
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('activity', () => {
  test('event icons follow the server wording', () => {
    expect(eventIcon('moved todo → in_progress')).toBe('move')
    expect(eventIcon('assigned to @maya')).toBe('assign')
    expect(eventIcon('unassigned')).toBe('assign')
    expect(eventIcon('marked urgent')).toBe('urgent')
    expect(eventIcon('cleared urgent')).toBe('urgent')
    expect(eventIcon('blocked on IT')).toBe('blocked')
    expect(eventIcon('unblocked after 2d 0h')).toBe('blocked')
    expect(eventIcon('shelved under Later')).toBe('later')
    expect(eventIcon('back from Later')).toBe('later')
    expect(eventIcon('edited title, approach')).toBe('edit')
    expect(eventIcon('checked "x"')).toBe('check')
    expect(eventIcon('@maya reported done → review')).toBe('report')
    expect(eventIcon('something else')).toBe('other')
  })
  test('legacy notes (no kind) are comments; timeline is oldest first and filterable', () => {
    const c = mkCard(1, { notes: [
      { at: 30, by: 'user', text: 'c2' }, { at: 10, by: 'x', text: 'e1', kind: 'event' }, { at: 20, by: 'user', text: 'c1', kind: 'comment' },
    ] })
    expect(noteKind(c.notes[0])).toBe('comment')
    expect(timeline(c, false).map((n) => n.text)).toEqual(['e1', 'c1', 'c2'])
    expect(timeline(c, true).map((n) => n.text)).toEqual(['c1', 'c2'])
    expect(commentCount(c)).toBe(2)
  })
})

describe('copy text', () => {
  test('pick command uses the ticket key', () => {
    expect(pickCommand(mkCard(12))).toBe('Pick up TOR-12 from the Sparrow board: run sparrow card pick TOR-12')
  })
  test('brief uses handles for people', () => {
    const agents = { ag_m: { id: 'ag_m', handle: 'maya' } } as never
    const b = briefFor(mkCard(12, { created_by: 'ag_m', problem: 'broken' }), agents)
    expect(b).toContain('# TOR-12 · Card 12')
    expect(b).toContain('proposed by @maya')
    expect(b).toContain('## Problem')
    expect(whoName(agents)('user')).toBe('you')
  })
  test('parseCheckLines strips markers and blanks', () => {
    expect(parseCheckLines('- one\n\n2. two\n[ ] three\n* [x] four\n  five  ')).toEqual(['one', 'two', 'three', 'four', 'five'])
  })
  test('fullDate is dd Mon yyyy, hh:mm', () => {
    expect(fullDate(new Date(2026, 9, 17, 5, 39).getTime())).toBe('17 Oct 2026, 05:39')
  })
})
