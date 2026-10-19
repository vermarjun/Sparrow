// Pure rules behind the ticket sheet's inline editors and footer (unit-tested in web/test/sheetLogic.test.ts).
import type { Card, CardCheck, CardNote, CardPatchReq, CardState } from '@shared/types'
import { parseEstimate, STATE_LABEL } from '@shared/cards'
import { noteKind } from '@/lib/activity'

// ---------------------------------------------------------------- estimate field

export type EstimateInput = { ok: true; min: number | null } | { ok: false; error: string }

/** '' → clear; '2h' / '90m' / '1d' / '1h 30m' → minutes; anything else → an actionable error. */
export function parseEstimateInput(text: string): EstimateInput {
  if (!text.trim()) return { ok: true, min: null }
  const min = parseEstimate(text)
  return min == null ? { ok: false, error: 'Try 90m, 2h or 1d' } : { ok: true, min }
}

// ---------------------------------------------------------------- tags

export const MAX_TAGS = 12
export const MAX_TAG_LEN = 32

/** Add what was typed or pasted (comma / newline separated): lowercased, trimmed, deduped, capped like the server. */
export function addTags(tags: string[], raw: string): string[] {
  const out = [...tags]
  for (const piece of raw.split(/[,\n]/)) {
    const t = piece.trim().toLowerCase().slice(0, MAX_TAG_LEN)
    if (t && !out.includes(t) && out.length < MAX_TAGS) out.push(t)
  }
  return out
}

export const removeTag = (tags: string[], tag: string) => tags.filter((t) => t !== tag)

// ---------------------------------------------------------------- category combobox

export interface CategoryOption { name: string; count: number }

