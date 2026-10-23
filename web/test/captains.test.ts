import { describe, expect, test } from 'bun:test'
import type { Agent, CaptainStatus, CaptainSummary, MessageView } from '../../src/shared/types'
import {
  HUES, activityMessages, attentionReason, captainInitial, captainMatches, captainName, captainSubline, dayLabel, filterCaptains,
  filterCounts, flattenFleet, fleetStrip, fleetTree, groupByDay, groupCaptains, hiddenUpdates, hueOf, inFleet, lastMessageLine,
  projectLine, shortSession, statusLabel, tildePath,
} from '../src/lib/captains'
import { emptyData, reduce, type Data } from '../src/lib/reduce'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, project_id: 'p', handle: id.replace(/^ag_/, ''), kind: 'agent', resume: 'builder', title: 'Builder', harness: 'claude', model: null, effort: null,
  can_hire: [], parent_id: null, depth: 1, cwd: '/home/demo/x', tmux_session: 's', tmux_window: id, tmux_window_id: null, session_id: null,
  state: 'idle', call_id: null, last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, resume_hash: null,
  last_run: null, fleet_id: 'ag_cap', captain: null, created_at: 0, updated_at: 0, ...extra,
})
const cap = (id: string, title: string | null, extra: Partial<Agent> = {}) => agent(id, {
  kind: 'human', harness: 'human', depth: 0, fleet_id: id, handle: id.replace(/^ag_/, 'cap-'),
  captain: { title, branch: 'feat/x', harness: 'claude', origin: 'terminal', archived_at: null }, ...extra,
})
const summary = (id: string, status: CaptainStatus, extra: Partial<CaptainSummary> = {}): CaptainSummary => ({
  agent: cap(id, `Title ${id}`), status, online: false,
  fleet: { total: 2, working: status === 'working' ? 1 : 0, queued: 0, waiting: 0, crashed: 0, idle: 1, retired: 0 },
  results: { ok: 0, blocked: 0, failed: 0 }, unread: 0, questions: 0, last_activity_at: 0, last_message: null, cards: 0,
  resume: { cwd: '/x', harness: 'claude', session_id: null, command: null, attach: null }, ...extra,
})
let seq = 0
const msg = (kind: MessageView['kind'], thread: string, at = 0, extra: Partial<MessageView> = {}): MessageView => ({
  seq: ++seq, id: `m${seq}`, project_id: 'p', thread, from_id: 'ag_a', kind, text: `${kind} ${seq}`, mentions: [], card_id: null, meta: {},
  created_at: at, from_handle: 'a', thread_label: '', to_handles: [], ...extra,
})

describe('hue + names', () => {
  test('hue is deterministic and one of the 10', () => {
    expect(hueOf('ag_orion')).toBe(hueOf('ag_orion'))
    expect(HUES).toContain(hueOf('ag_orion') as (typeof HUES)[number])
    const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((x) => hueOf(`ag_${x}`)))
    expect(spread.size).toBeGreaterThan(4)
  })
  test('name falls back title → branch → @handle', () => {
    expect(captainName(cap('ag_orion', 'Rate limiting'))).toBe('Rate limiting')
    expect(captainName(cap('ag_orion', '  '))).toBe('feat/x')
    expect(captainName(cap('ag_orion', null, { captain: { title: null, branch: null, harness: 'claude', origin: 'terminal', archived_at: null } }))).toBe('@cap-orion')
  })
  test('initial skips cap-, subline omits the branch when it is the name', () => {
    expect(captainInitial('cap-orion')).toBe('O')
    expect(captainInitial('captain')).toBe('C')
    expect(captainSubline(cap('ag_orion', 'Rate'))).toBe('@cap-orion · feat/x')
    expect(captainSubline(cap('ag_orion', null))).toBe('@cap-orion')
  })
  test('tildePath + shortSession', () => {
    expect(tildePath('/home/demo/code/tortuga')).toBe('~/code/tortuga')
    expect(tildePath('/home/demo')).toBe('~')
    expect(tildePath(['', 'Users', 'demo', 'code'].join('/'))).toBe('~/code') // macOS home
    expect(tildePath('/opt/x')).toBe('/opt/x')
    expect(shortSession('7f3a9c21-8d4e-4b6a-9f10-2e5c7d8a1b34')).toBe('7f3a9c21…')
    expect(shortSession(null)).toBe('')
  })
})

