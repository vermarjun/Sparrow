import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_PREFS, loadPrefs, sanitizePrefs, savePrefs } from '../src/lib/boardPrefs'

describe('sanitizePrefs', () => {
  test('junk and null become defaults', () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs('x')).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs({ sort: 'bogus', view: [], list: { key: 'nope', dir: 3 }, filters: { categories: [1, 'UI'] } }).sort).toBe('manual')
  })
  test('valid values survive; categories are lowercased; q is dropped', () => {
    const p = sanitizePrefs({ sort: 'roi', view: 'list', showDropped: true, laterOpen: { todo: true }, filters: { q: 'abc', urgent: true, categories: ['UI', 5], assignee: 'ag_1', captain: 7 }, list: { key: 'age', dir: 'desc' } })
    expect(p).toMatchObject({ sort: 'roi', view: 'list', showDropped: true, laterOpen: { proposed: false, todo: true }, list: { key: 'age', dir: 'desc' } })
    expect(p.filters).toEqual({ q: '', urgent: true, blocked: false, quick: false, categories: ['ui'], assignee: 'ag_1', captain: null, state: null })
  })
})

describe('old keys', () => {
  test('density (removed in v3) is ignored and not carried over', () => {
    const p = sanitizePrefs({ density: 'detailed', view: 'list' }) as unknown as Record<string, unknown>
    expect('density' in p).toBe(false)
    expect(p.view).toBe('list')
    expect(sanitizePrefs({ density: 'detailed' })).toEqual(DEFAULT_PREFS)
  })
  test('the state filter is never loaded or saved', () => {
    expect(sanitizePrefs({ filters: { state: 'done' } }).filters.state).toBeNull()
  })
})

describe('storage', () => {
  const g = globalThis as unknown as { localStorage?: unknown }
  const original = g.localStorage
  afterEach(() => { g.localStorage = original })
  test('round-trips per project', () => {
    const mem = new Map<string, string>()
    g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    savePrefs('a', { ...DEFAULT_PREFS, sort: 'impact', filters: { ...DEFAULT_PREFS.filters, q: 'secret', urgent: true } })
    expect(loadPrefs('a')).toMatchObject({ sort: 'impact', filters: { q: '', urgent: true } })
    expect(loadPrefs('b')).toEqual(DEFAULT_PREFS)
    savePrefs('a', { ...DEFAULT_PREFS, filters: { ...DEFAULT_PREFS.filters, state: 'done' } })
    expect(JSON.parse(mem.get('sparrow.board.v2.a')!).filters.state).toBeNull()
  })
  test('missing or throwing storage falls back to defaults without throwing', () => {
    g.localStorage = undefined
    expect(loadPrefs('a')).toEqual(DEFAULT_PREFS)
    expect(() => savePrefs('a', DEFAULT_PREFS)).not.toThrow()
    g.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(loadPrefs('a')).toEqual(DEFAULT_PREFS)
    expect(() => savePrefs('a', DEFAULT_PREFS)).not.toThrow()
    g.localStorage = { getItem: () => '{not json', setItem: () => {} }
    expect(loadPrefs('a')).toEqual(DEFAULT_PREFS)
  })
})
