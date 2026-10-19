// Colour system for the board (one meaning per hue, always paired with an icon or text).
// Every class string is spelled out in full so Tailwind can see it.
import type { CardState } from '@shared/types'
import { STATE_LABEL } from '@shared/cards'

export interface ColumnStyle {
  id: CardState
  name: string
  /** Small solid dot / swatch. */
  dot: string
  /** The 2px line across the top of the column (a background colour); the dot and this line are the only state colour on the board. */
  line: string
  /** Column header (neutral: the state colour lives in the dot and the line). */
  head: string
  /** Header title text. */
  title: string
  /** Count text. */
  count: string
  /** Column body (neutral). */
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
  { id: 'proposed', name: STATE_LABEL.proposed, dot: 'bg-violet-500', line: 'bg-violet-500', head: 'bg-transparent', title: 'text-foreground', count: 'text-muted-foreground/70',
    body: 'bg-background/70 dark:bg-white/[0.03]', edge: 'border-border/80', pill: 'bg-violet-100 dark:bg-violet-500/15 text-violet-800 dark:text-violet-300 border-violet-200 dark:border-violet-500/30', bar: 'bg-violet-400', ring: 'ring-violet-400' },
  { id: 'todo', name: STATE_LABEL.todo, dot: 'bg-muted-foreground', line: 'bg-muted-foreground/60', head: 'bg-transparent', title: 'text-foreground', count: 'text-muted-foreground/70',
    body: 'bg-background/70 dark:bg-white/[0.03]', edge: 'border-border/80', pill: 'bg-muted text-foreground/75 border-border', bar: 'bg-muted-foreground/60', ring: 'ring-ring' },
  { id: 'in_progress', name: STATE_LABEL.in_progress, dot: 'bg-sky-500', line: 'bg-sky-500', head: 'bg-transparent', title: 'text-foreground', count: 'text-muted-foreground/70',
    body: 'bg-background/70 dark:bg-white/[0.03]', edge: 'border-border/80', pill: 'bg-sky-100 dark:bg-sky-500/15 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-500/30', bar: 'bg-sky-500', ring: 'ring-sky-400' },
  { id: 'review', name: STATE_LABEL.review, dot: 'bg-amber-500', line: 'bg-amber-500', head: 'bg-transparent', title: 'text-foreground', count: 'text-muted-foreground/70',
    body: 'bg-background/70 dark:bg-white/[0.03]', edge: 'border-border/80', pill: 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30', bar: 'bg-amber-400', ring: 'ring-amber-400' },
  { id: 'done', name: STATE_LABEL.done, dot: 'bg-emerald-500', line: 'bg-emerald-500', head: 'bg-transparent', title: 'text-foreground', count: 'text-muted-foreground/70',
    body: 'bg-background/70 dark:bg-white/[0.03]', edge: 'border-border/80', pill: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30', bar: 'bg-emerald-500', ring: 'ring-emerald-400' },
  { id: 'dropped', name: STATE_LABEL.dropped, dot: 'bg-muted-foreground/50', line: 'bg-muted-foreground/30', head: 'bg-transparent', title: 'text-foreground', count: 'text-muted-foreground/70',
    body: 'bg-background/70 dark:bg-white/[0.03]', edge: 'border-border/80', pill: 'bg-muted text-muted-foreground border-border', bar: 'bg-muted-foreground/50', ring: 'ring-ring' },
]

export const COLUMN_BY_STATE: Record<CardState, ColumnStyle> = Object.fromEntries(COLUMNS.map((c) => [c.id, c])) as Record<CardState, ColumnStyle>

/** Category chip palette: nine hues that avoid the state hues (red urgent, orange blocked, green done, sky/amber/violet columns). */
export const CATEGORY_PALETTE = [
  'bg-indigo-100 dark:bg-indigo-500/15 text-indigo-800 dark:text-indigo-300',
  'bg-cyan-100 dark:bg-cyan-500/15 text-cyan-800 dark:text-cyan-300',
  'bg-teal-100 dark:bg-teal-500/15 text-teal-800 dark:text-teal-300',
  'bg-lime-100 dark:bg-lime-500/15 text-lime-800 dark:text-lime-300',
  'bg-pink-100 dark:bg-pink-500/15 text-pink-800 dark:text-pink-300',
  'bg-fuchsia-100 dark:bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-300',
  'bg-yellow-100 dark:bg-yellow-500/15 text-yellow-800 dark:text-yellow-300',
  'bg-stone-200 dark:bg-stone-500/15 text-stone-800 dark:text-stone-300',
  'bg-purple-100 dark:bg-purple-500/15 text-purple-800 dark:text-purple-300',
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
  ok: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/15 border-emerald-200 dark:border-emerald-500/30',
  warn: 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 border-amber-200 dark:border-amber-500/30',
  bad: 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/15 border-red-200 dark:border-red-500/30',
  none: 'text-muted-foreground bg-muted border-border',
} as const
