// What the ticket sheet's Timing panel shows, derived from cardTimings (unit-tested).
import type { Card, CardState } from '@shared/types'
import { cardTimings, formatEstimate, formatSpan } from '@shared/cards'

export type Tone = 'ok' | 'warn' | 'bad' | 'none'

/** green ≤ 1.1x, amber ≤ 1.5x, red above; no ratio = none. */
export function ratioTone(ratio: number | null): Tone {
  if (ratio == null) return 'none'
  return ratio <= 1.1 ? 'ok' : ratio <= 1.5 ? 'warn' : 'bad'
}

/** `1.3× over`, `0.8× under`, `on estimate`. */
export function ratioWord(ratio: number): string {
  const r = Math.round(ratio * 10) / 10
  if (ratio > 1.05) return `${r.toFixed(1)}× over`
  if (ratio < 0.95) return `${r.toFixed(1)}× under`
  return 'on estimate'
}

export interface Milestone { key: 'proposed' | 'accepted' | 'started' | 'review' | 'done'; label: string; at: number | null; by: string | null }
export interface Segment { state: CardState; ms: number; pct: number; label: string }
export interface TimingView {
  milestones: Milestone[]
  segments: Segment[]
  /** `Estimate 2h · Build 2h 10m (1.1× over) · Review 25m`: the ratio compares the build time only (review is the user's latency). */
  estimate: string
  build: string
  review: string
  /** Build + review, wall clock. */
  active: string
  verdict: string
  tone: Tone
  reopened: number
}

/** `Proposed` for tickets an agent suggested, `Created` for ones the user made directly in To do. */
export function originLabel(card: Pick<Card, 'history' | 'created_by'>): 'Proposed' | 'Created' {
  const born = (card.history ?? []).find((h) => h.from === null)
  return (born ? born.to === 'proposed' : card.created_by !== 'user') ? 'Proposed' : 'Created'
}

const BAR_STATES: CardState[] = ['proposed', 'todo', 'in_progress', 'review']
export const SEGMENT_LABEL: Record<CardState, string> = {
  proposed: 'Proposed', todo: 'To do', in_progress: 'Build', review: 'Review', done: 'Done', dropped: 'Dropped',
}

export function timingView(card: Card, now = Date.now()): TimingView {
  const t = cardTimings(card, now)
  const hist = [...(card.history ?? [])].sort((a, b) => a.at - b.at)
  const accepted = hist.find((h) => h.to === 'todo' && h.from === 'proposed')
  const first = hist[0]
  const born = first && first.from === null ? first : null
  const milestones: Milestone[] = [
    { key: 'proposed', label: originLabel(card), at: card.created_at, by: born?.by || card.created_by },
    { key: 'accepted', label: 'Accepted', at: accepted?.at ?? null, by: accepted?.by ?? null },
    { key: 'started', label: 'Started', at: t.started_at, by: hist.find((h) => h.at === t.started_at && h.to === 'in_progress')?.by ?? null },
    { key: 'review', label: 'In review', at: t.review_at, by: null },
    { key: 'done', label: 'Done', at: t.done_at, by: null },
  ]
  const parts = BAR_STATES.map((s) => ({ state: s, ms: t.in_state[s] })).filter((p) => p.ms > 0)
  const sum = parts.reduce((a, p) => a + p.ms, 0)
  const segments: Segment[] = parts.map((p) => ({ state: p.state, ms: p.ms, pct: sum ? (p.ms / sum) * 100 : 0, label: `${SEGMENT_LABEL[p.state]} ${formatSpan(p.ms)}` }))
  const tone = ratioTone(t.ratio)
  return {
    milestones, segments, tone, reopened: t.reopened,
    estimate: card.estimate_min ? formatEstimate(card.estimate_min) : 'no estimate',
    build: t.build_ms > 0 ? formatSpan(t.build_ms) : card.state === 'done' ? '0m' : 'not started',
    review: t.review_ms > 0 ? formatSpan(t.review_ms) : '—',
    active: t.active_ms > 0 ? formatSpan(t.active_ms) : card.state === 'done' ? '0m' : 'not started',
    verdict: t.ratio != null ? ratioWord(t.ratio) : '',
  }
}
