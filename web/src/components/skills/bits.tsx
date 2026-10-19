// Small pieces shared by the Skills page: chips, per-harness toggle cell, diff view, confirm dialog, action helpers.
import { useState, type ReactNode } from 'react'
import { Info, Link2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { middleTruncate } from '@/lib/format'
import {
  HARNESS_NAME, TONE, alsoReadNote, chipFor, diffStat, parseDiff, tilde,
  type Chip as ChipT, type HarnessLink, type LibrarySkill, type Tone,
} from '@/lib/skills'
import { cn } from '@/lib/utils'

export function Pill({ tone = 'none', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap', TONE[tone], className)}>
      {children}
    </span>
  )
}

export function StatusChip({ chip }: { chip: ChipT }) {
  return (
    <Pill tone={chip.tone} title={chip.title}>
      {chip.label === 'locked' && <Lock className="size-3" />}
      {chip.label.startsWith('via ') && <Link2 className="size-3" />}
      {chip.label}
    </Pill>
  )
}

export function SourceBadge({ skill }: { skill: Pick<LibrarySkill, 'source' | 'sourceUrl'> }) {
  if (skill.source === 'github' && skill.sourceUrl) {
    return (
      <a href={skill.sourceUrl.replace(/\.git$/, '')} target="_blank" rel="noreferrer" className="text-[12px] text-sky-700 underline-offset-2 hover:underline dark:text-sky-300">
        github ↗
      </a>
    )
  }
  return <span className="text-[12px] text-muted-foreground">{skill.source}</span>
}

/** Monospace path, `~`-shortened against the library's HOME, full path on hover. */
export function Tilde({ path, home, max = 52, className }: { path: string; home: string; max?: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('font-mono whitespace-nowrap', className)}>{middleTruncate(tilde(path, home), max)}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-none font-mono">{path}</TooltipContent>
    </Tooltip>
  )
}

/** One harness cell: the toggle, its status chip and the "also read by" hint. */
export function HarnessCell({ skill, link, busy, onToggle }: { skill: LibrarySkill; link: HarnessLink; busy: boolean; onToggle: () => void }) {
  const chip = chipFor(link)
  const note = alsoReadNote(link)
  return (
    <div className="flex items-center gap-2" data-harness={link.harness} data-state={link.state}>
      <Switch
        checked={link.wanted}
        disabled={skill.locked || busy}
        onCheckedChange={onToggle}
        aria-label={`${skill.name} for ${HARNESS_NAME[link.harness]}`}
      />
      {chip ? <StatusChip chip={chip} /> : <span className="text-[11px] text-muted-foreground/60">off</span>}
      {note && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="size-3.5 text-muted-foreground" aria-label={note} />
          </TooltipTrigger>
          <TooltipContent>{note}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- confirm

export function ConfirmDialog({
  open, onOpenChange, title, children, confirmLabel, onConfirm, tone = 'default',
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => Promise<void>
  tone?: 'default' | 'destructive'
}) {
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { await onConfirm(); onOpenChange(false) } catch { /* the action already toasted; keep the dialog open */ } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{children}</div></DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant={tone === 'destructive' ? 'destructive' : 'default'} onClick={() => void go()} disabled={busy} data-testid="confirm">
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- diff

export function DiffView({ text, name, label = 'library → this copy' }: { text: string; name: string; label?: string }) {
  const files = parseDiff(text, name)
  const stat = diffStat(files)
  if (!files.length) return <div className="px-3 py-2 text-xs text-muted-foreground">No differences.</div>
  return (
    <div className="space-y-2" data-testid="diff">
      <div className="text-[11px] text-muted-foreground">
        {stat.files} file{stat.files === 1 ? '' : 's'} differ · <span className="text-emerald-700 dark:text-emerald-300">+{stat.added}</span>{' '}
        <span className="text-red-700 dark:text-red-300">−{stat.removed}</span> · {label}
      </div>
      {files.map((f) => (
        <div key={f.path} className="overflow-hidden rounded-md border">
          <div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-1 font-mono text-[11.5px]">
            {f.path}
            {f.note && <span className="font-sans text-[11px] text-muted-foreground">· {f.note}</span>}
          </div>
          <pre className="overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.55]">
            {f.lines.map((l, i) => (
              <div
                key={i}
                className={cn(
                  'px-3 whitespace-pre',
                  l.kind === 'add' && 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
                  l.kind === 'del' && 'bg-red-500/10 text-red-800 dark:text-red-300',
                  l.kind === 'hunk' && 'bg-muted/50 text-muted-foreground',
                )}
              >
                <span className="mr-2 inline-block w-2 select-none opacity-60">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                {l.text || ' '}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  )
}
