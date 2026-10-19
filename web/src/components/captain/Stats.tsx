// Stats (§7.3): inline numbers over muted labels. No boxes. Unread > 0 turns amber with a quiet note.
import type { CaptainSummary } from '@shared/types'
import { captainStats } from '@/lib/captainPage'
import { cn } from '@/lib/utils'

const TONE = { default: 'text-foreground', warn: 'text-amber-700 dark:text-amber-300', bad: 'text-bad' } as const

export function Stats({ summary }: { summary: CaptainSummary }) {
  const items = captainStats(summary)
  return (
    <div data-testid="stats">
      <dl className="flex items-end gap-5 sm:gap-10">
        {items.map((i) => (
          <div key={i.key} className="flex min-w-0 flex-col-reverse" data-stat={i.key}>
            <dt className="mt-1.5 text-xs whitespace-nowrap text-muted-foreground">{i.label}{i.note && <span className="hidden sm:inline"> · {i.note}</span>}</dt>
            <dd className={cn('text-lg leading-none font-semibold tabular', TONE[i.tone])}>{i.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
