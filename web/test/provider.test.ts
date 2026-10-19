import { describe, expect, test } from 'bun:test'
import type { ProviderHealth } from '../../src/shared/types'
import { providerSummary } from '../src/lib/catalog'
import { reduceGlobal, type GlobalData } from '../src/lib/reduce'

const ph = (over: Partial<ProviderHealth> = {}): ProviderHealth => ({
  harness: 'opencode', provider: 'opencode-go', degraded: true, errors: 3, last_error: 'This API key has expired.', last_error_at: 1, last_ok_at: null, degraded_since: 1, ...over,
})
const empty: GlobalData = { catalogs: [], doctorRun: null, providers: [], resumes: {} }

describe('provider health in the web store', () => {
  test('provider.updated replaces the provider list', () => {
    const next = reduceGlobal(empty, { type: 'provider.updated', project_id: '*', providers: [ph()] })
    expect(next.providers).toEqual([ph()])
    expect(reduceGlobal(next, { type: 'provider.updated', project_id: '*', providers: [] }).providers).toEqual([])
  })
  test('summary says degraded / not yet / recovered', () => {
    expect(providerSummary(ph())).toContain('opencode-go is degraded: 3 provider errors in a row, last: This API key has expired.')
    expect(providerSummary(ph({ degraded: false, errors: 1 }))).toContain('1 provider error in a row')
    expect(providerSummary(ph({ degraded: false, errors: 0 }))).toContain('recovered')
  })
})
