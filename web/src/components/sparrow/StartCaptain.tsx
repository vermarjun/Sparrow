import { useEffect, useState } from 'react'
import { FolderOpen, Rocket } from 'lucide-react'
import type { CaptainStartRes } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { effortAfterModelChange, effortChoice, modelOptions } from '@/lib/catalog'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CopyButton } from './bits'

const DEFAULT = '__default'
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

/** Header button + dialog: start the user's own Claude captain session in a tmux window. */
export function StartCaptainButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)} data-testid="start-captain"><Rocket /> Start captain</Button>
      <StartCaptainDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

export function StartCaptainDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const catalog = useStore((s) => s.catalogs.find((c) => c.harness === 'claude'))
  const [cwd, setCwd] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<CaptainStartRes | null>(null)

  useEffect(() => {
    if (!open) return
    setRes(null); setErr(null)
    api.captainRecent().then((list) => { setRecent(list); setCwd((c) => c || (list[0] ? tilde(list[0]) : '')) }).catch(() => setRecent([]))
  }, [open])

  const models = modelOptions(catalog, model).filter((m) => !m.hidden)
  const eff = effortChoice(catalog, model, effort)
  const q = cwd.trim().toLowerCase()
  // Filter as the user types; a value picked from the list (or prefilled) shows them all.
  const picked = recent.some((r) => tilde(r).toLowerCase() === q || r.toLowerCase() === q)
  const suggestions = recent.filter((r) => picked || !q || r.toLowerCase().includes(q.replace(/^~/, ''))).slice(0, 6)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!cwd.trim()) return setErr('Give the folder the captain should start in.')
    setBusy(true); setErr(null)
    try {
      setRes(await api.startCaptain({ cwd: cwd.trim(), model, effort }))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {res ? (
          <div className="grid gap-4" data-testid="captain-started">
            <DialogHeader>
              <DialogTitle>Captain started</DialogTitle>
              <DialogDescription>Claude Code is open in tmux window <b>{res.session}:{res.window}</b> ({res.window_id}) in <span className="font-mono">{tilde(res.cwd)}</span>. Attach from a terminal:</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-1 rounded-lg bg-[#16181d] py-2 pr-1.5 pl-3">
              <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all text-zinc-100" data-testid="attach">{res.attach}</code>
              <CopyButton text={res.attach} label="Copy attach command" className="text-zinc-300 hover:bg-white/10 hover:text-white" />
            </div>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Start a captain</DialogTitle>
              <DialogDescription>Opens your own Claude Code session in a tmux window, with the Sparrow captain skill. You talk to it; it hires the agents.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="cap-cwd">Folder</Label>
              <Input id="cap-cwd" autoFocus value={cwd} onChange={(e) => { setCwd(e.target.value); setErr(null) }} placeholder="~/code/my-project" className="font-mono" aria-invalid={!!err} />
              {suggestions.length > 0 && (
                <div className="grid gap-0.5" data-testid="recent">
                  <span className="text-[11px] text-muted-foreground">Recent projects</span>
                  {suggestions.map((r) => (
                    <button key={r} type="button" onClick={() => { setCwd(tilde(r)); setErr(null) }}
                      className={cn('flex items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-muted', tilde(r) === cwd.trim() && 'bg-muted')}>
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /> {tilde(r)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="cap-model">Model <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Select value={model ?? DEFAULT} onValueChange={(v) => { const m = v === DEFAULT ? null : v; setModel(m); setEffort((e) => effortAfterModelChange(catalog, m, e)) }}>
                  <SelectTrigger id="cap-model" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT}><span className="text-muted-foreground">Claude default</span></SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        <span>{m.value}</span>{m.hint && <span className="text-[11px] text-muted-foreground">{m.hint}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cap-effort">Effort <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Select value={effort ?? DEFAULT} disabled={eff.efforts.length === 0} onValueChange={(v) => setEffort(v === DEFAULT ? null : v)}>
                  <SelectTrigger id="cap-effort" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT}><span className="text-muted-foreground">default</span></SelectItem>
                    {eff.efforts.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {!catalog && <p className="text-xs text-muted-foreground">loading models…</p>}
            {catalog && !catalog.ok && <p className="text-xs text-amber-800">Claude's model list failed to load ({catalog.error}); the captain starts with Claude's default model.</p>}
            {err && <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800 ring-1 ring-red-200" data-testid="captain-error">{err}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}><Rocket /> {busy ? 'Starting…' : 'Start captain'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
