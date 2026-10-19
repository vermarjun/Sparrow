import { describe, expect, test } from 'bun:test'
import type { ResumeView } from '@shared/types'
import { blank, fromView } from '../src/lib/resumeForm'

const view = (over: Partial<ResumeView> = {}): ResumeView => ({
  slug: 't', title: 'T', description: 'd', harness: 'claude', model: null, effort: null, can_hire: ['x'],
  limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: 'b\n', path: '/p/t.md', skills: ['alpha', 'beta'],
  hash: 'h', builtin: false, status: 'ok', status_detail: null, resolved_model: null, stale_agents: [], ...over,
})

describe('resume editor form', () => {
  test('fromView carries skills (a save would otherwise wipe the resume\'s grants)', () => {
    const f = fromView(view())
    expect(f.skills).toEqual(['alpha', 'beta'])
    const { slug: _s, ...putBody } = { ...f, title: 'Renamed' } // what save() sends
    expect(putBody.skills).toEqual(['alpha', 'beta'])
    expect(f.skills).not.toBe(view().skills) // copied, not shared
  })
  test('a view without skills (older server) gives [], blank() starts empty', () => {
    expect(fromView(view({ skills: undefined })).skills).toEqual([])
    expect(blank().skills).toEqual([])
  })
})
