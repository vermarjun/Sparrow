// Text the board hands out: who is who, what "Copy for agent" and "Copy pick command" put on the clipboard.
import type { Agent, Card } from '@shared/types'
import { cardBrief, cardKey } from '@shared/cards'
import { previewLine } from './format'

/** Display name for an agent id / note author: '@maya', 'you', 'system'. */
export function whoName(agents: Record<string, Agent>) {
  return (id: string): string => (id === 'user' ? 'you' : id === 'system' ? 'system' : agents[id] ? `@${agents[id].handle}` : id)
}

export const briefFor = (card: Card, agents: Record<string, Agent>) => cardBrief(card, whoName(agents))

export const pickCommand = (card: Pick<Card, 'id' | 'project_id'>) =>
  `Pick up ${cardKey(card)} from the Sparrow board: run sparrow card pick ${cardKey(card)}`

/** One check per non-empty line; leading list markers / checkbox syntax are stripped. */
export function parseCheckLines(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\])?\s*/, '').trim()).filter(Boolean)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch { return false }
  }
}

/** First useful line for the detailed card face: problem, else context, else the legacy details. */
export function previewOf(c: Pick<Card, 'problem' | 'context' | 'details'>): string {
  return previewLine(c.problem?.trim() || c.context?.trim() || c.details?.trim() || '')
}
