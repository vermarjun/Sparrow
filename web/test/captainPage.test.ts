import { describe, expect, test } from 'bun:test'
import type { Agent, Card, MessageView } from '../../src/shared/types'
import {
  agentAttach, agentResumeCommand, agentThread, captainStats, endReasonTone, fleetCards, modelLine, openCallStart, originLabel,
  resumeTail, routeLabel, seenLabel, senderKind, shellQuote, tightWithPrev, waitingQuestions,
} from '../src/lib/captainPage'

let seq = 0
const msg = (kind: MessageView['kind'], thread: string, extra: Partial<MessageView> = {}): MessageView => ({
  seq: ++seq, id: `m${seq}`, project_id: 'p', thread, from_id: 'ag_a', kind, text: `${kind} ${seq}`, mentions: [], card_id: null, meta: {},
  created_at: 0, from_handle: 'a', thread_label: '', to_handles: [], ...extra,
})
const card = (id: number, state: Card['state'], extra: Partial<Card> = {}) => ({ id, state, assignee_id: null, created_by: 'user', updated_at: id, ...extra }) as Card
const A = (extra: Partial<Agent>) => ({ harness: 'claude', cwd: '/Users/me/plutus feat', session_id: 'abc-123', tmux_session: 's', tmux_window: 'w', tmux_window_id: null, ...extra }) as Agent

describe('captainStats', () => {
  const base = { fleet: { total: 6, working: 1, queued: 1, waiting: 1, crashed: 1, idle: 1, retired: 1 }, results: { ok: 2, blocked: 0, failed: 0 }, unread: 0 }
  test('agents · working (queued included) · done · failed · unread', () => {
    const s = captainStats(base)
    expect(s.map((x) => [x.key, x.value])).toEqual([['agents', 6], ['working', 2], ['done', 2], ['failed', 0], ['unread', 0]])
    expect(s.every((x) => x.tone === 'default' && !x.note)).toBe(true)
  })
  test('unread > 0 is amber with the note; failed > 0 is red; blocked appears only when present', () => {
    const s = captainStats({ ...base, results: { ok: 1, blocked: 1, failed: 2 }, unread: 3 })
    expect(s.find((x) => x.key === 'unread')).toMatchObject({ value: 3, tone: 'warn', note: "the captain hasn't read these yet" })
    expect(s.find((x) => x.key === 'failed')?.tone).toBe('bad')
    expect(s.find((x) => x.key === 'blocked')).toMatchObject({ value: 1, tone: 'warn' })
  })
})

describe('meta labels', () => {
  const ag = (last_seen_at: number | null) => ({ last_seen_at }) as Agent
  test('online beats seen; seen uses a relative time; never seen', () => {
    expect(seenLabel({ online: true, agent: ag(1) })).toEqual({ online: true, text: 'online' })
    expect(seenLabel({ online: false, agent: ag(1_000_000 - 120_000) }, 1_000_000)).toEqual({ online: false, text: 'seen 2m ago' })
    expect(seenLabel({ online: false, agent: ag(null) }).text).toBe('never seen')
  })
  test('origin', () => {
    expect(originLabel('terminal')).toBe('started in a terminal')
    expect(originLabel('sparrow')).toBe('launched by Sparrow')
  })
})

describe('resume lines', () => {
  test('per harness, cwd quoted, none without a session', () => {
    expect(agentResumeCommand(A({}))).toBe(`cd '/Users/me/plutus feat' && claude --resume abc-123`)
    expect(agentResumeCommand(A({ harness: 'codex' }))).toBe(`cd '/Users/me/plutus feat' && codex resume abc-123`)
    expect(agentResumeCommand(A({ harness: 'opencode' }))).toBe(`cd '/Users/me/plutus feat' && opencode -s abc-123`)
    expect(agentResumeCommand(A({ session_id: null }))).toBeNull()
    expect(agentResumeCommand(A({ harness: 'fake' }))).toBeNull()
  })
  test('shellQuote escapes single quotes', () => expect(shellQuote("it's")).toBe(`'it'\\''s'`))
  test('attach only while a window is open', () => {
    expect(agentAttach(A({}))).toBeNull()
    expect(agentAttach(A({ tmux_window_id: '@3' }))).toBe(String.raw`tmux attach -t s \; select-window -t w`)
  })
})

