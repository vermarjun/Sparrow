// One captain on the project home (§7.2): avatar · what it works on · fleet strip · status · time, with the last message
// underneath. A stretched link makes the whole row the target; the quick actions sit in the time's slot and take its place on hover.
import type { ReactNode } from 'react'
import { Archive, ArchiveRestore, Copy, Play, Terminal } from 'lucide-react'
import type { CaptainSummary } from '@shared/types'
import { CaptainAvatar, FleetStrip, StateDot, StatusGlyph } from '@/components/captains/primitives'
import { IconButton } from '@/components/shell/IconButton'
import { RESUME_LABEL, copyText, resumeCaptain, resumeMode, setArchived } from '@/lib/captainActions'
import { captainName, fleetStrip, isUntitled, lastMessageLine, statusLabel, tildePath } from '@/lib/captains'
import { ago } from '@/lib/format'
import { captainHref } from '@/lib/route'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const TONE = { ok: 'text-ok', blocked: 'text-warn', failed: 'text-bad', question: 'text-warn', muted: 'text-muted-foreground' } as const

export function StatusCell({ s, className }: { s: CaptainSummary; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2 text-[13px]', s.status === 'idle' || s.status === 'archived' ? 'text-muted-foreground' : 'text-foreground/85', className)}>
      <span className="grid size-2 shrink-0 place-items-center">
        {s.status === 'working' || s.status === 'attention' ? <StatusGlyph status={s.status} /> : <StateDot state="idle" />}
      </span>
      <span className="truncate">{statusLabel(s)}</span>
    </span>
  )
}

function Actions({ s }: { s: CaptainSummary }) {
  const mode = resumeMode(s)
  const archived = s.status === 'archived'
  const ResumeIcon = mode === 'attach' ? Terminal : mode === 'manual' ? Copy : Play
  return (
    <span className="flex items-center gap-0.5">
      {mode !== 'none' && (
        <IconButton label={RESUME_LABEL[mode]} className="text-muted-foreground hover:text-foreground" onClick={() => void resumeCaptain(s)}><ResumeIcon className="size-4" /></IconButton>
      )}
      {mode !== 'manual' && s.resume.command && (
        <IconButton label="Copy resume command" className="text-muted-foreground hover:text-foreground" onClick={() => void copyText(s.resume.command!, 'Resume command copied')}><Copy className="size-4" /></IconButton>
      )}
      <IconButton label={archived ? 'Unarchive' : 'Archive'} className="text-muted-foreground hover:text-foreground" onClick={() => void setArchived(s, !archived)}>
        {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
      </IconButton>
    </span>
  )
}

export function CaptainRow({ s, focused, now }: { s: CaptainSummary; focused?: boolean; now: number }) {
  const project = useStore((st) => st.project)
  const agents = useStore((st) => st.agents)
  const a = s.agent
  const strip = fleetStrip(Object.values(agents), a.id)
  const last = lastMessageLine(s.last_message)
  const untitled = isUntitled(a)
  const meta: ReactNode[] = [`@${a.handle}`]
  if (a.captain?.branch && !untitled) meta.push(a.captain.branch)
  meta.push(tildePath(a.cwd))
  return (
    <div
      data-captain-row={a.id}
      data-focused={focused || undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-accent/50 has-focus-visible:bg-accent/50 md:gap-4',
        focused && 'bg-accent/50 ring-1 ring-ring/40',
        s.status === 'archived' && 'opacity-70',
      )}
    >
      <a
        href={captainHref(a.id, project)}
        aria-label={`Open ${captainName(a)}`}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      />
      <CaptainAvatar id={a.id} handle={a.handle} size="md" className="pointer-events-none self-start" />
      <div className="pointer-events-none min-w-0 flex-1">
        <div className={cn('truncate text-sm leading-5 font-medium', untitled && 'text-muted-foreground')}>{captainName(a)}</div>
        <div className="mt-0.5 truncate font-mono text-[12px] leading-4 text-muted-foreground">{meta.map((m, i) => <span key={i}>{i > 0 && <span className="px-1.5 opacity-50">·</span>}{m}</span>)}</div>
        {last && (
          <div className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5 text-muted-foreground">
            <span aria-hidden className={cn('w-3 shrink-0 text-center font-medium', TONE[last.tone])}>{last.glyph}</span>
            <span className="shrink-0 font-medium text-foreground/70">{last.from}</span>
            <span className="truncate">{last.text}</span>
          </div>
        )}
      </div>
      <div className="hidden w-32 shrink-0 md:block"><FleetStrip {...strip} /></div>
      <StatusCell s={s} className="pointer-events-none hidden w-40 shrink-0 md:flex" />
      <div className="pointer-events-none flex shrink-0 items-center gap-2 md:hidden"><StatusGlyph status={s.status} /></div>
      <div className="relative flex h-7 w-8 shrink-0 items-center justify-end md:w-[92px]">
        <span className="pointer-events-none text-xs text-muted-foreground tabular transition-opacity duration-150 md:group-hover:opacity-0 md:group-has-focus-visible:opacity-0">{ago(s.last_activity_at, now)}</span>
        <span className="pointer-events-none absolute right-0 hidden opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:opacity-100 md:block">
          <Actions s={s} />
        </span>
      </div>
    </div>
  )
}
