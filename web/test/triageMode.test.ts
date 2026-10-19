import { describe, expect, test } from 'bun:test'
import { DEFAULT_ORDER, departed, focusAfterDeparture, headerText, inboxQueue, inversePatch, laterQueue, parseOrder, patchVerb, progressOf, triageCommand, withGhosts } from '../src/lib/triageMode'
import { DAY, mkCard } from './cardFixtures'

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, ...extra })

describe('queues', () => {
  const cards = [
    mkCard(1, { state: 'proposed', created_at: 5 * DAY }),
    mkCard(2, { state: 'proposed', created_at: 2 * DAY }),
    mkCard(3, { state: 'proposed', created_at: 1 * DAY, later_at: 9 * DAY }),
    mkCard(4, { state: 'proposed', created_at: 3 * DAY, later_at: 8 * DAY }),
    mkCard(5, { state: 'todo', created_at: 1 }),
    mkCard(6, { state: 'proposed', created_at: 2 * DAY }),
  ]
  test('inbox defaults to newest first (ties: higher id first)', () => {
    expect(DEFAULT_ORDER).toBe('newest')
    expect(inboxQueue(cards).map((c) => c.id)).toEqual([1, 6, 2])
  })
  test('inbox: oldest first, ties by id', () => {
    expect(inboxQueue(cards, 'oldest').map((c) => c.id)).toEqual([2, 6, 1])
  })
  test('later: proposed shelved, most recently parked first / longest parked first', () => {
    expect(laterQueue(cards).map((c) => c.id)).toEqual([3, 4])
    expect(laterQueue(cards, 'oldest').map((c) => c.id)).toEqual([4, 3])
  })
  test('parseOrder only accepts the two orders', () => {
    expect(parseOrder('oldest')).toBe('oldest')
    expect(parseOrder('newest')).toBe('newest')
    expect(parseOrder('x')).toBe('newest')
    expect(parseOrder(null)).toBe('newest')
  })
  test('does not mutate its input', () => {
    const copy = [...cards]
    inboxQueue(cards)
    expect(cards).toEqual(copy)
  })
})

describe('triageCommand', () => {
  const card = mkCard(1, { state: 'proposed' })
  test('the board keys keep their meaning', () => {
    expect(triageCommand(key('a'), card, 'inbox')).toEqual({ kind: 'accept' })
    expect(triageCommand(key('l'), card, 'inbox')).toEqual({ kind: 'later' })
    expect(triageCommand(key('d'), card, 'inbox')).toEqual({ kind: 'drop' })
    expect(triageCommand(key('u'), card, 'inbox')).toEqual({ kind: 'patch', body: { urgent: true } })
    expect(triageCommand(key('j'), card, 'inbox')).toEqual({ kind: 'step', dir: 1 })
    expect(triageCommand(key('ArrowUp'), card, 'inbox')).toEqual({ kind: 'step', dir: -1 })
    expect(triageCommand(key('Enter'), card, 'inbox')).toEqual({ kind: 'pane' })
    expect(triageCommand(key('Escape'), card, 'inbox')).toEqual({ kind: 'exit' })
  })
  test('return on 1-3, effort on shift 1-3 (physical key)', () => {
    expect(triageCommand(key('3', { code: 'Digit3' }), card, 'inbox')).toEqual({ kind: 'patch', body: { impact: 'high' } })
    expect(triageCommand(key('!', { code: 'Digit1', shiftKey: true }), card, 'inbox')).toEqual({ kind: 'patch', body: { effort: 'low' } })
  })
  test('b blocks, or unblocks a blocked card; z undoes', () => {
    expect(triageCommand(key('b'), card, 'inbox')).toEqual({ kind: 'block' })
    expect(triageCommand(key('b'), mkCard(2, { state: 'proposed', blocked_on: 'IT' }), 'inbox')).toEqual({ kind: 'unblock' })
    expect(triageCommand(key('z'), null, 'inbox')).toEqual({ kind: 'undo' })
  })
  test('l brings a shelved card back in the Later pass', () => {
    expect(triageCommand(key('l'), mkCard(3, { state: 'proposed', later_at: 1 }), 'later')).toEqual({ kind: 'bringBack' })
  })
  test('modifiers and an empty queue do nothing', () => {
    expect(triageCommand(key('a', { metaKey: true }), card, 'inbox')).toBeNull()
    expect(triageCommand(key('z', { metaKey: true }), card, 'inbox')).toBeNull()
    expect(triageCommand(key('b', { ctrlKey: true }), card, 'inbox')).toBeNull()
    expect(triageCommand(key('a'), null, 'inbox')).toBeNull()
    expect(triageCommand(key('b'), null, 'inbox')).toBeNull()
    expect(triageCommand(key('x'), card, 'inbox')).toBeNull()
  })
})