describe('activity helpers', () => {
  test('a question waits only while it is the newest message of its thread', () => {
    const q1 = msg('question', 'dm:a:b'), q2 = msg('question', 'dm:a:c'), answer = msg('chat', 'dm:a:b'), upd = msg('update', 'dm:a:c')
    expect([...waitingQuestions([q1, q2, answer])]).toEqual([q2.seq])
    expect(waitingQuestions([q1, q2, answer, upd]).size).toBe(0) // an update after the question also moves on
  })
  test('route label drops the sender from the recipients; system has no @', () => {
    expect(routeLabel({ from_handle: 'james', to_handles: ['maya', 'james'], kind: 'chat' })).toEqual({ from: '@james', to: ['@maya'] })
    expect(routeLabel({ from_handle: 'system', to_handles: [], kind: 'system' })).toEqual({ from: 'system', to: [] })
  })
  test('updates directly after updates are tight', () => {
    const l = [msg('chat', 't'), msg('update', 't'), msg('update', 't'), msg('chat', 't'), msg('update', 't')]
    expect(l.map((_, i) => tightWithPrev(l, i))).toEqual([false, false, true, false, false])
  })
  test('agentThread: the thread with its parent only; a root sees every thread it is in; oldest first', () => {
    const l = [msg('task', 'dm:ag_cap:ag_maya'), msg('task', 'dm:ag_james:ag_maya'), msg('chat', 'dm:ag_james:ag_maya'), msg('task', 'dm:ag_iris:ag_maya')]
    expect(agentThread(l, { id: 'ag_james', parent_id: 'ag_maya' }).map((m) => m.seq)).toEqual([l[1].seq, l[2].seq])
    expect(agentThread(l, { id: 'ag_maya', parent_id: 'ag_cap' }).map((m) => m.seq)).toEqual([l[0].seq])
    expect(agentThread(l, { id: 'ag_maya', parent_id: null }).length).toBe(4)
  })
  test('sender kind', () => {
    expect(senderKind({ from_id: 'ag_cap', from_handle: 'captain' }, 'ag_cap')).toBe('captain')
    expect(senderKind({ from_id: 'system', from_handle: 'system' }, 'ag_cap')).toBe('system')
    expect(senderKind({ from_id: 'ag_x', from_handle: 'x' }, 'ag_cap')).toBe('agent')
  })
})

describe('calls, cards, model', () => {
  test('open call = newest call without an end', () => {
    expect(openCallStart([{ started_at: 5, ended_at: 9 }, { started_at: 7, ended_at: null }, { started_at: 6, ended_at: null }])).toBe(7)
    expect(openCallStart([{ started_at: 5, ended_at: 9 }])).toBeNull()
  })
  test('end reason tone', () => {
    expect(endReasonTone('done')).toBe('ok')
    expect(endReasonTone('crashed')).toBe('bad')
    expect(endReasonTone('ask')).toBe('warn')
    expect(endReasonTone('wait')).toBe('muted')
    expect(endReasonTone(null)).toBe('muted')
  })
  test('fleet cards: assigned or proposed by a member, live states first', () => {
    const ids = new Set(['ag_a', 'ag_b'])
    const l = [card(1, 'done', { assignee_id: 'ag_a' }), card(2, 'in_progress', { assignee_id: 'ag_b' }), card(3, 'todo', { assignee_id: 'ag_z' }), card(4, 'todo', { created_by: 'ag_a' }), card(5, 'review', { assignee_id: 'ag_a' })]
    expect(fleetCards(l, ids).map((c) => c.id)).toEqual([2, 5, 4, 1])
  })
  test('model line omits empties', () => {
    expect(modelLine({ harness: 'claude', model: null, effort: 'high' })).toBe('claude · high')
    expect(modelLine({ harness: 'codex', model: 'gpt-6', effort: 'high' })).toBe('codex · gpt-6 · high')
  })
})

describe('resumeTail', () => {
  test('drops the cd prefix (quoted, escaped quote, or bare path)', () => {
    expect(resumeTail(`cd '/Users/me/plutus feat' && claude --resume abc-123`)).toBe('claude --resume abc-123')
    expect(resumeTail(`cd '/x/it'\\''s' && codex resume abc`)).toBe('codex resume abc')
    expect(resumeTail('cd /x/y && opencode -s ses_1')).toBe('opencode -s ses_1')
    expect(resumeTail('claude --resume abc')).toBe('claude --resume abc')
  })
})
