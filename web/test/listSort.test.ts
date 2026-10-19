import { describe, expect, test } from 'bun:test'
import { sortListCards } from '../src/lib/listSort'
import { mkCard } from './cardFixtures'

describe('sortListCards', () => {
  const cards = [
    mkCard(3, { state: 'todo', position: 1, title: 'Zebra', category: null, impact: null, estimate_min: null, created_at: 300, updated_at: 500 }),
    mkCard(1, { state: 'proposed', position: 2, title: 'Alpha', category: 'ui', impact: 'high', effort: 'low', estimate_min: 90, created_at: 100, updated_at: 300 }),
    mkCard(2, { state: 'proposed', position: 1, title: 'Beta', category: 'db', impact: 'low', effort: 'high', estimate_min: 240, created_at: 200, updated_at: 400 }),
  ]
  const ids = (key: Parameters<typeof sortListCards>[1], dir: 'asc' | 'desc' = 'asc') => sortListCards(cards, key, dir).map((c) => c.id)

  test('sorts state by workflow order and key numerically', () => {
    expect(ids('state')).toEqual([2, 1, 3])
    expect(ids('key', 'desc')).toEqual([3, 2, 1])
  })

  test('sorts text and keeps missing categories last in either direction', () => {
    expect(ids('title')).toEqual([1, 2, 3])
    expect(ids('category')).toEqual([2, 1, 3])
    expect(ids('category', 'desc')).toEqual([1, 2, 3])
  })

  test('sorts values and leaves unset estimates last', () => {
    expect(ids('payoff')).toEqual([2, 1, 3])
    expect(ids('payoff', 'desc')).toEqual([1, 2, 3])
    expect(ids('estimate')).toEqual([1, 2, 3])
    expect(ids('estimate', 'desc')).toEqual([2, 1, 3])
  })

  test('payoff sorts by return per effort and leaves cards without a payoff last', () => {
    const mixed = [
      mkCard(1, { impact: 'high', effort: 'high' }), // Big bet: 3/3
      mkCard(2, { impact: 'high', effort: 'low' }), // Quick win: 3/1
      mkCard(3, { impact: 'high', effort: null }), // only return set: no payoff
      mkCard(4, { impact: 'low', effort: 'high' }), // Money pit: 1/3
    ]
    expect(sortListCards(mixed, 'payoff', 'asc').map((c) => c.id)).toEqual([4, 1, 2, 3])
    expect(sortListCards(mixed, 'payoff', 'desc').map((c) => c.id)).toEqual([2, 1, 4, 3])
  })

  test('age is newest first ascending; updated is oldest first ascending', () => {
    expect(ids('age')).toEqual([3, 2, 1])
    expect(ids('age', 'desc')).toEqual([1, 2, 3])
    expect(ids('updated')).toEqual([1, 2, 3])
    expect(ids('updated', 'desc')).toEqual([3, 2, 1])
  })

  test('assignee sort is stable and does not mutate its input', () => {
    const input = [...cards]
    expect(ids('assignee')).toEqual([2, 3, 1])
    expect(cards).toEqual(input)
  })

  test('assignee sorts by displayed handle and leaves unassigned last', () => {
    const assigned = [
      mkCard(8, { assignee_id: 'ag_z' }),
      mkCard(9, { assignee_id: 'ag_a' }),
      mkCard(10, { assignee_id: null }),
    ]
    const labels = (id: string | null) => ({ ag_a: 'ada', ag_z: 'zara' }[id ?? ''] ?? null)
    expect(sortListCards(assigned, 'assignee', 'asc', labels).map((c) => c.id)).toEqual([9, 8, 10])
  })
})
