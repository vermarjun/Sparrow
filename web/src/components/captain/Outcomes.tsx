// Outcomes (§7.3): what the team delivered. Latest result per fleet agent, newest first; a click jumps to that message.
import { useMemo, useState } from 'react'
import { Check, TriangleAlert, X } from 'lucide-react'
import type { Agent, MessageView } from '@shared/types'
import { useNow } from '@/components/sparrow/bits'
import { outcomes, type OutcomeRow } from '@/lib/captainPage'
import { agoLabel } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useRowNav } from './hooks'

const GLYPH = {
  ok: { Icon: Check, cls: 'text-ok', label: 'Done' },
  blocked: { Icon: TriangleAlert, cls: 'text-warn', label: 'Blocked' },
  failed: { Icon: X, cls: 'text-bad', label: 'Failed' },
} as const

const isNarrow = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 639px)').matches

export function Outcomes({ fleet, messages, captainId, onOpen }: { fleet: Agent[]; messages: MessageView[] | undefined; captainId: string; onOpen: (row: OutcomeRow) => void }) {
  const rows = useMemo(() => outcomes(fleet, messages, captainId), [fleet, messages, captainId])
  const [all, setAll] = useState(false)
  const [limit] = useState(() => (isNarrow() ? 3 : 4))
  const now = useNow(30000)
  const onKeyDown = useRowNav()
  const shown = all ? rows : rows.slice(0, limit)
  return (
    <section aria-label="Outcomes" className="shrink-0 border-b border-border/60" data-testid="outcomes">
      <div className="mx-auto w-full max-w-[808px] px-4 py-3 sm:px-6">
        <div className="mb-1 flex h-5 items-center justify-between">
          <h3 className="text-xs font-medium text-muted-foreground">Delivered{rows.length > 0 && <span className="ml-1.5 tabular">{rows.length}</span>}</h3>
          {rows.length > limit && (
            <button type="button" onClick={() => setAll((v) => !v)} className="rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="h-8 text-[13px] leading-8 text-muted-foreground">{messages ? 'Nothing delivered yet' : ''}</p>
        ) : (
          <ul className={cn('-mx-2', all && rows.length > 6 && 'max-h-52 overflow-y-auto')} onKeyDown={onKeyDown}>
            {shown.map((r) => {
              const g = GLYPH[r.status]
              return (
                <li key={r.agentId}>
                  <button
                    type="button"
                    data-row
                    data-outcome={r.handle}
                    onClick={() => onOpen(r)}
                    title={r.line}
                    className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <g.Icon aria-label={g.label} className={cn('size-3.5 shrink-0', g.cls)} />
                    <span className="shrink-0 text-[13px] font-medium">@{r.handle}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{r.line}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular">{agoLabel(r.at, now)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
