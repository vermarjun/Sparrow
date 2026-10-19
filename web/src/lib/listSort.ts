// Stable sorting for the board's dense planning list.
import type { Card, CardState } from '@shared/types'
import { cardKey, roiScore, sortCardsBy } from '@shared/cards'
import type { ListKey } from './boardPrefs'
import { payoffOf } from './faceA'

export type ListDirection = 'asc' | 'desc'
export type AssigneeLabel = (id: string | null) => string | null

const STATE_ORDER: CardState[] = ['proposed', 'todo', 'in_progress', 'review', 'done', 'dropped']
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const compareNullable = <T>(a: T | null | undefined, b: T | null | undefined, compare: (x: T, y: T) => number): number => {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return compare(a, b)
}

/** Sort a copy of the filtered list. Empty values stay last in both directions; ties keep manual board order. */
export function sortListCards(cards: Card[], key: ListKey, direction: ListDirection, assigneeLabel: AssigneeLabel = (id) => id): Card[] {
  const manual = sortCardsBy(cards, 'manual')
  const sign = direction === 'asc' ? 1 : -1
  const stateRank = (state: CardState) => STATE_ORDER.indexOf(state)
  const compare = (a: Card, b: Card): number => {
    switch (key) {
      case 'state': return stateRank(a.state) - stateRank(b.state)
      case 'key': return a.id - b.id
      case 'title': return collator.compare(a.title, b.title)
      case 'category': return compareNullable(a.category?.toLowerCase(), b.category?.toLowerCase(), collator.compare)
      // The payoff word ranks by return per effort; a card with return or effort unset has no payoff yet.
      case 'payoff': return compareNullable(payoffOf(a) && roiScore(a), payoffOf(b) && roiScore(b), (x, y) => x - y)
      case 'estimate': return compareNullable(a.estimate_min, b.estimate_min, (x, y) => x - y)
      // Smaller age means newer. Updated dates use their natural oldest-to-newest order.
      case 'age': return b.created_at - a.created_at
      case 'assignee': return compareNullable(assigneeLabel(a.assignee_id), assigneeLabel(b.assignee_id), collator.compare)
      case 'updated': return a.updated_at - b.updated_at
    }
  }
  const hasMissingSortValue = (card: Card) => {
    if (key === 'category') return !card.category
    if (key === 'payoff') return !payoffOf(card)
    if (key === 'estimate') return card.estimate_min == null
    if (key === 'assignee') return !assigneeLabel(card.assignee_id)
    return false
  }
  return manual.sort((a, b) => {
    const raw = compare(a, b)
    const directional = hasMissingSortValue(a) || hasMissingSortValue(b) ? raw : sign * raw
    return directional || a.position - b.position || a.id - b.id
  })
}

export const listSortLabel = (key: ListKey) => ({
  state: 'State', key: 'Key', title: 'Title', category: 'Category', payoff: 'Payoff',
  estimate: 'Est.', age: 'Age', assignee: 'Assignee', updated: 'Updated',
}[key])

export const listKeyFor = (card: Pick<Card, 'id' | 'project_id'>) => cardKey(card)
