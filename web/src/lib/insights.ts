// Board-wide completion metrics derived from the shared timing model.
import type { Card } from '@shared/types'
import { cardKey, cardTimings } from '@shared/cards'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface WorstMiss {
  id: number
  key: string
  title: string
  estimateMin: number
  buildMs: number
  reviewMs: number
  ratio: number
}

export interface InsightsSummary {
  doneLast7Days: number
  completedCount: number
  medianBuildMs: number | null
  medianEstimateRatio: number | null
  worstMisses: WorstMiss[]
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** `doneLast7Days` is recent; medians and misses use all completed cards with usable timing data. */
export function summarizeInsights(cards: Card[], now = Date.now()): InsightsSummary {
  const completed = cards.filter((card) => card.state === 'done').map((card) => ({ card, timing: cardTimings(card, now) }))
  const builds = completed.filter(({ timing }) => timing.build_ms > 0)
  const ratios = completed.filter(({ timing }) => timing.ratio != null)
  const misses = ratios
    .filter(({ timing }) => timing.ratio! > 1)
    .sort((a, b) => b.timing.ratio! - a.timing.ratio! || b.card.id - a.card.id)
    .slice(0, 3)
    .map(({ card, timing }) => ({
      id: card.id,
      key: cardKey(card),
      title: card.title,
      estimateMin: card.estimate_min!,
      buildMs: timing.build_ms,
      reviewMs: timing.review_ms,
      ratio: timing.ratio!,
    }))
  const cutoff = now - WEEK_MS
  return {
    doneLast7Days: completed.filter(({ card, timing }) => {
      // Older cards have no transition history; their updated date is the best available completion date.
      const doneAt = card.history?.length ? (timing.done_at ?? card.updated_at) : card.updated_at
      return doneAt >= cutoff && doneAt <= now
    }).length,
    completedCount: completed.length,
    medianBuildMs: median(builds.map(({ timing }) => timing.build_ms)),
    medianEstimateRatio: median(ratios.map(({ timing }) => timing.ratio!)),
    worstMisses: misses,
  }
}
