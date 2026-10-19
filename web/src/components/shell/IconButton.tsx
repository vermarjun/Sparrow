import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Ghost icon button: always a tooltip and an aria-label (§7.6). `hint` is a shortcut shown after the label. */
export function IconButton({ label, hint, side = 'bottom', children, ...props }: ComponentProps<typeof Button> & { label: string; hint?: string; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {hint && <kbd className="font-mono text-[11px] opacity-60">{hint}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
