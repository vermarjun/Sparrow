// The legend swatch component (colours live in @/lib/swatchStyle).
import { cn } from '@/lib/utils'
import { swatchStyle, type SwatchKind } from '@/lib/swatchStyle'

/** `rail` mirrors the stripe on a card's edge; `dot` is the same swatch as a small circle (column headers). */
export function Swatch({ kind, shape = 'rail', className }: { kind: SwatchKind; shape?: 'rail' | 'dot'; className?: string }) {
  return (
    <span
      aria-hidden
      data-swatch={kind}
      style={swatchStyle(kind)}
      className={cn('inline-block shrink-0', shape === 'rail' ? 'h-3.5 w-1.5 rounded-[2px]' : 'size-2 rounded-full', kind === 'later' && shape === 'rail' && 'border-dashed', className)}
    />
  )
}
