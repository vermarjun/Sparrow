import { describe, expect, test } from 'bun:test'
import { CATEGORY_PALETTE, COLUMNS, categoryClass, categoryIndex, hashString } from '../src/lib/boardStyle'

describe('category colours', () => {
  test('stable and case/space-insensitive', () => {
    expect(categoryClass('ui')).toBe(categoryClass('UI'))
    expect(categoryClass('ui')).toBe(categoryClass('  ui '))
    expect(hashString('export')).toBe(hashString('export'))
  })
  test('always inside the palette', () => {
    for (const n of ['', 'a', 'server', 'docs', 'research', 'x'.repeat(200), 'ünï']) {
      const i = categoryIndex(n)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(CATEGORY_PALETTE.length)
    }
  })
  test('common categories spread over several hues', () => {
    const hues = new Set(['ui', 'server', 'db', 'docs', 'export', 'research', 'infra', 'cli', 'billing', 'auth'].map(categoryIndex))
    expect(hues.size).toBeGreaterThanOrEqual(5)
  })
  test('the palette avoids state hues', () => {
    expect(CATEGORY_PALETTE.join(' ')).not.toMatch(/red|orange|emerald|green|sky|amber|violet/)
  })
})

test('every state has a column style, in board order', () => {
  expect(COLUMNS.map((c) => c.id)).toEqual(['proposed', 'todo', 'in_progress', 'review', 'done', 'dropped'])
})
