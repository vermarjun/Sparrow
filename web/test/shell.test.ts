import { describe, expect, test } from 'bun:test'
import type { Agent, CaptainStatus, CaptainSummary } from '../../src/shared/types'
import type { ProjectRow } from '../src/lib/api'
import { parseRoute } from '../src/lib/route'
import {
  STAR_NAMES, folderSuggestions, handlesOf, mobileTitle, nextCaptainName, parseCreateError, projectCaption, sidebarModel, stepIndex, stepKey,
} from '../src/lib/shell'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, project_id: 'p', handle: id.replace(/^ag_/, ''), kind: 'agent', resume: 'builder', title: 'Builder', harness: 'claude', model: null, effort: null,
  can_hire: [], parent_id: null, depth: 1, cwd: '/Users/me/x', tmux_session: 's', tmux_window: id, tmux_window_id: null, session_id: null,
  state: 'idle', call_id: null, last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, resume_hash: null,
  last_run: null, fleet_id: 'ag_cap', captain: null, created_at: 0, updated_at: 0, ...extra,
})
const cap = (id: string, title: string | null) => agent(id, {
  kind: 'human', harness: 'human', depth: 0, fleet_id: id, handle: id.replace(/^ag_/, 'cap-'),
  captain: { title, branch: 'feat/x', harness: 'claude', origin: 'terminal', archived_at: null },
})
const summary = (id: string, status: CaptainStatus, title: string | null = `Title ${id}`, at = 0, working = 0): CaptainSummary => ({
  agent: cap(id, title), status, online: false,
  fleet: { total: 2, working, queued: 0, waiting: 0, crashed: 0, idle: 1, retired: 0 },
  results: { ok: 0, blocked: 0, failed: 0 }, unread: 0, questions: 0, last_activity_at: at, last_message: null, cards: 0,
  resume: { cwd: '/x', harness: 'claude', session_id: null, command: null, attach: null },
})
const row = (id: string, p: Partial<ProjectRow> = {}): ProjectRow => ({ id, name: id, root: `/Users/me/${id}`, created_at: 0, agents: 5, working: 1, cards: 0, ...p })

describe('nextCaptainName', () => {
  test('the first captain of a project is @captain', () => { expect(nextCaptainName([])).toBe('captain') })
  test('then the first free star', () => {
    expect(nextCaptainName(['captain'])).toBe('cap-orion')
    expect(nextCaptainName(['captain', 'cap-orion', 'cap-lyra'])).toBe('cap-vega')
  })
  test('hires and archived captains hold their handles too', () => {
    expect(nextCaptainName(['captain', 'cap-orion', 'cap-vega', 'james'])).toBe('cap-lyra')
  })
  test('after the stars it counts', () => {
    const all = ['captain', ...STAR_NAMES.map((s) => `cap-${s}`)]
    expect(nextCaptainName(all)).toBe(`cap-${STAR_NAMES.length + 1}`)
    expect(nextCaptainName([...all, `cap-${STAR_NAMES.length + 1}`])).toBe(`cap-${STAR_NAMES.length + 2}`)
  })
  test('handlesOf merges hires and captains', () => {
    expect(handlesOf({ a: agent('ag_james') }, [summary('ag_orion', 'idle')]).sort()).toEqual(['cap-orion', 'james'])
  })
})

describe('sidebarModel', () => {
  const list = [
    summary('ag_a', 'idle', 'Alpha', 5), summary('ag_b', 'working', 'Bravo', 9, 2), summary('ag_c', 'attention', 'Charlie', 1),
    summary('ag_d', 'archived', 'Delta spike', 3), summary('ag_e', 'idle', null, 7),
  ]
  test('groups Needs you · Working · Idle, newest first, archived collapsed at the end', () => {
    const m = sidebarModel(list, '', false)
    expect(m.groups.map((g) => g.label)).toEqual(['Needs you', 'Working', 'Idle', 'Archived'])
    expect(m.groups[2].items.map((s) => s.agent.id)).toEqual(['ag_e', 'ag_a'])
    expect(m.archivedCount).toBe(1)
    expect(m.archivedOpen).toBe(false)
    expect(m.flat.map((s) => s.agent.id)).toEqual(['ag_c', 'ag_b', 'ag_e', 'ag_a'])
  })
  test('expanding archived adds its rows to the keyboard order', () => {
    const m = sidebarModel(list, '', true)
    expect(m.archivedOpen).toBe(true)
    expect(m.flat.at(-1)?.agent.id).toBe('ag_d')
  })
  test('a search filters live over title, handle and branch, and opens archived when it matches there', () => {
    expect(sidebarModel(list, 'bravo', false).flat.map((s) => s.agent.id)).toEqual(['ag_b'])
    expect(sidebarModel(list, '@cap-a', false).flat.map((s) => s.agent.id)).toEqual(['ag_a'])
    const m = sidebarModel(list, 'spike', false)
    expect(m.archivedOpen).toBe(true)
    expect(m.flat.map((s) => s.agent.id)).toEqual(['ag_d'])
  })
  test('empty groups disappear; no match says so', () => {
    const m = sidebarModel(list, 'zzz', false)
    expect(m.empty).toBe(true)
    expect(m.groups).toEqual([])
    expect(sidebarModel([], '', false).empty).toBe(false)
    expect(sidebarModel([summary('ag_a', 'idle')], '', false).groups.map((g) => g.label)).toEqual(['Idle'])
  })
})

