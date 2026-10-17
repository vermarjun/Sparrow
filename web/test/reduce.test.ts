import { describe, expect, test } from 'bun:test'
import type { Agent, Card, MessageView } from '../../src/shared/types'
import { emptyData, reduce, type Data } from '../src/lib/reduce'

const msg = (seq: number, thread = 'dm:ag_a:ag_b', extra: Partial<MessageView> = {}): MessageView => ({
  seq, id: `msg_${seq}`, project_id: 'p', thread, from_id: 'ag_a', kind: 'chat', text: `m${seq}`, mentions: [], card_id: null, meta: {},
  created_at: seq * 1000, from_handle: 'a', thread_label: 'dm @a ↔ @b', to_handles: [], ...extra,
})

describe('reduce', () => {
  test('message.created appends to a loaded thread, dedupes, bumps the thread row', () => {
    const thread = 'dm:ag_a:ag_b'
    let d: Data = { ...emptyData('p'), messages: { [thread]: [msg(1)] }, threads: [{ thread, label: 'dm @a ↔ @b', members: ['a', 'b'], last: msg(1), count: 1 }] }
    d = reduce(d, { type: 'message.created', project_id: 'p', message: msg(2, thread) })
    expect(d.messages[thread].map((m) => m.seq)).toEqual([1, 2])
    expect(d.threads[0].count).toBe(2)
    const same = reduce(d, { type: 'message.created', project_id: 'p', message: msg(2, thread) })
    expect(same).toBe(d)
  })
  test('a new DM thread sorts ahead of older DMs', () => {
    const older = 'dm:ag_c:ag_d'
    let d: Data = { ...emptyData('p'), threads: [{ thread: older, label: 'dm @c ↔ @d', members: ['c', 'd'], last: msg(1, older), count: 1 }] }
    d = reduce(d, { type: 'message.created', project_id: 'p', message: msg(5, 'dm:ag_a:ag_b') })
    expect(d.threads.map((t) => t.thread)).toEqual(['dm:ag_a:ag_b', older])
    expect(d.threads[0].members).toEqual(['a', 'b'])
    expect(d.messages['dm:ag_a:ag_b']).toBeUndefined() // not loaded → fetched on open
  })
  test('events from other projects are ignored', () => {
    const d = emptyData('p')
    expect(reduce(d, { type: 'card.updated', project_id: 'q', card: { id: 1 } as Card })).toBe(d)
  })
  test('agent.updated and card.updated upsert', () => {
    let d = emptyData('p')
    d = reduce(d, { type: 'agent.updated', project_id: 'p', agent: { id: 'ag_x', state: 'working' } as Agent })
    d = reduce(d, { type: 'card.updated', project_id: 'p', card: { id: 4, state: 'review' } as Card })
    expect(d.agents.ag_x.state).toBe('working')
    expect(d.cards[4].state).toBe('review')
  })
  test('call events record the last call for sheet refresh', () => {
    const d = reduce(emptyData('p'), { type: 'call.started', project_id: 'p', call: { id: 'call_1', agent_id: 'ag_x' } as never })
    expect(d.lastCall?.agent_id).toBe('ag_x')
  })
})