describe('status, grouping, filters', () => {
  const list = [
    summary('ag_a', 'idle', { last_activity_at: 50 }),
    summary('ag_b', 'working', { last_activity_at: 10 }),
    summary('ag_c', 'attention', { unread: 2, last_activity_at: 90 }),
    summary('ag_d', 'attention', { questions: 1, unread: 1, last_activity_at: 20 }),
    summary('ag_e', 'archived', { last_activity_at: 99 }),
    summary('ag_f', 'working', { last_activity_at: 30 }),
  ]
  test('groups: Needs you (questions first) · Working (recent first) · Idle · Archived', () => {
    const g = groupCaptains(list)
    expect(g.map((x) => x.label)).toEqual(['Needs you', 'Working', 'Idle', 'Archived'])
    expect(g[0].items.map((s) => s.agent.id)).toEqual(['ag_d', 'ag_c'])
    expect(g[1].items.map((s) => s.agent.id)).toEqual(['ag_f', 'ag_b'])
  })
  test('empty groups are dropped, Archived always stays', () => {
    expect(groupCaptains([summary('ag_a', 'idle')]).map((g) => g.label)).toEqual(['Idle', 'Archived'])
  })
  test('labels and reasons', () => {
    expect(statusLabel(list[1])).toBe('Working · 1')
    expect(statusLabel(list[3])).toBe('Needs you · 1 question')
    expect(attentionReason(list[2])).toBe('2 unread')
    expect(attentionReason(summary('x', 'attention', { fleet: { total: 1, working: 0, queued: 0, waiting: 0, crashed: 1, idle: 0, retired: 0 } }))).toBe('1 crashed')
    expect(statusLabel(list[0])).toBe('Idle')
  })
  test('filters and counts; all hides archived', () => {
    expect(filterCounts(list)).toEqual({ all: 5, working: 2, attention: 2, idle: 1, archived: 1 })
    expect(filterCaptains(list, 'all').map((s) => s.agent.id)).toEqual(['ag_d', 'ag_c', 'ag_f', 'ag_b', 'ag_a'])
    expect(filterCaptains(list, 'archived').map((s) => s.agent.id)).toEqual(['ag_e'])
    expect(filterCaptains(list, 'all', 'title ag_b').map((s) => s.agent.id)).toEqual(['ag_b'])
    expect(captainMatches(list[0], '@cap-a')).toBe(true)
    expect(captainMatches(list[0], '~/x')).toBe(true)
  })
  test('project line', () => {
    expect(projectLine(list)).toBe('5 captains · 2 agents working · 2 need you')
    expect(projectLine([summary('a', 'idle')])).toBe('1 captain · 0 agents working')
  })
})

describe('fleet', () => {
  const fleet = [
    cap('ag_cap', 'Feature'),
    agent('ag_maya', { parent_id: 'ag_cap', created_at: 1, state: 'waiting', resume: 'sub-captain' }),
    agent('ag_james', { parent_id: 'ag_maya', depth: 2, created_at: 2, state: 'working' }),
    agent('ag_leo', { parent_id: 'ag_maya', depth: 2, created_at: 3, state: 'queued' }),
    agent('ag_omar', { parent_id: 'ag_cap', created_at: 4, state: 'retired' }),
    agent('ag_other', { fleet_id: 'ag_x', parent_id: 'ag_x' }),
  ]
  test('tree: captain → hires → their hires; other fleets excluded', () => {
    const t = fleetTree(fleet, 'ag_cap')!
    expect(t.agent.id).toBe('ag_cap')
    expect(t.children.map((c) => c.agent.id)).toEqual(['ag_maya', 'ag_omar'])
    expect(t.children[0].children.map((c) => c.agent.id)).toEqual(['ag_james', 'ag_leo'])
    expect(fleetTree(fleet, 'ag_nope')).toBeNull()
  })
  test('flatten: depth-first with guides and last flags', () => {
    const rows = flattenFleet(fleetTree(fleet, 'ag_cap'))
    expect(rows.map((r) => `${r.agent.id}:${r.depth}:${r.last ? 'L' : 'T'}:${r.guides.map((g) => (g ? '|' : ' ')).join('')}`)).toEqual([
      'ag_cap:0:L:', 'ag_maya:1:T:', 'ag_james:2:T:|', 'ag_leo:2:L:|', 'ag_omar:1:L:',
    ])
  })
  test('orphans hang off the captain', () => {
    const t = fleetTree([cap('ag_cap', 'x'), agent('ag_z', { parent_id: 'ag_gone' })], 'ag_cap')!
    expect(t.children.map((c) => c.agent.id)).toEqual(['ag_z'])
  })
  test('strip: hires only, working first, capped with +n', () => {
    const s = fleetStrip(fleet, 'ag_cap')
    expect(s.segments.map((x) => x.state)).toEqual(['working', 'queued', 'waiting', 'retired'])
    const many = [cap('ag_cap', 'x'), ...Array.from({ length: 30 }, (_, i) => agent(`ag_${i}`, { parent_id: 'ag_cap' }))]
    const capped = fleetStrip(many, 'ag_cap')
    expect(capped.segments.length).toBe(24)
    expect(capped.more).toBe(6)
  })
})

