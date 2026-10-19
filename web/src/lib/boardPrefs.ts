// Per-project board preferences (sort, filters, view, density, Later sections), kept in localStorage.
// Everything is wrapped: the board renders with defaults when storage is missing or holds junk.
import { CARD_SORTS, type CardSort } from '@shared/cards'
import { NO_FILTERS, type BoardFilters } from './boardFilter'

export type Density = 'compact' | 'detailed'
export type View = 'board' | 'list'
export type ListKey = 'state' | 'key' | 'title' | 'category' | 'return' | 'effort' | 'estimate' | 'age' | 'assignee' | 'updated'

export interface BoardPrefs {
  sort: CardSort
  density: Density
  view: View
  filters: BoardFilters
  /** Which Later sections are expanded (collapsed by default). */
  laterOpen: { proposed: boolean; todo: boolean }
  showDropped: boolean
  list: { key: ListKey; dir: 'asc' | 'desc' }
}

export const DEFAULT_PREFS: BoardPrefs = {
  sort: 'manual', density: 'compact', view: 'board', filters: NO_FILTERS,
  laterOpen: { proposed: false, todo: false }, showDropped: false,
  list: { key: 'state', dir: 'asc' },
}

const LIST_KEYS: ListKey[] = ['state', 'key', 'title', 'category', 'return', 'effort', 'estimate', 'age', 'assignee', 'updated']
const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

/** Turn whatever was stored into a valid BoardPrefs (unknown fields dropped, bad values defaulted). The search text is never persisted. */
export function sanitizePrefs(raw: unknown): BoardPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const f = (r.filters && typeof r.filters === 'object' ? r.filters : {}) as Record<string, unknown>
  const l = (r.list && typeof r.list === 'object' ? r.list : {}) as Record<string, unknown>
  const lo = (r.laterOpen && typeof r.laterOpen === 'object' ? r.laterOpen : {}) as Record<string, unknown>
  const sort = CARD_SORTS.some((s) => s.id === r.sort) ? (r.sort as CardSort) : DEFAULT_PREFS.sort
  return {
    sort,
    density: r.density === 'detailed' ? 'detailed' : 'compact',
    view: r.view === 'list' ? 'list' : 'board',
    filters: {
      q: '',
      urgent: bool(f.urgent, false), blocked: bool(f.blocked, false), quick: bool(f.quick, false),
      categories: Array.isArray(f.categories) ? f.categories.filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase()) : [],
      assignee: typeof f.assignee === 'string' && f.assignee ? f.assignee : null,
    },
    laterOpen: { proposed: bool(lo.proposed, false), todo: bool(lo.todo, false) },
    showDropped: bool(r.showDropped, false),
    list: {
      key: LIST_KEYS.includes(l.key as ListKey) ? (l.key as ListKey) : 'state',
      dir: str(l.dir, 'asc') === 'desc' ? 'desc' : 'asc',
    },
  }
}

const keyFor = (project: string) => `sparrow.board.v2.${project}`

export function loadPrefs(project: string | null): BoardPrefs {
  if (!project) return DEFAULT_PREFS
  try {
    const raw = localStorage.getItem(keyFor(project))
    return sanitizePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(project: string | null, prefs: BoardPrefs): void {
  if (!project) return
  try {
    localStorage.setItem(keyFor(project), JSON.stringify({ ...prefs, filters: { ...prefs.filters, q: '' } }))
  } catch { /* private mode / quota: the board still works */ }
}
