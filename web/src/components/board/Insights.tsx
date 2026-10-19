import { useMemo } from 'react'
import { Activity, BarChart3, CheckCircle2, Clock3, TrendingUp } from 'lucide-react'
import type { Card } from '@shared/types'
import { formatEstimate, formatSpan } from '@shared/cards'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNow } from '@/components/sparrow/bits'
import { ratioTone, ratioWord } from '@/lib/timingView'
import { TONE_CLASS } from '@/lib/boardStyle'
import { summarizeInsights } from '@/lib/insights'
import { cn } from '@/lib/utils'

/** Small board-wide popover for completion pace and estimate accuracy. */
export function Insights({ cards }: { cards: Card[] }) {
  const now = useNow()
  const summary = useMemo(() => summarizeInsights(cards, now), [cards, now])
  const ratioClass = summary.medianEstimateRatio == null ? TONE_CLASS.none : TONE_CLASS[ratioTone(summary.medianEstimateRatio)]

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" data-testid="insights" className="text-zinc-600">
          <BarChart3 /> Insights
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[340px] overflow-hidden rounded-xl border border-zinc-200 bg-white p-0 shadow-lg" data-testid="insights-popover">
        <div className="border-b border-zinc-100 bg-zinc-50/70 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900"><Activity className="size-4 text-violet-600" /> Board insights</div>
          <p className="mt-0.5 text-[11px] text-zinc-500">Completion pace and estimate accuracy</p>
        </div>

        <div className="grid grid-cols-3 gap-2 px-3 py-3">
          <Metric icon={<CheckCircle2 className="size-3.5 text-emerald-600" />} label="Done · 7 days" value={String(summary.doneLast7Days)} note="tickets" />
          <Metric icon={<Clock3 className="size-3.5 text-sky-600" />} label="Median build" value={summary.medianBuildMs == null ? '—' : formatSpan(summary.medianBuildMs)} note="time in progress" />
          <Metric
            icon={<TrendingUp className="size-3.5 text-amber-600" />}
            label="Median ratio"
            value={summary.medianEstimateRatio == null ? '—' : `${summary.medianEstimateRatio.toFixed(1)}×`}
            note={summary.medianEstimateRatio == null ? 'build / estimate' : ratioWord(summary.medianEstimateRatio)}
            valueClass={ratioClass}
          />
        </div>

        <div className="border-t border-zinc-100 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold tracking-wide text-zinc-700 uppercase">Largest estimate misses</h3>
            <span className="text-[10px] text-zinc-400">{summary.completedCount} completed</span>
          </div>
          {summary.worstMisses.length ? (
            <ol className="space-y-2">
              {summary.worstMisses.map((miss, i) => (
                <li key={miss.id} data-miss-id={miss.id} className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-red-50 font-mono text-[10px] font-semibold text-red-700">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 font-mono text-[10px] text-zinc-400">{miss.key}</span>
                      <span className="truncate text-[11px] font-medium text-zinc-800" title={miss.title}>{miss.title}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-zinc-500" title={`Estimate ${formatEstimate(miss.estimateMin)}`}>
                      Build {formatSpan(miss.buildMs)} · {ratioWord(miss.ratio)} · Review {formatSpan(miss.reviewMs)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/70 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-500">
              {summary.completedCount ? 'No completed ticket took longer than its estimate.' : 'Completed tickets with timing data will appear here.'}
            </p>
          )}
          <p className="mt-3 text-[10px] leading-relaxed text-zinc-400">Build time is compared with estimates; review time is shown separately.</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Metric({ icon, label, value, note, valueClass }: { icon: React.ReactNode; label: string; value: string; note: string; valueClass?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200/80 bg-white px-2.5 py-2 shadow-xs">
      <div className="mb-1 flex items-center gap-1.5 text-[9px] font-semibold text-zinc-500">{icon}<span className="truncate">{label}</span></div>
      <div className={cn('w-fit max-w-full truncate rounded border px-1.5 text-[15px] leading-5 font-semibold tracking-tight tabular-nums', valueClass ?? 'border-transparent bg-transparent text-zinc-900')}>{value}</div>
      <div className="mt-0.5 truncate text-[9px] text-zinc-400">{note}</div>
    </div>
  )
}
