import { describe, expect, test } from 'bun:test'
import type { Agent, MessageView } from '../../src/shared/types'
import { jobResult, resultLine } from '../src/lib/format'
import { emptyData, reduce, type Data } from '../src/lib/reduce'

const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'ag_1', project_id: 'p', handle: 'leo', kind: 'agent', resume: 'builder', title: 'Builder', harness: 'claude', model: null, effort: null,
  can_hire: [], parent_id: 'ag_0', depth: 1, cwd: '/x', tmux_session: 's', tmux_window: 'leo', tmux_window_id: null, session_id: null,
  state: 'idle', call_id: null, last_end_reason: 'done', last_update: 'The evidence report is drafted. One last CLI check…', last_update_at: 1000,
  last_seen_at: null, resume_hash: null, last_run: null, fleet_id: 'ag_0', captain: null, created_at: 0, updated_at: 0, ...extra,
})
const RESULT = '## Result\nAdded the Skills install command and its tests.\n## Evidence\nbun test → 42 pass'

describe('resultLine / jobResult (D5)', () => {
  test('first meaningful line, skipping a bare "## Result" heading and markdown markers', () => {
    expect(resultLine(RESULT)).toBe('Added the Skills install command and its tests.')
    expect(resultLine('**Done:** shipped `x`')).toBe('Done: shipped x')
    expect(resultLine('')).toBe('')
  })
  test('only an idle agent whose last call ended done has a job result', () => {
    const last_result = { status: 'ok' as const, text: RESULT, at: 5000 }
    expect(jobResult(agent({ last_result }))).toEqual({ status: 'ok', line: 'Added the Skills install command and its tests.', at: 5000 })
    expect(jobResult(agent({ last_result, state: 'working' }))).toBeNull()
    expect(jobResult(agent({ last_result, last_end_reason: 'unreported' }))).toBeNull()
    expect(jobResult(agent({ last_result, last_end_reason: 'ask', state: 'waiting' }))).toBeNull()
    expect(jobResult(agent())).toBeNull()
  })
})

describe('web store keeps last_result fresh', () => {
  const msg = (status: string): MessageView => ({
    seq: 9, id: 'm9', project_id: 'p', thread: 'dm:ag_0:ag_1', from_id: 'ag_1', kind: 'result', text: RESULT, mentions: [], card_id: null,
    meta: { status }, created_at: 7000, from_handle: 'leo', thread_label: 'dm @captain ↔ @leo', to_handles: ['captain'],
  })
  test('a result message sets the sender\'s last_result; later agent.updated events (bare rows) keep it', () => {
    let d: Data = { ...emptyData('p'), agents: { ag_1: agent({ last_end_reason: null, state: 'working' }) } }
    d = reduce(d, { type: 'message.created', project_id: 'p', message: msg('failed') })
    expect(d.agents.ag_1.last_result).toEqual({ status: 'failed', text: RESULT, at: 7000 })
    d = reduce(d, { type: 'agent.updated', project_id: 'p', agent: agent({ state: 'idle', last_end_reason: 'done' }) })
    expect(d.agents.ag_1.last_result?.status).toBe('failed')
    expect(jobResult(d.agents.ag_1)?.status).toBe('failed')
  })
})
