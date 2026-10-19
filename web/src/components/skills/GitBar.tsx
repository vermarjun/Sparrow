import { useState } from 'react'
import { ArrowDownToLine, GitBranch, GitCommitHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { gitActions, gitSummary, type GitAction, type GitState } from '@/lib/skills'
import { useStore } from '@/lib/store'

/** A button that stays hoverable when disabled so the reason can show. */
function ActionButton({ action, children, ...props }: { action: GitAction; children: React.ReactNode } & React.ComponentProps<typeof Button>) {
  const btn = (
    <span className="inline-flex">
      <Button {...props} disabled={action.disabled || props.disabled}>{children}</Button>
    </span>
  )
  if (!action.reason) return btn
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{action.reason}</TooltipContent>
    </Tooltip>
  )
}

export function GitBar({ git }: { git: GitState }) {
  const [pulling, setPulling] = useState(false)
  const [open, setOpen] = useState(false)
  const actions = gitActions(git)
  const parts = gitSummary(git)

  const pull = async () => {
    setPulling(true)
    try {
      const r = await api.pullSkills()
      toast.success(/up to date/i.test(r.output) ? 'Already up to date' : 'Pulled from origin')
      await useStore.getState().loadSkills()
    } catch (e) {
      toast.error(`Pull failed: ${(e as Error).message}`)
    } finally { setPulling(false) }
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="git-bar">
      <GitBranch className="size-3.5" />
      <span data-testid="git-summary" className="flex items-center gap-1.5">
        {git.available ? parts.map((p, i) => <span key={p} className={i === 0 ? 'font-mono text-foreground' : undefined}>{i > 0 && '· '}{p}</span>) : 'no git repository'}
      </span>
      <ActionButton action={actions.pull} variant="outline" size="sm" onClick={() => void pull()} disabled={pulling} data-testid="git-pull">
        <ArrowDownToLine /> {pulling ? 'Pulling…' : 'Pull'}
      </ActionButton>
      <ActionButton action={actions.commit} size="sm" onClick={() => setOpen(true)} data-testid="git-commit">
        <GitCommitHorizontal /> Commit &amp; push
      </ActionButton>
      <CommitDialog open={open} onOpenChange={setOpen} git={git} />
    </div>
  )
}

function CommitDialog({ open, onOpenChange, git }: { open: boolean; onOpenChange: (o: boolean) => void; git: GitState }) {
  const [message, setMessage] = useState('skills: update library')
  const [busy, setBusy] = useState(false)
  const files = git.dirty.slice(0, 12)
  const go = async () => {
    setBusy(true)
    try {
      await api.commitSkills(message.trim(), true)
      toast.success(git.dirty.length ? 'Committed and pushed to origin' : 'Pushed to origin')
      await useStore.getState().loadSkills()
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
      void useStore.getState().loadSkills()
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Commit &amp; push</DialogTitle>
          <DialogDescription>
            Commits every change in the library and pushes <span className="font-mono">{git.branch ?? 'HEAD'}</span> to its own origin
            {git.remote && <> (<span className="font-mono break-all">{git.remote}</span>)</>}.
          </DialogDescription>
        </DialogHeader>
        {git.dirty.length > 0 ? (
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11.5px]" data-testid="commit-files">
            {files.map((f) => <div key={f}>{f}</div>)}
            {git.dirty.length > files.length && <div className="text-muted-foreground">… and {git.dirty.length - files.length} more</div>}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No uncommitted changes: this pushes the {git.ahead} unpushed commit{git.ahead === 1 ? '' : 's'}.</div>
        )}
        <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Commit message" aria-label="Commit message" data-testid="commit-message" />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void go()} disabled={busy || !message.trim()} data-testid="commit-confirm">
            {busy ? 'Pushing…' : 'Commit & push'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
