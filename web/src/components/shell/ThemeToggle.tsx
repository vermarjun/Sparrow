import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePref } from '@/lib/theme'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const OPTIONS: { id: ThemePref; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'system', label: 'System', Icon: Monitor },
]

/** Three quiet icons; the chosen one is lit. */
export function ThemeToggle({ className }: { className?: string }) {
  const { pref, set } = useTheme()
  return (
    <div role="radiogroup" aria-label="Theme" className={cn('inline-flex items-center gap-0.5 rounded-lg p-0.5', className)}>
      {OPTIONS.map(({ id, label, Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={pref === id}
              aria-label={`${label} theme`}
              onClick={() => set(id)}
              className={cn(
                'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                pref === id && 'bg-accent text-foreground',
              )}
            >
              <Icon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
