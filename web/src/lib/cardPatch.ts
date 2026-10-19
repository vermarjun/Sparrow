// Optimistic local application of a card PATCH (the server stays the source of truth: its response replaces this).
import type { Card, CardCheck, CardPatchReq } from '@shared/types'

const clean = (cs: (CardCheck | string)[]): CardCheck[] =>
  cs.map((c) => (typeof c === 'string' ? { text: c.trim(), done: false } : { text: c.text.trim(), done: !!c.done })).filter((c) => c.text)

export function applyPatch(card: Card, p: CardPatchReq, now = Date.now()): Card {
  const next: Card = { ...card, updated_at: now }
  if (p.state && p.state !== card.state) {
    next.state = p.state
    next.history = [...(card.history ?? []), { at: now, by: 'user', from: card.state, to: p.state }]
    if (p.state === 'in_progress' || p.state === 'review' || p.state === 'done') next.later_at = null
    if (p.state === 'done' || p.state === 'dropped') { next.blocked_on = null; next.blocked_at = null }
  }
  if (typeof p.position === 'number') next.position = p.position
  if (typeof p.title === 'string' && p.title.trim()) next.title = p.title.trim()
  for (const k of ['details', 'context', 'problem', 'approach'] as const) if (typeof p[k] === 'string') next[k] = p[k]
  if (p.category !== undefined) next.category = p.category ? p.category.trim().toLowerCase() : null
  if (p.checks) next.checks = clean(p.checks)
  if (p.check) next.checks = (card.checks ?? []).map((c, i) => (i === p.check!.index ? { ...c, done: p.check!.done } : c))
  if (p.tags) next.tags = [...new Set(p.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
  if (typeof p.urgent === 'boolean') next.urgent = p.urgent
  if (p.impact !== undefined) next.impact = p.impact
  if (p.effort !== undefined) next.effort = p.effort
  if (p.estimate_min !== undefined) next.estimate_min = p.estimate_min
  if (p.blocked_on !== undefined) {
    const on = p.blocked_on?.trim() || null
    next.blocked_on = on
    next.blocked_at = on ? (card.blocked_on ? card.blocked_at : now) : null
  }
  if (typeof p.later === 'boolean') next.later_at = p.later ? (card.later_at ?? now) : null
  if (p.note) next.notes = [...(card.notes ?? []), { at: now, by: 'user', text: p.note, kind: 'comment' }]
  return next
}
