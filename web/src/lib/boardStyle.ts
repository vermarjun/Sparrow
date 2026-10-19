// Colour system for the board (one meaning per hue, always paired with an icon or text).
// Every class string is spelled out in full so Tailwind can see it.
import type { CardState } from '@shared/types'
import { STATE_LABEL } from '@shared/cards'

export interface ColumnStyle {
  id: CardState
  name: string
  /** Small solid dot / swatch. */
  dot: string
  /** Column header strip. */
  head: string
  /** Header title text. */
  title: string
  /** Count pill. */
  count: string
  /** Column body tint. */
  body: string
  /** Border around the whole column. */
  edge: string
  /** State pill (sheet, list). */
  pill: string
  /** Solid bar colour in the timing stack. */
  bar: string
  /** Drop highlight ring. */
  ring: string
}

export const COLUMNS: ColumnStyle[] = [
  { id: 'proposed', name: STATE_LABEL.proposed, dot: 'bg-violet-500', head: 'bg-violet-100/80', title: 'text-violet-900', count: 'bg-violet-200/80 text-violet-900',
    body: 'bg-violet-50/60', edge: 'border-violet-200/80', pill: 'bg-violet-100 text-violet-800 border-violet-200', bar: 'bg-violet-400', ring: 'ring-violet-400' },
  { id: 'todo', name: STATE_LABEL.todo, dot: 'bg-slate-500', head: 'bg-slate-200/70', title: 'text-slate-800', count: 'bg-slate-300/70 text-slate-800',
    body: 'bg-slate-100/70', edge: 'border-slate-200', pill: 'bg-slate-100 text-slate-700 border-slate-300', bar: 'bg-slate-400', ring: 'ring-slate-400' },
  { id: 'in_progress', name: STATE_LABEL.in_progress, dot: 'bg-sky-500', head: 'bg-sky-100/80', title: 'text-sky-900', count: 'bg-sky-200/80 text-sky-900',
    body: 'bg-sky-50/70', edge: 'border-sky-200/80', pill: 'bg-sky-100 text-sky-800 border-sky-200', bar: 'bg-sky-500', ring: 'ring-sky-400' },
  { id: 'review', name: STATE_LABEL.review, dot: 'bg-amber-500', head: 'bg-amber-100/80', title: 'text-amber-900', count: 'bg-amber-200/80 text-amber-900',
    body: 'bg-amber-50/70', edge: 'border-amber-200/80', pill: 'bg-amber-100 text-amber-800 border-amber-200', bar: 'bg-amber-400', ring: 'ring-amber-400' },
  { id: 'done', name: STATE_LABEL.done, dot: 'bg-emerald-500', head: 'bg-emerald-100/80', title: 'text-emerald-900', count: 'bg-emerald-200/80 text-emerald-900',
    body: 'bg-emerald-50/60', edge: 'border-emerald-200/80', pill: 'bg-emerald-100 text-emerald-800 border-emerald-200', bar: 'bg-emerald-500', ring: 'ring-emerald-400' },
  { id: 'dropped', name: STATE_LABEL.dropped, dot: 'bg-zinc-400', head: 'bg-zinc-200/70', title: 'text-zinc-700', count: 'bg-zinc-300/70 text-zinc-700',
    body: 'bg-zinc-100/60', edge: 'border-zinc-200', pill: 'bg-zinc-100 text-zinc-600 border-zinc-300', bar: 'bg-zinc-400', ring: 'ring-zinc-400' },
]

export const COLUMN_BY_STATE: Record<CardState, ColumnStyle> = Object.fromEntries(COLUMNS.map((c) => [c.id, c])) as Record<CardState, ColumnStyle>

/** Category chip palette: nine hues that avoid the state hues (red urgent, orange blocked, green done, sky/amber/violet columns). */
export const CATEGORY_PALETTE = [
  'bg-indigo-100 text-indigo-800',
  'bg-cyan-100 text-cyan-800',
  'bg-teal-100 text-teal-800',
  'bg-lime-100 text-lime-800',
  'bg-pink-100 text-pink-800',
  'bg-fuchsia-100 text-fuchsia-800',
  'bg-yellow-100 text-yellow-800',
  'bg-stone-200 text-stone-800',
  'bg-purple-100 text-purple-800',
] as const

/** FNV-1a over the normalised name: the same category is always the same hue, in every session. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function categoryIndex(name: string): number {
  return hashString(name.trim().toLowerCase()) % CATEGORY_PALETTE.length
}

export function categoryClass(name: string): string {
  return CATEGORY_PALETTE[categoryIndex(name)]
}

/** Estimate-ratio tone classes (green ≤ 1.1x, amber ≤ 1.5x, red above). */
export const TONE_CLASS = {
  ok: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  warn: 'text-amber-800 bg-amber-50 border-amber-200',
  bad: 'text-red-700 bg-red-50 border-red-200',
  none: 'text-muted-foreground bg-muted border-border',
} as const
