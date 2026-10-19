import { describe, expect, test } from 'bun:test'
import { type DragItem, laterZoneId, planDrop, reorderable, zoneState } from '../src/lib/boardDrag'
import { mkCard } from './cardFixtures'

const item = (c: { id: number; state: string; later_at?: number | null }, column = c.state): DragItem => ({ id: String(c.id), name: '', column, cardId: c.id, later: !!c.later_at })

describe('planDrop', () => {
  const cards = [
    mkCard(1, { state: 'todo', position: 1 }), mkCard(2, { state: 'todo', position: 2 }), mkCard(3, { state: 'todo', position: 3, later_at: 5 }),
    mkCard(4, { state: 'review', position: 1 }), mkCard(5, { state: 'review', position: 2 }),
    mkCard(6, { state: 'done', position: 1 }),
  ]
  const snap = Object.fromEntries(cards.map((c) => [c.id, c]))
  const before = cards.map((c) => item(c))
  const move = (id: number, to: string, at?: number) => {
    const moved = { ...item(snap[id]), column: to, later: false }
    const rest = before.filter((i) => i.cardId !== id)
    const idx = at ?? rest.length
    return [...rest.slice(0, idx), moved, ...rest.slice(idx)]
  }

  test('cross-column drop is one patch with state and a position between neighbours', () => {
    const final = move(1, 'review', 1) // between 4 and 5 after removing 1 → index among all items
    const reviewIds = final.filter((i) => i.column === 'review').map((i) => i.cardId)
    const p = planDrop({ card: snap[1], before, final, overId: '5', sort: 'manual', cards: snap })
    expect(reviewIds).toContain(1)
    expect(p).toMatchObject({ state: 'review' })
    expect(typeof p!.position).toBe('number')
    expect(p!.later).toBeUndefined()
  })

  test('same-column reorder in manual sort sends only a position', () => {
    const final = [before[1], before[0], ...before.slice(2)]
    const p = planDrop({ card: snap[1], before, final, overId: '2', sort: 'manual', cards: snap })
    expect(p).toEqual({ position: expect.any(Number) })
  })

  test('same-column drop under another sort is a no-op', () => {
    const final = [before[1], before[0], ...before.slice(2)]
    expect(planDrop({ card: snap[1], before, final, overId: '2', sort: 'newest', cards: snap })).toBeNull()
  })

  test('in progress / review reorder even when the toolbar sort is not manual', () => {
    expect(reorderable('review', 'newest')).toBe(true)
    expect(reorderable('todo', 'newest')).toBe(false)
    expect(reorderable('done', 'manual')).toBe(false)
  })

  test('cross-column drop under a sort goes to the end of the column with state only', () => {
    const final = move(1, 'done', 0)
    expect(planDrop({ card: snap[1], before, final, overId: '6', sort: 'manual', cards: snap })).toEqual({ state: 'done', position: 2 })
  })

  test('dropping on the Later line shelves the card (and moves it when from another column)', () => {
    expect(zoneState(laterZoneId('todo'))).toBe('todo')
    expect(zoneState('later:done')).toBeNull()
    const final = [...before.filter((i) => i.cardId !== 1), { ...before[0] }]
    expect(planDrop({ card: snap[1], before, final, overId: laterZoneId('todo'), sort: 'manual', cards: snap })).toMatchObject({ later: true, position: 4 })
    const fromReview = move(4, 'todo')
    expect(planDrop({ card: snap[4], before, final: fromReview, overId: laterZoneId('todo'), sort: 'manual', cards: snap })).toMatchObject({ state: 'todo', later: true })
  })

  test('dropping a shelved card among active ones brings it back', () => {
    const final = [before[2], before[0], before[1], ...before.slice(3)]
    const p = planDrop({ card: snap[3], before, final, overId: '1', sort: 'manual', cards: snap })
    expect(p).toMatchObject({ later: false })
  })

  test('dropping a shelved card on a shelved card keeps it shelved (reorder only)', () => {
    const later2 = mkCard(7, { state: 'todo', position: 4, later_at: 6 })
    const all = { ...snap, 7: later2 }
    const b = [...before, item(later2)]
    const final = [...b.slice(0, 2), b[6], b[2], ...b.slice(3, 6)]
    const p = planDrop({ card: later2, before: b, final, overId: '3', sort: 'manual', cards: all })
    expect(p?.later).toBeUndefined()
  })

  test('an unchanged drop is null', () => {
    expect(planDrop({ card: snap[1], before, final: before, overId: '1', sort: 'manual', cards: snap })).toBeNull()
  })
})
