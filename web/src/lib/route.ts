// Hash routes (§7.1): #/captains (home, default), #/captain/<id>[?tab=…][&agent=…], #/board, #/resumes[/<slug>],
// #/skills[/<name>], #/doctor, #/settings; `?p=<project>` on any of them. Old #/chat and #/agents redirect to #/captains.
import { useEffect, useState } from 'react'

export type Page = 'captains' | 'captain' | 'board' | 'resumes' | 'skills' | 'doctor' | 'settings'
export type CaptainTab = 'activity' | 'team' | 'cards'
export const CAPTAIN_TABS: CaptainTab[] = ['activity', 'team', 'cards']

export interface Route {
  page: Page
  project: string | null
  /** #/captain/<id> */
  captain: string | null
  tab: CaptainTab
  /** Agent sheet open on the captain page. */
  agent: string | null
  /** Resumes slug / Skills name. */
  slug: string | null
  /** The hash named a page that no longer exists (#/chat, #/agents) or nothing known: rewrite it. */
  redirected: boolean
}

const PAGES: Page[] = ['captains', 'captain', 'board', 'resumes', 'skills', 'doctor', 'settings']
/** Pages that work without a project (render outside the project gate). */
export const GLOBAL_PAGES: Page[] = ['resumes', 'skills', 'doctor', 'settings']

export function parseRoute(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?')
  const [head, ...rest] = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query ?? '')
  const known = PAGES.includes(head as Page)
  let page: Page = known ? (head as Page) : 'captains'
  const captain = page === 'captain' && rest[0] ? decodeURIComponent(rest[0]) : null
  if (page === 'captain' && !captain) page = 'captains'
  const tabRaw = params.get('tab')
  const tab: CaptainTab = CAPTAIN_TABS.includes(tabRaw as CaptainTab) ? (tabRaw as CaptainTab) : 'activity'
  return {
    page,
    project: params.get('p'),
    captain,
    tab,
    agent: page === 'captain' ? params.get('agent') : null,
    slug: (page === 'resumes' || page === 'skills') && rest[0] ? decodeURIComponent(rest[0]) : null,
    redirected: !!head && !known,
  }
}

/** Build a hash (with the leading '#') for a route. Defaults: activity tab, no agent, no project. */
export function href(r: Partial<Route> & { page: Page }): string {
  let path = `/${r.page}`
  if (r.page === 'captain' && r.captain) path += `/${encodeURIComponent(r.captain)}`
  if ((r.page === 'resumes' || r.page === 'skills') && r.slug) path += `/${encodeURIComponent(r.slug)}`
  const q = new URLSearchParams()
  if (r.page === 'captain' && r.tab && r.tab !== 'activity') q.set('tab', r.tab)
  if (r.page === 'captain' && r.agent) q.set('agent', r.agent)
  if (r.project) q.set('p', r.project)
  const s = q.toString()
  return `#${path}${s ? `?${s}` : ''}`
}

export const captainHref = (id: string, project: string | null, extra: { tab?: CaptainTab; agent?: string | null } = {}) =>
  href({ page: 'captain', captain: id, project, ...extra })

/** Navigate (pushes history). `replace` swaps the current entry (redirects, tab switches you do not want in history). */
export function navigate(to: string, replace = false) {
  if (replace) {
    history.replaceState(null, '', to)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else location.hash = to.slice(1)
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