describe('activity', () => {
  const T = 'dm:ag_cap:ag_maya', J = 'dm:ag_james:ag_maya', O = 'dm:ag_cap:ag_omar'
  test('in fleet: either side of the dm thread', () => {
    expect(inFleet({ thread: J }, new Set(['ag_james']))).toBe(true)
    expect(inFleet({ thread: J }, new Set(['ag_x']))).toBe(false)
    expect(inFleet({ thread: 'group' }, new Set(['ag_x']))).toBe(false)
  })
  test('agent filter keeps that agent\'s threads; dedupe + sort by seq', () => {
    const a = msg('task', T), b = msg('task', J), c = msg('result', O)
    const out = activityMessages([c, a, b, a], { agent: 'ag_maya', updates: 'all' })
    expect(out.map((m) => m.seq)).toEqual([a.seq, b.seq])
  })
  test('updates: recent keeps the last 20, none hides, all keeps', () => {
    const ups = Array.from({ length: 25 }, () => msg('update', J))
    const task = msg('task', T)
    const list = [...ups, task]
    expect(activityMessages(list).filter((m) => m.kind === 'update').length).toBe(20)
    expect(activityMessages(list).filter((m) => m.kind === 'update')[0].seq).toBe(ups[5].seq)
    expect(activityMessages(list, { updates: 'none' }).map((m) => m.kind)).toEqual(['task'])
    expect(activityMessages(list, { updates: 'all' }).length).toBe(26)
    expect(hiddenUpdates(list)).toBe(5)
    expect(hiddenUpdates(list, 'ag_cap')).toBe(0)
  })
  test('day groups and labels', () => {
    const now = new Date(2026, 9, 20, 15, 0).getTime()
    const today = new Date(2026, 9, 20, 9, 0).getTime()
    const yest = new Date(2026, 9, 19, 23, 0).getTime()
    const old = new Date(2026, 8, 2, 12, 0).getTime()
    const lastYear = new Date(2025, 8, 2, 12, 0).getTime()
    expect(dayLabel(today, now)).toBe('Today')
    expect(dayLabel(yest, now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 9, 16, 12).getTime(), now)).toBe('Friday')
    expect(dayLabel(old, now)).toBe('Sep 2')
    expect(dayLabel(lastYear, now)).toBe('Sep 2, 2025')
    const g = groupByDay([msg('task', T, yest), msg('task', T, today), msg('result', T, today + 1)], now)
    expect(g.map((x) => [x.label, x.items.length])).toEqual([['Yesterday', 1], ['Today', 2]])
  })
  test('last message one-liner skips the Result heading', () => {
    const r = msg('result', J, 0, { text: '## Result\n**Rate limiting** done, 14 tests green', from_handle: 'james', meta: { status: 'ok' } })
    expect(lastMessageLine(r)).toEqual({ glyph: '✓', tone: 'ok', from: '@james', text: 'Rate limiting done, 14 tests green' })
    expect(lastMessageLine(msg('result', J, 0, { meta: { status: 'failed' } }))!.tone).toBe('failed')
    expect(lastMessageLine(msg('question', J))!.glyph).toBe('?')
    expect(lastMessageLine(null)).toBeNull()
  })
})

describe('reduce: captains + fleet messages', () => {
  test('message.created appends to every loaded fleet it belongs to; agent.updated patches the captain summary', () => {
    let d: Data = { ...emptyData('p'), agents: { ag_cap: cap('ag_cap', 'x'), ag_maya: agent('ag_maya', { parent_id: 'ag_cap' }) }, fleetMessages: { ag_cap: [], ag_other: [] }, captains: [summary('ag_cap', 'idle')] }
    d.captains[0] = { ...d.captains[0], agent: cap('ag_cap', 'x') }
    const m = msg('result', 'dm:ag_cap:ag_maya')
    d = reduce(d, { type: 'message.created', project_id: 'p', message: m })
    expect(d.fleetMessages.ag_cap.map((x) => x.seq)).toEqual([m.seq])
    expect(d.fleetMessages.ag_other).toEqual([])
    const again = reduce(d, { type: 'message.created', project_id: 'p', message: m })
    expect(again.fleetMessages.ag_cap.length).toBe(1)
    const renamed = { ...cap('ag_cap', 'New title') }
    d = reduce(d, { type: 'agent.updated', project_id: 'p', agent: renamed })
    expect(captainName(d.captains[0].agent)).toBe('New title')
    const archived = { ...renamed, captain: { ...renamed.captain!, archived_at: 5 } }
    expect(reduce(d, { type: 'agent.updated', project_id: 'p', agent: archived }).captains[0].status).toBe('archived')
  })
})
