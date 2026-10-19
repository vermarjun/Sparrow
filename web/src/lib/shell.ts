// Pure helpers for the shell (sidebar, palette, New captain dialog). Unit-tested in web/test/shell.test.ts.
import type { Agent, CaptainSummary } from '@shared/types'
import { captainMatches, groupCaptains, tildePath, type CaptainGroup } from './captains'
import type { ProjectRow } from './api'
import { href, navigate, type Route } from './route'
import { useStore } from './store'

/** Handles offered for the next captain, in order (spec §2: `cap-orion`, `cap-vega`, … then `cap-<n>`). */
export const STAR_NAMES = ['orion', 'vega', 'lyra', 'sirius', 'rigel', 'altair', 'deneb', 'polaris', 'antares', 'castor', 'pollux', 'spica', 'mira', 'atlas'] as const

/** The handle the server would pick next: `captain` for a project without one, else the first free `cap-<star>` / `cap-<n>`. */
export function nextCaptainName(handles: Iterable<string>): string {
  const taken = new Set(handles)
  if (!taken.has('captain')) return 'captain'
  for (const s of STAR_NAMES) if (!taken.has(`cap-${s}`)) return `cap-${s}`
  for (let n = STAR_NAMES.length + 1; ; n++) if (!taken.has(`cap-${n}`)) return `cap-${n}`
}

// ---------------------------------------------------------------- sidebar

export interface SidebarModel {
  groups: CaptainGroup[]
  /** Archived are collapsed unless the user opened them or a search matches one. */
  archivedOpen: boolean
  archivedCount: number
  /** The rows in the order they are on screen (what j/k walk). */
  flat: CaptainSummary[]
  /** True when a search matched nothing at all. */
  empty: boolean
}

export function sidebarModel(list: CaptainSummary[], q: string, archivedExpanded: boolean): SidebarModel {
  const query = q.trim()
  const hits = query ? list.filter((s) => captainMatches(s, query)) : list
  const groups = groupCaptains(hits)
  const archived = groups.find((g) => g.status === 'archived')
  const archivedCount = archived?.items.length ?? 0
  const archivedOpen = archivedCount > 0 && (archivedExpanded || !!query)
  const live = groups.filter((g) => g.status !== 'archived')
  const kept = archivedCount > 0 ? [...live, archived!] : live
  const flat = kept.flatMap((g) => (g.status === 'archived' && !archivedOpen ? [] : g.items))
  return { groups: kept, archivedOpen, archivedCount, flat, empty: !!query && hits.length === 0 }
}

/** Index after a j/k/↑/↓ step, clamped (no wrap: the ends are where the list ends). */
export function stepIndex(cur: number, len: number, dir: 1 | -1): number {
  if (len <= 0) return -1
  if (cur < 0) return dir === 1 ? 0 : len - 1
  return Math.min(len - 1, Math.max(0, cur + dir))
}

/** j/k/↑/↓ → direction, null for anything else. */
export function stepKey(key: string): 1 | -1 | null {
  if (key === 'j' || key === 'ArrowDown') return 1
  if (key === 'k' || key === 'ArrowUp') return -1
  return null
}

// ---------------------------------------------------------------- projects

/** `4 captains · 2 working`: the active project counts from its loaded captains (always fresh), the others from the project row. */
export function projectCaption(p: ProjectRow, captains: CaptainSummary[] | null): { text: string; working: number } {
  const n = captains ? captains.filter((s) => s.status !== 'archived').length : p.captains
  const working = captains ? captains.reduce((sum, s) => sum + (s.status === 'archived' ? 0 : s.fleet.working), 0) : (p.captains_working ?? p.working)
  if (n === undefined) return { text: `${p.agents} agent${p.agents === 1 ? '' : 's'}`, working }
  return { text: `${n} captain${n === 1 ? '' : 's'}`, working }
}

// ---------------------------------------------------------------- new captain

/** `/Users/me/code/x` → `~/code/x`; already-tilde paths stay. */
export const folderLabel = (p: string) => tildePath(p)

/** Folder options: the project root first, then recent roots, deduped, filtered by what was typed (a value that already equals an option shows them all). */
export function folderSuggestions(projectRoot: string | null, recent: string[], typed: string, max = 6): string[] {
  const all = [...new Set([...(projectRoot ? [projectRoot] : []), ...recent])]
  const q = typed.trim().toLowerCase()
  if (!q || all.some((p) => p.toLowerCase() === q || tildePath(p).toLowerCase() === q)) return all.slice(0, max)
  const bare = q.replace(/^~/, '')
  return all.filter((p) => p.toLowerCase().includes(bare)).slice(0, max)
}

export type CreateField = 'cwd' | 'title' | 'name' | 'model' | 'effort'

/** The server prefixes errors with the field they name (`cwd: …`, `name: …`); unnamed errors go under the form. */
export function parseCreateError(msg: string): { field: CreateField | null; text: string } {
  const m = msg.match(/^(cwd|title|name|model|effort)\s*:\s*(.*)$/is)
  if (!m) return { field: null, text: msg }
  return { field: m[1].toLowerCase() as CreateField, text: m[2] }
}

// ---------------------------------------------------------------- mobile bar

const PAGE_TITLE: Partial<Record<Route['page'], string>> = { board: 'Board', resumes: 'Resumes', skills: 'Skills', doctor: 'Doctor', settings: 'Settings' }

/** Title in the mobile top bar: the captain's name on its page, the project on the home, else the page name. */
export function mobileTitle(route: Route, project: string | null, captainTitle: string | null): string {
  if (route.page === 'captain') return captainTitle ?? 'Captain'
  if (route.page === 'captains') return project ?? 'Captains'
  return PAGE_TITLE[route.page] ?? 'Sparrow'
}

/** Handles of everything in the project (captains and hires), for picking a free name. */
export const handlesOf = (agents: Record<string, Agent>, captains: CaptainSummary[]): string[] => [
  ...Object.values(agents).map((a) => a.handle), ...captains.map((s) => s.agent.handle),
]

/** Switching keeps the page type, except on a captain page (that captain belongs to the old project) → project home. */
export function switchProject(id: string, route: Route) {
  const page = route.page === 'captain' ? 'captains' : route.page
  useStore.getState().selectProject(id)
  navigate(href({ page, slug: page === 'resumes' || page === 'skills' ? route.slug : null, project: id }))
}
