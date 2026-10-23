import type { Card } from '../../src/shared/types'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/** A v2 card with every marker empty; override what the test cares about. */
export function mkCard(id: number, extra: Partial<Card> = {}): Card {
  return {
    id, project_id: 'tortuga', title: `Card ${id}`, details: '', category: null, state: 'todo', position: id, assignee_id: null,
    created_by: 'ag_cap', notes: [], created_at: 1_000_000, updated_at: 1_000_000,
    context: '', problem: '', approach: '', checks: [], tags: [], urgent: false, impact: null, effort: null, estimate_min: null,
    blocked_on: null, blocked_at: null, later_at: null, history: [], ...extra,
  }
}
