// Shared bits of the captain page: empty state (one sentence, one button, the CLI line) and skeleton rows.
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/captainActions'
import { cn } from '@/lib/utils'

export function Cli({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => { void copyText(text, 'Copied'); setDone(true); setTimeout(() => setDone(false), 1200) }}
      className={cn('group inline-flex max-w-full items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-left font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', className)}
      aria-label={`Copy ${text}`}
    >
      <span className="truncate">{text}</span>
      {done ? <Check aria-hidden className="size-3.5 shrink-0" /> : <Copy aria-hidden className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
    </button>
  )
}

export function EmptyState({ title, hint, cli, action }: { title: string; hint: string; cli?: string; action?: { label: string; href?: string; onClick?: () => void } }) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {action && (action.href ? <Button asChild size="lg"><a href={action.href}>{action.label}</a></Button> : <Button size="lg" onClick={action.onClick}>{action.label}</Button>)}
      {cli && <Cli text={cli} />}
    </div>
  )
}

export const Bar = ({ className }: { className?: string }) => <span className={cn('block animate-pulse rounded-md bg-muted', className)} />

/** Placeholder rows for the activity feed while it loads. */
export function FeedSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[808px] space-y-6 px-4 py-6 sm:px-6" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
          <Bar className="size-7 rounded-full" />
          <div className="space-y-2 pt-1"><Bar className="h-3.5 w-40" /><Bar className="h-3.5 w-full max-w-md" />{i % 2 === 0 && <Bar className="h-3.5 w-2/3 max-w-sm" />}</div>
        </div>
      ))}
    </div>
  )
}
