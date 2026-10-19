// Card face A ("Payoff + rails"): the pure decisions behind the face. Return x effort collapse into one plain-word
// payoff label; urgent / blocked become a left rail; people are initials; categories are a dot.
import type { Agent, Card, CardLevel } from '@shared/types'
import { formatEstimate } from '@shared/cards'
import { categoryIndex } from './boardStyle'
import { ago } from './format'

export type PayoffId = 'quick' | 'worth' | 'bet' | 'steady' | 'heavy' | 'filler' | 'lowvalue' | 'pit'
export type PayoffTone = 'good' | 'invest' | 'neutral' | 'costly' | 'dim'

/** `face`: shown on the board card. The other words (Steady, Filler, Low value) mean "nothing special" and only appear in the list and the peek. */
export interface Payoff { id: PayoffId; label: string; tone: PayoffTone; face: boolean }

const P: Record<PayoffId, Payoff> = {
  quick: { id: 'quick', label: 'Quick win', tone: 'good', face: true },
  worth: { id: 'worth', label: 'Worth it', tone: 'invest', face: true },
  bet: { id: 'bet', label: 'Big bet', tone: 'invest', face: true },
  steady: { id: 'steady', label: 'Steady', tone: 'neutral', face: false },
  heavy: { id: 'heavy', label: 'Heavy lift', tone: 'costly', face: true },
  filler: { id: 'filler', label: 'Filler', tone: 'dim', face: false },
  lowvalue: { id: 'lowvalue', label: 'Low value', tone: 'dim', face: false },
  pit: { id: 'pit', label: 'Money pit', tone: 'costly', face: true },
}

/** impact (rows) x effort (columns low, medium, high). */
const MATRIX: Record<CardLevel, [PayoffId, PayoffId, PayoffId]> = {
  high: ['quick', 'worth', 'bet'],
  medium: ['quick', 'steady', 'heavy'],
  low: ['filler', 'lowvalue', 'pit'],
}
const EFFORT_COL: Record<CardLevel, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 }

/** The payoff word for a card, or null while return or effort is unset. */
export function payoffOf(c: Pick<Card, 'impact' | 'effort'>): Payoff | null {
  if (!c.impact || !c.effort) return null
  return P[MATRIX[c.impact][EFFORT_COL[c.effort]]]
}

/** Only one of the two is set: a quiet half-answer ("High return", "Low effort"), never a verdict. */
export function partialOf(c: Pick<Card, 'impact' | 'effort'>): string | null {
  if (c.impact && !c.effort) return `${c.impact === 'medium' ? 'Medium' : c.impact === 'high' ? 'High' : 'Low'} return`
  if (c.effort && !c.impact) return `${c.effort === 'medium' ? 'Medium' : c.effort === 'high' ? 'High' : 'Low'} effort`
  return null
}

/** "Return high · Effort low · ~2h" (unset parts are left out). */
export function payoffTip(c: Pick<Card, 'impact' | 'effort' | 'estimate_min'>): string {
  const parts = [c.impact && `Return ${c.impact}`, c.effort && `Effort ${c.effort}`, c.estimate_min && `~${formatEstimate(c.estimate_min)}`]
  return parts.filter(Boolean).join(' · ')
}

export type Rail = 'urgent' | 'blocked' | 'both' | null

/** Done and dropped cards drop their flags. */
export function railOf(c: Pick<Card, 'urgent' | 'blocked_on' | 'state'>): Rail {
  if (c.state === 'done' || c.state === 'dropped') return null
  const u = !!c.urgent, b = !!c.blocked_on
  return u && b ? 'both' : u ? 'urgent' : b ? 'blocked' : null
}

/** Tooltip lines for the rail. */
export function railTip(c: Pick<Card, 'urgent' | 'blocked_on' | 'blocked_at' | 'state'>, now: number): string[] {
  const rail = railOf(c)
  const out: string[] = []
  if (rail === 'urgent' || rail === 'both') out.push('Urgent')
  if (rail === 'blocked' || rail === 'both') out.push(`Blocked on ${c.blocked_on}${c.blocked_at ? ` · ${ago(c.blocked_at, now)}` : ''}`)
  return out
}

/** The payoff in words for the peek: 'Return high · Effort low → Quick win'. Empty while nothing is set. */
export function payoffSentence(c: Pick<Card, 'impact' | 'effort'>): string {
  const parts = [c.impact && `Return ${c.impact}`, c.effort && `Effort ${c.effort}`].filter(Boolean).join(' · ')
  const p = payoffOf(c)
  return p ? `${parts} → ${p.label}` : parts
}

/** Two letters from the handle: 'james' → 'JA', 'ux-lead' → 'UL'. */
export function initials(handle: string): string {
  const parts = handle.split(/[^a-z0-9]+/i).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2)
  return s.toUpperCase()
}

/** Avatars are neutral (colour is reserved for what needs the user); the initials tell people apart. */
export const AVATAR_TONE = 'bg-zinc-100 text-zinc-600'

/** Solid dot colours in the same order as CATEGORY_PALETTE, so a category is the same hue on the face and in the sheet. */
export const CATEGORY_DOTS = [
  'bg-indigo-500', 'bg-cyan-500', 'bg-teal-500', 'bg-lime-500', 'bg-pink-500', 'bg-fuchsia-500', 'bg-yellow-500', 'bg-stone-500', 'bg-purple-500',
] as const

export function categoryDot(name: string): string {
  return CATEGORY_DOTS[categoryIndex(name)]
}

/** Avatar tooltip: '@james · working', '@you'. */
export function assigneeTip(a: Pick<Agent, 'handle' | 'kind' | 'state'>): string {
  return a.kind === 'human' ? `@${a.handle} (you)` : `@${a.handle} · ${a.state}`
}
