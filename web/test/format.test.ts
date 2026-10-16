import { describe, expect, test } from 'bun:test'
import type { Agent } from '../../src/shared/types'
import { ago, buildTree, duration, flattenTree, midpoint, moveFor, previewLine, splitMentions, threadTitle, tmuxAttach } from '../src/lib/format'

const agent = (id: string, parent: string | null, extra: Partial<Agent> = {}): Agent => ({
  id, project_id: 'p', handle: id, kind: 'agent', resume: 'builder', title: 'Builder', harness: 'claude', model: null, effort: null,
  can_hire: [], parent_id: parent, depth: 0, cwd: '/x', tmux_session: 's', tmux_window: id, tmux_window_id: null, session_id: null,
  state: 'idle', call_id: null, last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, resume_hash: null, last_run: null,
  created_at: 0, updated_at: 0, ...extra,
})

describe('midpoint / moveFor', () => {
  test('midpoint of neighbours', () => {
    expect(midpoint(1, 2)).toBe(1.5)
    expect(midpoint(3, undefined)).toBe(4)
    expect(midpoint(undefined, 3)).toBe(2)
    expect(midpoint(undefined, undefined)).toBe(1)
  })
  const pos = new Map([[1, 1], [2, 2], [3, 3], [9, 1]])
  test('cross-column move sends state + position between neighbours', () => {
    expect(moveFor({ id: 9, state: 'todo', position: 1 }, 'review', [1, 9, 2], pos, [1, 2])).toEqual({ state: 'review', position: 1.5 })
  })
  test('drop at the end of a column', () => {
    expect(moveFor({ id: 9, state: 'todo', position: 1 }, 'review', [1, 2, 3, 9], pos, [1, 2, 3])).toEqual({ state: 'review', position: 4 })
  })
  test('drop into an empty column', () => {
    expect(moveFor({ id: 9, state: 'todo', position: 1 }, 'done', [9], pos, [])).toEqual({ state: 'done', position: 1 })
  })
  test('reorder within a column sends only position', () => {
    expect(moveFor({ id: 3, state: 'todo', position: 3 }, 'todo', [3, 1, 2], pos, [1, 2, 3])).toEqual({ position: 0 })
  })
  test('no-op drop sends nothing', () => {
    expect(moveFor({ id: 2, state: 'todo', position: 2 }, 'todo', [1, 2, 3], pos, [1, 2, 3])).toBeNull()
  })
})

describe('tree', () => {
  test('captain → hires → their hires, human first, orphans become roots', () => {
    const list = [
      agent('james', 'maya', { created_at: 3 }), agent('maya', 'cap', { created_at: 2 }), agent('cap', null, { kind: 'human', created_at: 1 }),
      agent('omar', 'cap', { created_at: 4 }), agent('lost', 'gone', { created_at: 5 }),
    ]
    const flat = flattenTree(buildTree(list)).map((n) => `${'  '.repeat(n.depth)}${n.agent.id}`)
    expect(flat).toEqual(['cap', '  maya', '    james', '  omar', 'lost'])
  })
  test('cycles do not loop forever', () => {
    const flat = flattenTree(buildTree([agent('a', 'b'), agent('b', 'a')]))
    expect(flat.length).toBeLessThanOrEqual(2)
  })
})

describe('text', () => {
  test('mentions are split and filtered by known handles', () => {
    const segs = splitMentions('hi @james and @nobody, mail a@b.com', new Set(['james']))
    expect(segs.filter((s) => s.mention).map((s) => s.text)).toEqual(['@james'])
    expect(segs.map((s) => s.text).join('')).toBe('hi @james and @nobody, mail a@b.com')
  })
  test('mention at start of text', () => {
    expect(splitMentions('@maya ok')[0]).toEqual({ text: '@maya', mention: true })
  })
  test('thread titles', () => {
    expect(threadTitle('group', 'group')).toBe('Group')
    expect(threadTitle('dm @captain ↔ @james', 'dm:a:b')).toBe('@captain ↔ @james')
  })
  test('preview strips markdown', () => {
    expect(previewLine('## Title\n\n| a | b |\n|---|---|\n**Pick** `x` now')).toBe('Title Pick x now')
  })
  test('tmux attach command', () => {
    expect(tmuxAttach({ tmux_session: 'sparrow-plutus', tmux_window: 'james' })).toBe(String.raw`tmux attach -t sparrow-plutus \; select-window -t james`)
  })
  test('ago / duration', () => {
    expect(ago(1000, 1000 + 10_000)).toBe('now')
    expect(ago(0 + 1, 1 + 17 * 60_000)).toBe('17m')
    expect(ago(null)).toBe('—')
    expect(duration(65_000)).toBe('1m 05s')
    expect(duration(3_900_000)).toBe('1h 05m')
  })
})

describe('fix round 1', () => {
  test('system notice drops the embedded screen but keeps the trailing line', async () => {
    const { systemNoticeText } = await import('../src/lib/format')
    const screen = 'line 1\n  line 2\n\nline 4'
    const text = `@iris crashed (exit -1) and its automatic restart was already used.\nLast screen:\n${screen}\nSend @iris a message to resume it.`
    expect(systemNoticeText(text, screen)).toBe('@iris crashed (exit -1) and its automatic restart was already used.\nSend @iris a message to resume it.')
    expect(systemNoticeText(text, 'something else')).toBe('@iris crashed (exit -1) and its automatic restart was already used.\nSend @iris a message to resume it.')
    expect(systemNoticeText('plain notice', screen)).toBe('plain notice')
    expect(systemNoticeText(text, null)).toBe(text)
  })
  test('agoLabel / plural / middleTruncate / tmuxSwitch', async () => {
    const { agoLabel, plural, middleTruncate, tmuxSwitch } = await import('../src/lib/format')
    expect(agoLabel(1000, 2000)).toBe('now')
    expect(agoLabel(1, 1 + 5 * 60_000)).toBe('5m ago')
    expect(plural(1, 'agent')).toBe('1 agent')
    expect(plural(3, 'agent')).toBe('3 agents')
    const p = '/private/var/folders/yy/5vwj7c5x3jxcmzk7641zsnh00000gn/T/sparrow-t4-abc/ledger-demo'
    const t = middleTruncate(p, 40)
    expect(t.length).toBe(40)
    expect(t.endsWith('ledger-demo')).toBe(true)
    expect(middleTruncate('/short', 40)).toBe('/short')
    expect(tmuxSwitch({ tmux_session: 'sparrow-plutus', tmux_window: 'james' })).toBe('tmux switch-client -t sparrow-plutus:james')
  })
})
