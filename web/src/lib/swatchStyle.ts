// The legend swatch colours. The toolbar chips, column headers, card rails and list flags all draw from here, so the legend
// explains the board: urgent = solid red-500, blocked = orange-500 hatched at 45deg, quick win = emerald-500, later = slate-400 (dashed, light fill).
import { type CSSProperties } from 'react'

export type SwatchKind = 'urgent' | 'blocked' | 'quick' | 'later'

export const QUICK_COLOR = '#10b981' // emerald-500

const HATCH = 'repeating-linear-gradient(45deg, #f97316 0 2px, transparent 2px 4px)' // orange-500

export function swatchStyle(kind: SwatchKind): CSSProperties {
  switch (kind) {
    case 'urgent': return { backgroundColor: '#ef4444' } // red-500
    case 'blocked': return { backgroundColor: 'rgb(249 115 22 / 0.12)', backgroundImage: HATCH, boxShadow: 'inset 0 0 0 1px #f97316' }
    case 'quick': return { backgroundColor: QUICK_COLOR }
    case 'later': return { backgroundColor: 'rgb(148 163 184 / 0.25)', boxShadow: 'inset 0 0 0 1px #94a3b8' } // slate-400
  }
}

/** The same swatch without the outline, for the 4px rail on a card's edge. */
export function railStyle(kind: 'urgent' | 'blocked'): CSSProperties {
  const { boxShadow: _outline, ...rest } = swatchStyle(kind)
  return rest
}
