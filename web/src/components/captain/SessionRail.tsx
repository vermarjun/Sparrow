// Right rail of the Activity tab on wide screens (≥ 1280 px): compact team (working first) and the Session block.
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import type { Agent, CaptainSummary } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/captainActions'
import { resumeTail } from '@/lib/captainPage'
import { tildePath } from '@/lib/captains'
import { cn } from '@/lib/utils'
import { CompactTeam } from './Team'

/** One plain row: muted label, mono value on a single line (ellipsis, full text in the tooltip), copy button on hover. */
function CopyLine({ label, value, shown, what }: { label: string; value: string; shown?: string; what: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="group border-b border-border/40 py-2 last:border-b-0">
      <div className="mb-0.5 text-xs text-muted-foreground">{label}</div>
      <div className="flex h-6 items-center gap-1">
        <span title={value} className="min-w-0 flex-1 truncate font-mono text-[12px] leading-6">{shown ?? value}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => { void copyText(value, what); setDone(true); setTimeout(() => setDone(false), 1200) }}
              aria-label={`Copy ${label.toLowerCase()}`}
              className={cn('grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-[opacity,colors] duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100', done ? 'opacity-100' : 'opacity-0')}
            >
              {done ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{done ? 'Copied' : `Copy ${label.toLowerCase()}`}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function SessionRail({ summary, fleet, onAgent }: { summary: CaptainSummary; fleet: Agent[]; onAgent: (id: string) => void }) {
  const a = summary.agent
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col gap-7 overflow-y-auto border-l border-border/60 px-5 py-6 xl:flex" aria-label="Team and session">
      <section>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Team</h3>
        <CompactTeam fleet={fleet} captainId={a.id} onAgent={onAgent} />
      </section>
      <section>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Session</h3>
        <CopyLine label="Folder" value={a.cwd} shown={tildePath(a.cwd)} what="Folder copied" />
        {a.captain?.branch && <CopyLine label="Branch" value={a.captain.branch} what="Branch copied" />}
        {summary.resume.command ? (
          <CopyLine label="Resume" value={summary.resume.command} shown={resumeTail(summary.resume.command)} what="Resume command copied" />
        ) : <p className="text-[13px] text-muted-foreground">No session id yet. It gets one the first time the captain runs a sparrow command.</p>}
        {summary.resume.attach && <CopyLine label="Attach" value={summary.resume.attach} what="tmux attach line copied" />}
      </section>
    </aside>
  )
}