describe('inversePatch / patchVerb', () => {
  const card = mkCard(1, { state: 'proposed', impact: 'low', urgent: false, blocked_on: null })
  test('puts back only the fields the patch touched', () => {
    expect(inversePatch(card, { urgent: true })).toEqual({ urgent: false })
    expect(inversePatch(card, { impact: 'high' })).toEqual({ impact: 'low' })
    expect(inversePatch(card, { effort: 'high' })).toEqual({ effort: null })
    expect(inversePatch(card, { blocked_on: 'IT' })).toEqual({ blocked_on: null })
  })
  test('toast wording', () => {
    expect(patchVerb({ urgent: true })).toBe('marked urgent')
    expect(patchVerb({ urgent: false })).toBe('no longer urgent')
    expect(patchVerb({ impact: 'high' })).toBe('return set to high')
    expect(patchVerb({ blocked_on: 'IT: sandbox' })).toBe('blocked on IT: sandbox')
    expect(patchVerb({ blocked_on: null })).toBe('unblocked')
  })
})

describe('progress and header', () => {
  test('fraction of the peak pile that is cleared', () => {
    expect(progressOf(12, 12).done).toBe(0)
    expect(progressOf(3, 12)).toEqual({ left: 3, total: 12, done: 0.75 })
    expect(progressOf(0, 12).done).toBe(1)
  })
  test('cards arriving mid-session rescale the bar, never overflow it', () => {
    expect(progressOf(15, 12)).toEqual({ left: 15, total: 15, done: 0 })
  })
  test('an empty pile reads as done', () => {
    expect(progressOf(0, 0).done).toBe(1)
  })
  test('header text', () => {
    expect(headerText('inbox', 12)).toBe('Triage · 12 left')
    expect(headerText('inbox', 0)).toBe('Triage · all clear')
    expect(headerText('later', 7)).toBe('Review Later · 7 left')
  })
})

describe('ghosts (rows animating out)', () => {
  const a = mkCard(1, { state: 'proposed' }), b = mkCard(2, { state: 'proposed' }), c = mkCard(3, { state: 'proposed' })
  test('departed reports what left, with its old index', () => {
    expect(departed([a, b, c], [a, c]).map((g) => [g.card.id, g.index])).toEqual([[2, 1]])
    expect(departed([a, b, c], [a, b, c])).toEqual([])
  })
  test('withGhosts splices the fading row back where it was', () => {
    const rows = withGhosts([a, c], [{ card: b, index: 1 }])
    expect(rows.map((r) => [r.card.id, r.ghost])).toEqual([[1, false], [2, true], [3, false]])
  })
  test('a ghost whose card came back (Undo) is dropped', () => {
    expect(withGhosts([a, b, c], [{ card: b, index: 1 }]).filter((r) => r.ghost)).toEqual([])
  })
  test('a ghost past the end is appended', () => {
    expect(withGhosts([a], [{ card: c, index: 5 }]).map((r) => r.card.id)).toEqual([1, 3])
  })
})

describe('focusAfterDeparture', () => {
  const [a, b, c, d] = [1, 2, 3, 4].map((i) => mkCard(i, { state: 'proposed' }))
  test('moves to the next card still queued', () => {
    expect(focusAfterDeparture([a, b, c, d], [a, c, d], 2)).toBe(3)
  })
  test('skips neighbours that left at the same time', () => {
    expect(focusAfterDeparture([a, b, c, d], [a, d], 2)).toBe(4)
  })
  test('falls back to the previous card at the end of the list', () => {
    expect(focusAfterDeparture([a, b, c, d], [a, b, c], 4)).toBe(3)
  })
  test('nothing left: null', () => {
    expect(focusAfterDeparture([a], [], 1)).toBeNull()
  })
})
