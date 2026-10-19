// Muted meta line under the title (§7.3): folder, branch, harness, session (click copies), online / seen, origin.
import type { ReactNode } from 'react'
import { Clock, Folder, GitBranch, Fingerprint, SquareTerminal, Radio } from 'lucide-react'
import type { CaptainSummary } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/components/sparrow/bits'
import { HARNESS_LABEL, originLabel, seenLabel } from '@/lib/captainPage'
import { copyText } from '@/lib/captainActions'
import { shortSession, tildePath } from '@/lib/captains'
import { cn } from '@/lib/utils'

function Item({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}><span aria-hidden className="shrink-0 text-muted-foreground/70 [&_svg]:size-3.5">{icon}</span>{children}</span>
}

function CopyItem({ icon, value, what, tip, children, className }: { icon: ReactNode; value: string; what: string; tip: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copyText(value, what)}
          aria-label={tip}
          className={cn('inline-flex min-w-0 items-center gap-1.5 rounded-sm transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', className)}
        >
          <span aria-hidden className="shrink-0 text-muted-foreground/70 [&_svg]:size-3.5">{icon}</span>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

export function MetaLine({ summary }: { summary: CaptainSummary }) {
  const a = summary.agent
  const now = useNow(30000)
  const seen = seenLabel(summary, now)
  const harness = a.captain?.harness ?? summary.resume.harness
  const sid = summary.resume.session_id
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground" data-testid="meta-line">
      <CopyItem icon={<Folder />} value={a.cwd} what="Folder copied" tip="Copy folder" className="max-w-full">
        <span className="truncate font-mono text-[12px]">{tildePath(a.cwd)}</span>
      </CopyItem>
      {a.captain?.branch && <Item icon={<GitBranch />}><span className="truncate font-mono text-[12px]">{a.captain.branch}</span></Item>}
      <Item icon={<SquareTerminal />} className="max-sm:hidden">{HARNESS_LABEL[harness] ?? harness}</Item>
      {sid ? (
        <CopyItem icon={<Fingerprint />} value={sid} what="Session id copied" tip="Copy session id" className="max-sm:hidden">
          <span className="font-mono text-[12px]">{shortSession(sid)}</span>
        </CopyItem>
      ) : <Item icon={<Fingerprint />} className="max-sm:hidden"><span className="text-muted-foreground/70">no session yet</span></Item>}
      <Item icon={seen.online ? <span className="grid size-3.5 place-items-center"><span className="size-1.5 rounded-full bg-ok" /></span> : <Clock />} className={seen.online ? 'text-foreground/80' : undefined}>{seen.text}</Item>
      <Item icon={<Radio />} className="max-sm:hidden">{originLabel(a.captain?.origin)}</Item>
    </div>
  )
}