describe('stepIndex / stepKey', () => {
  test('clamps at both ends and starts from the matching end', () => {
    expect(stepIndex(-1, 4, 1)).toBe(0)
    expect(stepIndex(-1, 4, -1)).toBe(3)
    expect(stepIndex(3, 4, 1)).toBe(3)
    expect(stepIndex(0, 4, -1)).toBe(0)
    expect(stepIndex(1, 4, 1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })
  test('j/↓ down, k/↑ up, nothing else', () => {
    expect([stepKey('j'), stepKey('ArrowDown'), stepKey('k'), stepKey('ArrowUp'), stepKey('x'), stepKey('Enter')]).toEqual([1, 1, -1, -1, null, null])
  })
})

describe('projectCaption', () => {
  const caps = [summary('ag_a', 'working', 'A', 0, 3), summary('ag_b', 'idle'), summary('ag_c', 'archived', 'C', 0, 5)]
  test('the active project counts from its loaded captains, archived left out', () => {
    expect(projectCaption(row('plutus'), caps)).toEqual({ text: '2 captains', working: 3 })
    expect(projectCaption(row('plutus'), [caps[0]])).toEqual({ text: '1 captain', working: 3 })
  })
  test('other projects use the row counts, falling back to agents', () => {
    expect(projectCaption(row('x', { captains: 8, captains_working: 2 }), null)).toEqual({ text: '8 captains', working: 2 })
    expect(projectCaption(row('x'), null)).toEqual({ text: '5 agents', working: 1 })
    expect(projectCaption(row('x', { agents: 1 }), null).text).toBe('1 agent')
  })
})

describe('folderSuggestions', () => {
  const recent = ['/Users/me/plutus', '/Users/me/sparrow', '/Users/me/lab/notes']
  test('project root first, deduped, capped', () => {
    expect(folderSuggestions('/Users/me/sparrow', recent, '')).toEqual(['/Users/me/sparrow', '/Users/me/plutus', '/Users/me/lab/notes'])
    expect(folderSuggestions(null, recent, '', 2)).toEqual(['/Users/me/plutus', '/Users/me/sparrow'])
  })
  test('filters as you type, ~ allowed; a picked value shows them all', () => {
    expect(folderSuggestions(null, recent, 'lab')).toEqual(['/Users/me/lab/notes'])
    expect(folderSuggestions(null, recent, '~/spar')).toEqual(['/Users/me/sparrow'])
    expect(folderSuggestions(null, recent, '~/plutus')).toEqual(recent)
    expect(folderSuggestions(null, recent, '/Users/me/plutus')).toEqual(recent)
    expect(folderSuggestions(null, recent, 'nope')).toEqual([])
  })
})

describe('parseCreateError', () => {
  test('field-prefixed server errors map to their field', () => {
    expect(parseCreateError('cwd: /nope does not exist')).toEqual({ field: 'cwd', text: '/nope does not exist' })
    expect(parseCreateError('name: handle @x is taken')).toEqual({ field: 'name', text: 'handle @x is taken' })
    expect(parseCreateError('Model: unknown model "gpt"').field).toBe('model')
    expect(parseCreateError('effort : xhigh not accepted').field).toBe('effort')
  })
  test('anything else stays under the form', () => {
    expect(parseCreateError('tmux is not installed')).toEqual({ field: null, text: 'tmux is not installed' })
    expect(parseCreateError('cannot reach cwd: server')).toEqual({ field: null, text: 'cannot reach cwd: server' })
  })
})

describe('mobileTitle', () => {
  test('captain name, project, or page name', () => {
    expect(mobileTitle(parseRoute('#/captain/ag_x'), 'plutus', 'Rate limiting')).toBe('Rate limiting')
    expect(mobileTitle(parseRoute('#/captain/ag_x'), 'plutus', null)).toBe('Captain')
    expect(mobileTitle(parseRoute('#/captains'), 'plutus', null)).toBe('plutus')
    expect(mobileTitle(parseRoute('#/board'), 'plutus', null)).toBe('Board')
    expect(mobileTitle(parseRoute('#/doctor'), null, null)).toBe('Doctor')
  })
})
