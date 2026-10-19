// Timing panel: milestones, the stacked bar of time per stage, estimate vs active.
import { AlertTriangle, Check, Hourglass, RotateCcw, TrendingUp } from 'lucide-react'
import type { Card } from '@shared/types'
import { fullDate } from '@/lib/format'
import { whoName } from '@/lib/cardText'
import { type Tone, timingView } from '@/lib/timingView'
import { COLUMN_BY_STATE, TONE_CLASS } from '@/lib/boardStyle'
import { Tip } from '@/components/board/markers'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const TONE_ICON: Record<Tone, typeof Check | null> = { ok: Check, warn: TrendingUp, bad: AlertTriangle, none: null }

function dayAndTime(at: number) {
  const full = fullDate(at) // 17 Oct 2026, 05:39
  const i = full.lastIndexOf(', ')
  return { day: full.slice(0, i), time: full.slice(i + 2) }
}

export function Timing({ card, now }: { card: Card; now: number }) {
  const agents = useStore((s) => s.agents)
  const who = whoName(agents)
  const v = timingView(card, now)
  const ToneIcon = TONE_ICON[v.tone]
  const reached = v.milestones.filter((m) => m.at != null).length
  return (
    <section data-section="timing" className="rounded-xl border border-zinc-200/90 bg-white px-4 pt-3 pb-4 shadow-[0_1px_2px_rgba(24,24,27,0.04)]">
      <header className="mb-3 flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-zinc-100 text-zinc-600"><Hourglass className="size-3.5" /></span>
        <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-zinc-600 uppercase">Timing</h3>
        {v.reopened > 0 && (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-px text-[11px] font-medium text-zinc-600" data-reopened>
            <RotateCcw className="size-3" aria-hidden />Reopened {v.reopened}×
          </span>
        )}
      </header>

      <ol className="grid grid-cols-5 gap-1" aria-label="Milestones">
        {v.milestones.map((m, i) => {
          const on = m.at != null
          const dot = m.key === 'proposed' ? COLUMN_BY_STATE.proposed.dot : m.key === 'accepted' ? COLUMN_BY_STATE.todo.dot : m.key === 'started' ? COLUMN_BY_STATE.in_progress.dot : m.key === 'review' ? COLUMN_BY_STATE.review.dot : COLUMN_BY_STATE.done.dot
          const t = on ? dayAndTime(m.at!) : null
          return (
            <li key={m.key} data-milestone={m.key} data-reached={on} className="relative min-w-0">
              <div className="flex items-center">
                <span className={cn('relative z-10 size-2.5 shrink-0 rounded-full', on ? dot : 'border border-zinc-300 bg-white')} aria-hidden />
                {i < v.milestones.length - 1 && <span className={cn('h-px flex-1', i + 1 < reached ? 'bg-zinc-300' : 'border-t border-dashed border-zinc-300')} aria-hidden />}
              </div>
              <div className={cn('mt-1.5 text-[12px] font-semibold', on ? 'text-zinc-800' : 'text-zinc-400')}>{m.label}</div>
              {t ? (
                <div className="text-[11.5px] leading-snug text-zinc-500 tabular-nums">
                  <div>{t.day}</div>
                  <div>{t.time}{m.by && m.by !== 'user' ? <span className="text-zinc-400"> · {who(m.by)}</span> : null}</div>
                </div>
              ) : <div className="text-[11.5px] text-zinc-400">not yet</div>}
            </li>
          )
        })}
      </ol>

      {v.segments.length > 0 && (
        <div className="mt-4">
          <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-zinc-100" role="img" aria-label={`Time in each stage: ${v.segments.map((s) => s.label).join(', ')}`} data-timing-bar>
            {v.segments.map((s) => (
              <Tip key={s.state} label={s.label}>
                <span className={cn('block h-full min-w-[3px]', COLUMN_BY_STATE[s.state].bar)} style={{ width: `${s.pct}%` }} data-segment={s.state} />
              </Tip>
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {v.segments.map((s) => (
              <li key={s.state} className="inline-flex items-center gap-1.5 text-[12px] text-zinc-600">
                <span className={cn('size-2 rounded-[3px]', COLUMN_BY_STATE[s.state].bar)} aria-hidden />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-zinc-100 pt-3 text-[13px]" data-timing-summary>
        <span className="text-zinc-500">Estimate <b className={cn('font-semibold', card.estimate_min ? 'text-zinc-900' : 'text-zinc-400')}>{v.estimate}</b></span>
        <span className="text-zinc-500">Build <b className="font-semibold text-zinc-900">{v.build}</b></span>
        {v.verdict && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-px text-[12px] font-semibold', TONE_CLASS[v.tone])} data-tone={v.tone}>
            {ToneIcon && <ToneIcon className="size-3" aria-hidden />}{v.verdict}
          </span>
        )}
        {v.review !== '—' && <span className="text-zinc-500">Review <b className="font-semibold text-zinc-900">{v.review}</b></span>}
      </div>
    </section>
  )
}
