// Captain header (§7.3): avatar, inline-editable title, @handle chip, status pill, and the Resume split button.
import { useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, Copy, Fingerprint, Folder, Pencil, Play, Terminal, TextCursorInput } from 'lucide-react'
import type { CaptainSummary } from '@shared/types'
import { CaptainAvatar, StateDot, StatusGlyph } from '@/components/captains/primitives'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RESUME_LABEL, copyText, patchCaptainField, resumeCaptain, resumeMode, setArchived } from '@/lib/captainActions'
import { captainName, isUntitled, statusLabel } from '@/lib/captains'
import { cn } from '@/lib/utils'

const TITLE = 'text-xl leading-7 font-semibold tracking-tight'

/** Click to edit; Enter or blur saves, Esc cancels. Untitled shows the fallback muted plus a "Name this captain" affordance. */
function TitleEdit({ summary }: { summary: CaptainSummary }) {
  const a = summary.agent
  const untitled = isUntitled(a)
  const current = a.captain?.title ?? ''
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])

  const start = () => { done.current = false; setValue(current); setError(null); setEditing(true) }
  const cancel = () => { done.current = true; setEditing(false); setError(null) }
  const save = async () => {
    if (done.current) return
    done.current = true
    const next = value.trim()
    if (next === current.trim()) { setEditing(false); return }
    const err = await patchCaptainField(a.id, { title: next || null })
    if (err) { done.current = false; setError(err); input.current?.focus(); return }
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="min-w-0 max-w-full flex-1 sm:max-w-md sm:flex-none sm:basis-[28rem]">
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } else if (e.key === 'Escape') { e.preventDefault(); cancel() } }}
          onBlur={() => void save()}
          placeholder="What is this captain working on?"
          aria-label="Captain title"
          aria-invalid={!!error}
          maxLength={120}
          data-testid="title-input"
          className={cn(TITLE, '-mx-2 h-8 w-[calc(100%+1rem)] min-w-0 rounded-md bg-transparent px-2 text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/50')}
        />
        {error && <p className="mt-1 text-[13px] text-bad">{error}</p>}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={start}
        aria-label={`Edit title: ${captainName(a)}`}
        data-testid="title"
        className={cn(TITLE, 'group/t -mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', untitled && 'text-muted-foreground')}
      >
        <span className="min-w-0 break-words sm:truncate">{captainName(a)}</span>
        {!untitled && <Pencil aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/t:opacity-100 group-focus-visible/t:opacity-100" />}
      </button>
      {untitled && (
        <button type="button" onClick={start} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          <TextCursorInput aria-hidden className="size-3.5" />
          Name this captain
        </button>
      )}
    </div>
  )
}

function StatusPill({ summary }: { summary: CaptainSummary }) {
  const s = summary.status
  return (
    <span
      data-testid="status-pill"
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
        s === 'working' && 'bg-ok/12 text-emerald-700 dark:text-emerald-300',
        s === 'attention' && 'bg-warn/15 text-amber-700 dark:text-amber-300',
        (s === 'idle' || s === 'archived') && 'bg-muted text-muted-foreground',
      )}
    >
      {s === 'working' || s === 'attention' ? <StatusGlyph status={s} /> : <StateDot state={s === 'idle' ? 'idle' : 'retired'} />}
      {statusLabel(summary)}
    </span>
  )
}

function RenameDialog({ summary, open, onOpenChange, onRenamed }: { summary: CaptainSummary; open: boolean; onOpenChange: (o: boolean) => void; onRenamed: () => void }) {
  const [name, setName] = useState(summary.agent.handle)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(summary.agent.handle); setError(null) } }, [open, summary.agent.handle])
  const submit = async () => {
    const next = name.trim().replace(/^@/, '')
    if (!next || next === summary.agent.handle) { onOpenChange(false); return }
    setBusy(true)
    const err = await patchCaptainField(summary.agent.id, { name: next })
    setBusy(false)
    if (err) { setError(err.replace(/^name:\s*/i, '')); return }
    onRenamed()
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename captain</DialogTitle>
          <DialogDescription>The handle other agents and the CLI use. Its team keeps working.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-1.5">
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-[13px] text-muted-foreground">@</span>
            <Input value={name.replace(/^@/, '')} onChange={(e) => { setName(e.target.value); setError(null) }} autoFocus aria-label="Handle" aria-invalid={!!error} spellCheck={false} className="h-9 pl-6 font-mono text-[13px]" />
          </div>
          {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
          <DialogFooter className="pt-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ResumeSplit({ summary, onRename }: { summary: CaptainSummary; onRename: () => void }) {
  const mode = resumeMode(summary)
  const [busy, setBusy] = useState(false)
  const archived = summary.status === 'archived'
  const Icon = mode === 'attach' ? Terminal : mode === 'resume' ? Play : Copy
  const go = async () => { setBusy(true); try { await resumeCaptain(summary) } finally { setBusy(false) } }
  return (
    <div className="flex shrink-0 items-center" data-testid="resume-split">
      <Button onClick={() => void go()} disabled={mode === 'none' || busy} className="h-9 rounded-r-none px-3 sm:h-8 max-sm:flex-1" data-testid="resume-primary">
        <Icon aria-hidden className="size-4" />
        {busy ? 'Resuming' : RESUME_LABEL[mode]}
      </Button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button aria-label="More actions" className="h-9 w-9 rounded-l-none border-l border-primary-foreground/20 px-0 sm:h-8 sm:w-8" data-testid="resume-menu">
                <ChevronDown aria-hidden className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem disabled={!summary.resume.command} onSelect={() => void copyText(summary.resume.command!, 'Resume command copied')}><Copy /> Copy resume command</DropdownMenuItem>
          <DropdownMenuItem disabled={!summary.resume.session_id} onSelect={() => void copyText(summary.resume.session_id!, 'Session id copied')}><Fingerprint /> Copy session id</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyText(summary.agent.cwd, 'Folder copied')}><Folder /> Copy folder</DropdownMenuItem>
          {summary.resume.attach && <DropdownMenuItem onSelect={() => void copyText(summary.resume.attach!, 'tmux attach line copied')}><Terminal /> Copy tmux attach</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRename}><Pencil /> Rename…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void setArchived(summary, !archived)}>{archived ? <ArchiveRestore /> : <Archive />} {archived ? 'Unarchive' : 'Archive'}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function Header({ summary, onRenamed }: { summary: CaptainSummary; onRenamed: () => void }) {
  const a = summary.agent
  const [renaming, setRenaming] = useState(false)
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <CaptainAvatar id={a.id} handle={a.handle} size="md" className="size-9 rounded-lg text-sm" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 pt-px">
        <TitleEdit summary={summary} />
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground" data-testid="handle">@{a.handle}</span>
        <StatusPill summary={summary} />
      </div>
      <div className="col-span-2 flex sm:col-span-1 sm:col-start-3 sm:row-start-1"><ResumeSplit summary={summary} onRename={() => setRenaming(true)} /></div>
      <RenameDialog summary={summary} open={renaming} onOpenChange={setRenaming} onRenamed={onRenamed} />
    </div>
  )
}
