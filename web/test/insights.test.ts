import { describe, expect, test } from 'bun:test'
import { summarizeInsights } from '../src/lib/insights'
import { DAY, HOUR, mkCard } from './cardFixtures'

const NOW = 1_760_000_000_000
const doneCard = (id: number, options: { doneDaysAgo: number; buildMin: number; reviewMin?: number; estimateMin: number; createdDaysAgo?: number }) => {
  const created = NOW - (options.createdDaysAgo ?? options.doneDaysAgo + 2) * DAY
  const doneAt = NOW - options.doneDaysAgo * DAY
  const started = doneAt - (options.buildMin + (options.reviewMin ?? 0)) * 60_000
  const enteredReview = doneAt - (options.reviewMin ?? 0) * 60_000
  return mkCard(id, {
    state: 'done', created_at: created, updated_at: doneAt, estimate_min: options.estimateMin,
    history: [
      { at: created, by: 'user', from: null, to: 'proposed' },
      { at: started, by: 'user', from: 'proposed', to: 'in_progress' },
      { at: enteredReview, by: 'user', from: 'in_progress', to: 'review' },
      { at: doneAt, by: 'user', from: 'review', to: 'done' },
    ],
  })
}

describe('summarizeInsights', () => {
  test('counts recent completions and calculates medians over cards with timing data', () => {
    const cards = [
      doneCard(1, { doneDaysAgo: 1, buildMin: 30, reviewMin: 300, estimateMin: 60 }),
      doneCard(2, { doneDaysAgo: 3, buildMin: 90, reviewMin: 90, estimateMin: 60 }),
      doneCard(3, { doneDaysAgo: 8, buildMin: 120, estimateMin: 60 }),
      mkCard(4, { state: 'done', estimate_min: null }), // legacy: completed, no active timing or ratio
      mkCard(5, { state: 'in_progress', estimate_min: 60 }),
    ]
    const summary = summarizeInsights(cards, NOW)
    expect(summary.doneLast7Days).toBe(2)
    expect(summary.completedCount).toBe(4)
    expect(summary.medianBuildMs).toBe(90 * 60_000)
    expect(summary.medianEstimateRatio).toBe(1.5)
  })

  test('returns up to three largest over-estimate misses, with card keys and values', () => {
    const cards = [
      doneCard(1, { doneDaysAgo: 1, buildMin: 300, reviewMin: 2880, estimateMin: 60 }),
      doneCard(2, { doneDaysAgo: 2, buildMin: 240, reviewMin: 180, estimateMin: 60 }),
      doneCard(3, { doneDaysAgo: 3, buildMin: 180, estimateMin: 60 }),
      doneCard(4, { doneDaysAgo: 4, buildMin: 90, estimateMin: 60 }),
      doneCard(5, { doneDaysAgo: 5, buildMin: 30, estimateMin: 60 }), // under estimate, not a miss
    ]
    expect(summarizeInsights(cards, NOW).worstMisses.map(({ id, ratio }) => [id, ratio])).toEqual([[1, 5], [2, 4], [3, 3]])
    expect(summarizeInsights(cards, NOW).worstMisses[0]).toMatchObject({ key: 'PLU-1', title: 'Card 1', estimateMin: 60, buildMs: 300 * 60_000, reviewMs: 2880 * 60_000, ratio: 5 })
  })

  test('empty or untimed boards render no medians or misses', () => {
    expect(summarizeInsights([], NOW)).toEqual({ doneLast7Days: 0, completedCount: 0, medianBuildMs: null, medianEstimateRatio: null, worstMisses: [] })
    const activeOnly = mkCard(1, { state: 'in_progress', created_at: NOW - HOUR })
    expect(summarizeInsights([activeOnly], NOW).medianBuildMs).toBeNull()
  })
})