/** Categories already used in the project (plus any `known` names the page passes), most used first, filtered by what is typed. */
export function categoryOptions(cards: Pick<Card, 'category' | 'project_id'>[], projectId: string, query: string, known: string[] = []): CategoryOption[] {
  const counts = new Map<string, number>()
  for (const c of cards) if (c.project_id === projectId && c.category) counts.set(c.category, (counts.get(c.category) ?? 0) + 1)
  for (const k of known) if (k && !counts.has(k)) counts.set(k, 0)
  const q = query.trim().toLowerCase()
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .filter((o) => !q || o.name.includes(q))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** The typed text as a new category, when it is not already one of the options. */
export function newCategory(options: CategoryOption[], query: string): string | null {
  const q = query.trim().toLowerCase()
  return q && !options.some((o) => o.name === q) ? q : null
}

// ---------------------------------------------------------------- done-when checklist

export function moveCheck(checks: CardCheck[], from: number, to: number): CardCheck[] {
  if (from === to || from < 0 || to < 0 || from >= checks.length || to >= checks.length) return checks
  const next = [...checks]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** Replace one item's text; a blank text removes it (the server drops blank checks anyway). */
export function editCheck(checks: CardCheck[], index: number, text: string): CardCheck[] {
  const t = text.trim()
  if (!t) return checks.filter((_, i) => i !== index)
  return checks.map((c, i) => (i === index ? { ...c, text: t } : c))
}

export const removeCheck = (checks: CardCheck[], index: number) => checks.filter((_, i) => i !== index)

export function appendCheck(checks: CardCheck[], text: string): CardCheck[] {
  const t = text.trim()
  return t ? [...checks, { text: t, done: false }] : checks
}

export function checkProgress(checks: CardCheck[] | undefined): { done: number; total: number; pct: number } {
  const total = checks?.length ?? 0
  const done = (checks ?? []).filter((c) => c.done).length
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
}

// ---------------------------------------------------------------- footer: the next move per state

export type ActionTone = 'primary' | 'approve' | 'quiet' | 'danger'
export interface SheetAction { id: string; label: string; tone: ActionTone; patch: CardPatchReq; icon: 'accept' | 'later' | 'drop' | 'start' | 'review' | 'approve' | 'back' | 'reopen' | 'restore' }

/** Contextual next actions, primary first. Proposed: Accept / Later / Drop; Review: Approve and Send back; ... */
export function nextActions(card: Pick<Card, 'state' | 'later_at'>): SheetAction[] {
  const shelved = !!card.later_at
  const later: SheetAction = shelved
    ? { id: 'unlater', label: 'Bring back', tone: 'quiet', patch: { later: false }, icon: 'later' }
    : { id: 'later', label: 'Later', tone: 'quiet', patch: { later: true }, icon: 'later' }
  const move = (to: CardState): CardPatchReq => ({ state: to })
  switch (card.state) {
    case 'proposed':
      return [
        { id: 'accept', label: 'Accept', tone: 'primary', patch: move('todo'), icon: 'accept' },
        later,
        { id: 'drop', label: 'Drop', tone: 'danger', patch: move('dropped'), icon: 'drop' },
      ]
    case 'todo':
      return [{ id: 'start', label: 'Start', tone: 'primary', patch: move('in_progress'), icon: 'start' }, later]
    case 'in_progress':
      return [{ id: 'review', label: 'Send to review', tone: 'primary', patch: move('review'), icon: 'review' }]
    case 'review':
      return [
        { id: 'approve', label: 'Approve', tone: 'approve', patch: move('done'), icon: 'approve' },
        { id: 'back', label: 'Send back', tone: 'quiet', patch: move('in_progress'), icon: 'back' },
      ]
    case 'done':
      return [{ id: 'reopen', label: 'Reopen', tone: 'quiet', patch: move('todo'), icon: 'reopen' }]
    case 'dropped':
      return [{ id: 'restore', label: 'Restore', tone: 'quiet', patch: move('proposed'), icon: 'restore' }]
  }
}

/** Where an action leads, for the button's small suffix ("→ To do"). */
export const actionTarget = (a: SheetAction): CardState | null => a.patch.state ?? null

// ---------------------------------------------------------------- activity: fold long runs of events

export type TimelineItem = { kind: 'note'; note: CardNote } | { kind: 'folded'; id: number; notes: CardNote[] }

/**
 * A run of more than `threshold` consecutive events keeps its last `keep` lines and folds the rest into one
 * "N earlier events" item (`id` = index of the first folded note, stable while the run grows at its end).
 */
export function foldEvents(notes: CardNote[], threshold = 5, keep = 2): TimelineItem[] {
  const out: TimelineItem[] = []
  let i = 0
  while (i < notes.length) {
    if (noteKind(notes[i]) === 'comment') { out.push({ kind: 'note', note: notes[i++] }); continue }
    let j = i
    while (j < notes.length && noteKind(notes[j]) === 'event') j++
    const run = notes.slice(i, j)
    if (run.length > threshold) {
      out.push({ kind: 'folded', id: i, notes: run.slice(0, run.length - keep) })
      for (const n of run.slice(run.length - keep)) out.push({ kind: 'note', note: n })
    } else for (const n of run) out.push({ kind: 'note', note: n })
    i = j
  }
  return out
}

// ---------------------------------------------------------------- small text helpers

/** `moved todo → in_progress` reads better as `Moved To do → In progress`; other events are left as the server wrote them. */
export function prettyEvent(text: string): string {
  if (!/^moved\b/i.test(text.trim())) return text
  return text.replace(/\b(proposed|todo|in_progress|review|done|dropped)\b/g, (m) => STATE_LABEL[m as CardState]).replace(/^moved/, 'Moved')
}

export function hasText(s: string | null | undefined): boolean {
  return !!s && s.trim().length > 0
}

export const SECTION_HINTS = {
  context: 'Why does this exist? Who asked, where did it come from?',
  problem: 'What is wrong right now? Observed vs expected.',
  approach: 'Plain-English plan. No code.',
  checks: '2–7 checks, each one pass or fail.',
  details: 'Anything that does not fit the sections above.',
} as const
