// Timing, only in Review and Done: one quiet line (`Est 1h 30m · Build 2h 40m (1.8× over) · Review 55m`) that expands to
// the milestones and the stacked bar of time per stage.
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Card } from '@shared/types'
import { fullDate } from '@/lib/format'
import { whoName } from '@/lib/cardText'
import { timingView } from '@/lib/timingView'
import { COLUMN_BY_STATE } from '@/lib/boardStyle'
import { Tip } from '@/components/board/markers'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { focusRing } from './pickers'

const VERDICT = { ok: 'text-emerald-700 dark:text-emerald-300', warn: 'text-amber-700 dark:text-amber-300', bad: 'text-amber-800 dark:text-amber-300', none: 'text-muted-foreground' } as const

function dayAndTime(at: number) {
  const full = fullDate(at) // 17 Oct 2026, 05:39
  const i = full.lastIndexOf(', ')
  return { day: full.slice(0, i), time: full.slice(i + 2) }
}

const DOT = { proposed: 'proposed', accepted: 'todo', started: 'in_progress', review: 'review', done: 'done' } as const

export function Timing({ card, now }: { card: Card; now: number }) {
  const agents = useStore((s) => s.agents)
  const [open, setOpen] = useState(false)
  if (card.state !== 'review' && card.state !== 'done') return null
  const who = whoName(agents)
  const v = timingView(card, now)
  const reached = v.milestones.filter((m) => m.at != null).length
  return (
    <section data-section="timing">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn('-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/[0.04]', focusRing)}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground/70 transition-transform', open && 'rotate-90')} aria-hidden />
        <span className="min-w-0 truncate" data-timing-line>
          {card.estimate_min ? <>Est <b className="font-medium text-foreground">{v.estimate}</b> · </> : null}
          Build <b className="font-medium text-foreground">{v.build}</b>
          {v.verdict && <span className={cn('font-medium', VERDICT[v.tone])}> ({v.verdict})</span>}
          {v.review !== '—' && <> · Review <b className="font-medium text-foreground">{v.review}</b></>}
          {v.reopened > 0 && <span data-reopened> · reopened {v.reopened}×</span>}
        </span>
      </button>

      {open && (
        <div className="mt-2 pl-5" data-timing-detail>
          <ol className="grid grid-cols-5 gap-1" aria-label="Milestones">
            {v.milestones.map((m, i) => {
              const on = m.at != null
              const t = on ? dayAndTime(m.at!) : null
              return (
                <li key={m.key} data-milestone={m.key} data-reached={on} className="relative min-w-0">
                  <div className="flex items-center">
                    <span className={cn('relative z-10 size-2.5 shrink-0 rounded-full', on ? COLUMN_BY_STATE[DOT[m.key]].dot : 'border border-border bg-background')} aria-hidden />
                    {i < v.milestones.length - 1 && <span className={cn('h-px flex-1', i + 1 < reached ? 'bg-muted-foreground/30' : 'border-t border-dashed border-border')} aria-hidden />}
                  </div>
                  <div className={cn('mt-1.5 text-[12px] font-medium', on ? 'text-foreground' : 'text-muted-foreground/70')}>{m.label}</div>
                  {t ? (
                    <div className="text-[11.5px] leading-snug text-muted-foreground tabular-nums">
                      <div>{t.day}</div>
                      <div>{t.time}{m.by && m.by !== 'user' ? <span className="text-muted-foreground/70"> · {who(m.by)}</span> : null}</div>
                    </div>
                  ) : <div className="text-[11.5px] text-muted-foreground/70">not yet</div>}
                </li>
              )
            })}
          </ol>

          {v.segments.length > 0 && (
            <div className="mt-3.5">
              <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted" role="img" aria-label={`Time in each stage: ${v.segments.map((s) => s.label).join(', ')}`} data-timing-bar>
                {v.segments.map((s) => (
                  <Tip key={s.state} label={s.label}>
                    <span className={cn('block h-full min-w-[3px]', COLUMN_BY_STATE[s.state].bar)} style={{ width: `${s.pct}%` }} data-segment={s.state} />
                  </Tip>
                ))}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {v.segments.map((s) => (
                  <li key={s.state} className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <span className={cn('size-2 rounded-[3px]', COLUMN_BY_STATE[s.state].bar)} aria-hidden />
                    {s.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
