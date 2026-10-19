// New captain dialog (§7.4): what it works on, where, optional handle and model. Errors the server names (`cwd:`, `name:`,
// `model:`) show under their field. Submit starts the captain in tmux, opens its page and offers the attach line.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { copyText } from '@/lib/captainActions'
import { effortAfterModelChange, effortChoice, modelOptions } from '@/lib/catalog'
import { captainName, tildePath } from '@/lib/captains'
import { captainHref, href, navigate } from '@/lib/route'
import { folderSuggestions, handlesOf, nextCaptainName, parseCreateError, type CreateField } from '@/lib/shell'
import { useShell } from '@/lib/shellUi'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const DEFAULT = '__default'

const FieldError = ({ id, text }: { id: string; text?: string }) => (text ? <p id={id} role="alert" className="text-[13px] text-destructive">{text}</p> : null)

/** Free-text folder with the project root and recent roots as suggestions (↑↓ Enter, Esc closes the list first). */
function FolderField({ value, onChange, options, open, setOpen, invalid, errId }: { value: string; onChange: (v: string) => void; options: string[]; open: boolean; setOpen: (o: boolean) => void; invalid: boolean; errId: string }) {
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const shown = open ? options : []
  useEffect(() => { setHi(0) }, [value])
  return (
    <div
      ref={ref}
      className="relative"
      onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node | null)) setOpen(false) }}
    >
      <FolderOpen className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        id="nc-cwd"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!shown.length) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(shown.length - 1, h + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); onChange(tildePath(shown[hi])); setOpen(false) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
        }}
        placeholder="~/code/my-project"
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-controls="nc-cwd-list"
        aria-invalid={invalid}
        aria-describedby={invalid ? errId : undefined}
        className="h-9 pl-8 font-mono text-[13px]"
      />
      {shown.length > 0 && (
        <ul id="nc-cwd-list" role="listbox" className="absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg bg-popover p-1 shadow-md ring-1 ring-foreground/10">
          {shown.map((p, i) => (
            <li
              key={p}
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => { e.preventDefault(); onChange(tildePath(p)); setOpen(false) }}
              onMouseEnter={() => setHi(i)}
              className={cn('flex h-8 cursor-default items-center rounded-md px-2 font-mono text-[12px] transition-colors', i === hi && 'bg-accent')}
            >
              <span className="truncate">{tildePath(p)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function NewCaptainDialog() {
  const open = useShell((s) => s.newOpen)
  const setNew = useShell((s) => s.setNew)
  const project = useStore((s) => s.project)
  const projects = useStore((s) => s.projects)
  const agents = useStore((s) => s.agents)
  const captains = useStore((s) => s.captains)
  const catalog = useStore((s) => s.catalogs.find((c) => c.harness === 'claude'))
  const root = projects.find((p) => p.id === project)?.root ?? null

  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState('')
  const [name, setName] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [err, setErr] = useState<{ field: CreateField | null; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [listOpen, setListOpen] = useState(false)

  const placeholder = useMemo(() => nextCaptainName(handlesOf(agents, captains)), [agents, captains])

  // Fresh form every time it opens; the folder starts at the project's root.
  useEffect(() => {
    if (!open) return
    setTitle(''); setName(''); setModel(null); setEffort(null); setMore(false); setErr(null); setBusy(false); setListOpen(false)
    setCwd(root ? tildePath(root) : '')
    api.captainRecent().then((list) => { setRecent(list); setCwd((c) => c || (list[0] ? tildePath(list[0]) : '')) }).catch(() => setRecent([]))
  }, [open, root])

  const options = useMemo(() => folderSuggestions(root, recent, cwd), [root, recent, cwd])
  const models = modelOptions(catalog, model).filter((m) => !m.hidden)
  const eff = effortChoice(catalog, model, effort)
  const fieldErr = (f: CreateField) => (err?.field === f ? err.text : undefined)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!title.trim()) return setErr({ field: 'title', text: 'Say what this captain works on, e.g. “Rate limiting for login”.' })
    if (!cwd.trim()) return setErr({ field: 'cwd', text: 'Give the folder the captain should start in.' })
    setBusy(true); setErr(null)
    try {
      const res = await api.startCaptain({
        cwd: cwd.trim(), title: title.trim(),
        ...(name.trim() ? { name: name.trim().replace(/^@/, '') } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      })
      await useStore.getState().loadCaptains()
      const made = res.agent_id ? useStore.getState().captains.find((c) => c.agent.id === res.agent_id) : undefined
      setNew(false)
      if (made) navigate(captainHref(made.agent.id, useStore.getState().project))
      else {
        void useStore.getState().loadProjects().catch(() => {})
        navigate(href({ page: 'captains', project: useStore.getState().project }))
      }
      toast.success(`Started @${made?.agent.handle ?? (name.trim() || placeholder)} in tmux`, {
        description: made ? captainName(made.agent) : title.trim(),
        action: { label: 'Copy tmux attach', onClick: () => void copyText(res.attach, 'tmux attach line copied') },
        duration: 8000,
      })
    } catch (e) {
      setErr(parseCreateError((e as Error).message))
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={setNew}>
      <DialogContent
        className="gap-5 p-5 sm:max-w-[480px]"
        showCloseButton={false}
        // Esc closes the folder list first; the dialog only on the next press.
        onEscapeKeyDown={(e) => { if (listOpen && options.length) e.preventDefault() }}
      >
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <DialogHeader className="gap-1">
            <DialogTitle className="text-base font-semibold tracking-tight">New captain</DialogTitle>
            <DialogDescription className="text-[13px]">Opens Claude Code in a tmux window with the captain skill. It hires the agents; you talk to it.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="nc-title">What is it working on?</Label>
            <Input
              id="nc-title" autoFocus value={title} placeholder="Rate limiting for login" maxLength={120} className="h-9"
              onChange={(e) => { setTitle(e.target.value); if (err?.field === 'title') setErr(null) }}
              aria-invalid={!!fieldErr('title')} aria-describedby="nc-title-err"
            />
            <FieldError id="nc-title-err" text={fieldErr('title')} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="nc-cwd">Folder</Label>
            <FolderField value={cwd} onChange={(v) => { setCwd(v); if (err?.field === 'cwd') setErr(null) }} options={options} open={listOpen} setOpen={setListOpen} invalid={!!fieldErr('cwd')} errId="nc-cwd-err" />
            <FieldError id="nc-cwd-err" text={fieldErr('cwd')} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="nc-name">Name <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-[13px] text-muted-foreground">@</span>
              <Input
                id="nc-name" value={name} placeholder={placeholder} spellCheck={false} autoComplete="off" className="h-9 pl-6 font-mono text-[13px]"
                onChange={(e) => { setName(e.target.value); if (err?.field === 'name') setErr(null) }}
                aria-invalid={!!fieldErr('name')} aria-describedby="nc-name-err"
              />
            </div>
            <FieldError id="nc-name-err" text={fieldErr('name')} />
          </div>

          <div className="grid gap-3">
            <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="flex w-fit items-center gap-1 rounded-md text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
              <ChevronRight className={cn('size-3.5 transition-transform duration-150', more && 'rotate-90')} /> Advanced
            </button>
            {more && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="nc-model">Model</Label>
                  <Select value={model ?? DEFAULT} onValueChange={(v) => { const m = v === DEFAULT ? null : v; setModel(m); setEffort((x) => effortAfterModelChange(catalog, m, x)); if (err?.field === 'model') setErr(null) }}>
                    <SelectTrigger id="nc-model" className="h-9 w-full" aria-invalid={!!fieldErr('model')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT}><span className="text-muted-foreground">Claude default</span></SelectItem>
                      {models.map((m) => <SelectItem key={m.value} value={m.value}>{m.value}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FieldError id="nc-model-err" text={fieldErr('model')} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="nc-effort">Effort</Label>
                  <Select value={effort ?? DEFAULT} disabled={eff.efforts.length === 0} onValueChange={(v) => setEffort(v === DEFAULT ? null : v)}>
                    <SelectTrigger id="nc-effort" className="h-9 w-full" aria-invalid={!!fieldErr('effort')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT}><span className="text-muted-foreground">Default</span></SelectItem>
                      {eff.efforts.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FieldError id="nc-effort-err" text={fieldErr('effort')} />
                </div>
              </div>
            )}
          </div>

          {err && !err.field && <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-[13px] text-destructive" data-testid="captain-error">{err.text}</p>}

          <DialogFooter className="mx-0 mb-0 gap-2 border-0 bg-transparent p-0 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => setNew(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Starting…' : 'Start captain'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
