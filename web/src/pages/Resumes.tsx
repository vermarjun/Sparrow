import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Copy, FlaskConical, Lock, Plus, Save, Trash2, TriangleAlert, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { DoctorCheck, HarnessName, ResumeView } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue, SelectGroup } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, HttpError } from '@/lib/api'
import {
  CHECK_DOT, HARNESSES, providerSummary, NEW_SLUG, STATUS_CHIP, resumeHref, stripField, effortAfterModelChange, effortChoice, errorField, harnessAvailability, modelGone, modelOptions, modelsLoading, slugError,
  type ResumeField,
} from '@/lib/catalog'
import { agoLabel, duration, plural } from '@/lib/format'
import { blank, fromView, type Form } from '@/lib/resumeForm'
import { skillChoices, toggleSkill } from '@/lib/skillMatrix'
import { renderResumeText } from '@/lib/resumeVars'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Empty, HarnessLabel, PathText, useNow } from '@/components/sparrow/bits'

const HARNESS_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
const DEFAULT = '__default'

const goto = (slug: string | null) => { location.hash = resumeHref(slug).slice(1) }

export function ResumesPage({ slug }: { slug: string | null }) {
  if (slug) return <ResumeEditor key={slug} slug={slug === NEW_SLUG ? null : slug} />
  return <ResumeList />
}

export function StatusChip({ resume }: { resume: Pick<ResumeView, 'status' | 'status_detail'> }) {
  const s = STATUS_CHIP[resume.status] ?? STATUS_CHIP.unchecked
  return (
    <span className={cn('inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium whitespace-nowrap', s.cls)} title={resume.status_detail ?? undefined} data-status={resume.status}>
      {s.label}
    </span>
  )
}

/** Shown next to the status chip while the resume's harness + provider is degraded (repeated provider errors). */
export function DegradedChip({ resume }: { resume: Pick<ResumeView, 'provider_health'> }) {
  const ph = resume.provider_health
  if (!ph?.degraded) return null
  return (
    <span className="inline-flex h-5 items-center rounded-full border border-amber-300 bg-amber-50 px-2 text-[11px] font-medium whitespace-nowrap text-amber-800" title={providerSummary(ph)} data-testid="degraded-chip">
      degraded · {ph.provider}
    </span>
  )
}

function ResumeList() {
  const resumes = useStore((s) => s.resumes)
  const rows = useMemo(() => Object.values(resumes).sort((a, b) => a.slug.localeCompare(b.slug)), [resumes])
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 px-4">
        <h1 className="text-sm font-semibold">Resumes</h1>
        <span className="text-xs text-muted-foreground">what a hire runs on: harness, model, effort and the role prompt · files in ~/.sparrow/resumes</span>
        <Button size="sm" className="ml-auto" onClick={() => goto(NEW_SLUG)} data-testid="new-resume"><Plus /> New resume</Button>
      </div>
      <div className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-xl border bg-background">
        {rows.length === 0 ? (
          <Empty title="No resumes" className="h-full">Create one with <b>New resume</b>, or run <code className="rounded bg-muted px-1">sparrow install</code> to copy the built-in set.</Empty>
        ) : (
          <Table className="text-[13px]">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="text-[11px] tracking-wide uppercase hover:bg-transparent">
                <TableHead className="h-8 pl-4">Resume</TableHead>
                <TableHead className="h-8">Harness</TableHead>
                <TableHead className="h-8">Model</TableHead>
                <TableHead className="h-8">Effort</TableHead>
                <TableHead className="h-8">Status</TableHead>
                <TableHead className="h-8 pr-4 text-right">Agents on an older copy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.slug} className="cursor-pointer" onClick={() => goto(r.slug)} data-resume={r.slug}>
                  <TableCell className="max-w-96 py-2 pl-4">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{r.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{r.slug}</span>
                      {r.builtin && <span className="rounded border px-1 text-[10px] text-muted-foreground" title="Served from assets/resumes; saving copies it to ~/.sparrow/resumes">built-in</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{renderResumeText(r.description, r)}</div>
                  </TableCell>
                  <TableCell className="py-2"><HarnessLabel harness={r.harness} /></TableCell>
                  <TableCell className="py-2">
                    <div className={cn('font-mono text-xs', r.status === 'model_gone' && 'text-amber-800 line-through decoration-amber-400')}>{r.model ?? <span className="font-sans text-muted-foreground">harness default</span>}</div>
                    {r.resolved_model && r.resolved_model !== r.model && <div className="font-mono text-[11px] text-muted-foreground">→ {r.resolved_model}</div>}
                  </TableCell>
                  <TableCell className="py-2 text-xs">{r.effort ?? <span className="text-muted-foreground">default</span>}</TableCell>
                  <TableCell className="max-w-72 py-2">
                    <div className="flex flex-wrap items-center gap-1"><StatusChip resume={r} /><DegradedChip resume={r} /></div>
                    {r.provider_health?.degraded && <div className="mt-0.5 line-clamp-2 text-[11px] text-amber-800">{providerSummary(r.provider_health)}</div>}
                    {r.status_detail && r.status !== 'ok' && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{r.status_detail}</div>}
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-right tabular-nums">
                    {r.stale_agents.length ? <span className="inline-flex h-5 items-center rounded-full border border-amber-200 bg-amber-50 px-2 text-[11px] font-medium text-amber-800">{plural(r.stale_agents.length, 'agent')}</span> : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- editor

const same = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b)

function ResumeEditor({ slug }: { slug: string | null }) {
  const creating = slug === null
  const resume = useStore((s) => (slug ? s.resumes[slug] : undefined))
  const resumes = useStore((s) => s.resumes)
  const catalogs = useStore((s) => s.catalogs)
  const health = useStore((s) => s.health)
  const agents = useStore((s) => s.agents)
  const [base, setBase] = useState<Form>(() => (resume ? fromView(resume) : blank()))
  const [form, setForm] = useState<Form>(base)
  const [baseHash, setBaseHash] = useState(resume?.hash ?? null)
  const [err, setErr] = useState<{ field: ResumeField | null; msg: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dupOpen, setDupOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const dirty = !same(form, base)

  // First load (resumes arrive after the route) and live updates from SSE: follow the server unless the user has edits.
  useEffect(() => {
    if (!resume || resume.hash === baseHash) return
    if (!dirty || baseHash === null) {
      const f = fromView(resume)
      setBase(f); setForm(f); setBaseHash(resume.hash)
    }
  }, [resume, baseHash, dirty])

  const catalog = catalogs.find((c) => c.harness === form.harness)
  const models = modelOptions(catalog, form.model)
  const hasHidden = models.some((m) => m.hidden)
  const effort = effortChoice(catalog, form.model, form.effort)
  const gone = modelGone(catalog, form.model)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); if (err?.field === k) setErr(null) }

  const fail = (e: unknown) => {
    const msg = (e as Error).message
    setErr({ field: e instanceof HttpError && e.status < 500 ? errorField(msg) : null, msg })
  }

  const save = async () => {
    if (creating) {
      const bad = slugError(form.slug)
      if (bad) return setErr({ field: 'slug', msg: bad })
    }
    setBusy('save'); setErr(null)
    try {
      const { slug: s, ...body } = form
      const v = creating ? await api.createResume({ ...body, slug: s }) : await api.updateResume(slug!, body)
      useStore.setState((st) => ({ resumes: { ...st.resumes, [v.slug]: v } }))
      const f = fromView(v)
      setBase(f); setForm(f); setBaseHash(v.hash)
      toast.success(creating ? `Created ${v.slug}` : `Saved ${v.slug}`)
      if (creating) goto(v.slug)
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const apply = async () => {
    if (!slug) return
    setBusy('apply')
    try {
      const { updated } = await api.applyResume(slug)
      toast.success(updated.length ? `Applied to ${plural(updated.length, 'agent')}; each gets the new resume with its next task` : 'No agents needed the update')
      void useStore.getState().loadResumes()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(null) }
  }

  const remove = async () => {
    if (!slug) return
    setBusy('delete')
    try {
      await api.deleteResume(slug)
      useStore.setState((st) => { const r = { ...st.resumes }; delete r[slug]; return { resumes: r } })
      toast.success(`Deleted ${slug}`)
      goto(null)
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(null); setDelOpen(false) }
  }

  const otherSlugs = Object.keys(resumes).filter((s) => s !== slug).sort()
  const skillsState = useStore((s) => s.skills)
  useEffect(() => { if (!useStore.getState().skills) void useStore.getState().loadSkills() }, [])
  const libraryNames = (skillsState?.library ?? []).filter((x) => !x.locked).map((x) => x.name)
  const lockedNames = (skillsState?.library ?? []).filter((x) => x.locked).map((x) => x.name)
  const choices = skillChoices(form.skills ?? [], libraryNames, lockedNames)
  const staleNames = (resume?.stale_agents ?? []).map((id) => agents[id] ? `@${agents[id].handle}` : id)
  const changedElsewhere = !!resume && baseHash !== null && resume.hash !== baseHash && dirty
  const deletedElsewhere = !creating && !resume && baseHash !== null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => goto(null)}><ArrowLeft /> Resumes</Button>
          <h1 className="text-sm font-semibold">{creating ? 'New resume' : form.title || slug}</h1>
          {!creating && <span className="font-mono text-xs text-muted-foreground">{slug}</span>}
          {resume && <StatusChip resume={resume} />}
          {resume && <DegradedChip resume={resume} />}
          {dirty && <span className="text-xs text-amber-700">unsaved changes</span>}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {!creating && (
              <>
                <Button variant="outline" size="sm" onClick={apply} disabled={!resume?.stale_agents.length || dirty || !!busy} title={dirty ? 'Save first' : staleNames.length ? `Update ${staleNames.join(', ')}` : 'Every agent already runs this copy'} data-testid="apply">
                  <Users /> Apply to {plural(resume?.stale_agents.length ?? 0, 'agent')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDupOpen(true)} disabled={!!busy}><Copy /> Duplicate</Button>
                <Button variant="destructive" size="sm" onClick={() => setDelOpen(true)} disabled={!!busy}><Trash2 /> Delete</Button>
              </>
            )}
            <Button size="sm" onClick={save} disabled={(!dirty && !creating) || !!busy} data-testid="save"><Save /> {busy === 'save' ? 'Saving…' : creating ? 'Create' : 'Save'}</Button>
          </div>
        </div>

        {changedElsewhere && (
          <Banner tone="warn">
            This resume was changed elsewhere while you were editing.{' '}
            <button className="font-medium underline" onClick={() => { const f = fromView(resume!); setBase(f); setForm(f); setBaseHash(resume!.hash) }}>Load the latest</button> (drops your edits) or save to overwrite it.
          </Banner>
        )}
        {deletedElsewhere && <Banner tone="bad">This resume was deleted elsewhere. Saving will fail; duplicate your text into a new resume.</Banner>}
        {err && !err.field && <Banner tone="bad" testid="save-error">{err.msg}</Banner>}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3 rounded-xl border bg-background p-4">
            {creating && (
              <Field id="slug" label="Slug" hint="file name; can't change later" err={err}>
                <Input id="slug" value={form.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} placeholder="builder-fast" className="font-mono" aria-invalid={err?.field === 'slug'} />
              </Field>
            )}
            <Field id="title" label="Title" err={err}>
              <Input id="title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Builder" aria-invalid={err?.field === 'title'} />
            </Field>
            <Field id="description" label="Description" hint="one line; shown to captains. Variables: {{harness}} {{model}} {{effort}} {{runtime}}" err={err}>
              <Input id="description" value={form.description} onChange={(e) => set('description', e.target.value)} />
            </Field>

            <Field id="harness" label="Harness" err={err}>
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Harness">
                {HARNESSES.map((h) => {
                  const av = harnessAvailability(h, catalogs, health)
                  const selected = form.harness === h
                  return (
                    <button
                      key={h} type="button" role="radio" aria-checked={selected} disabled={av.disabled && !selected} title={av.reason ?? undefined} data-harness={h} data-disabled={av.disabled || undefined}
                      onClick={() => { if (!selected) { setForm((f) => ({ ...f, harness: h as HarnessName, model: null, effort: null })); setErr(null) } }}
                      className={cn('flex h-9 items-center justify-center rounded-lg border text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        selected ? 'border-zinc-900 bg-zinc-900/[0.03] ring-1 ring-zinc-900' : 'hover:bg-muted', av.disabled && selected && 'border-red-300 ring-red-300')}
                    >
                      <HarnessLabel harness={h} />
                    </button>
                  )
                })}
              </div>
              {HARNESSES.map((h) => {
                const av = harnessAvailability(h, catalogs, health)
                if (!av.disabled && form.harness === h && modelsLoading(h, catalogs)) return <p key={h} className="text-[11px] text-muted-foreground" data-harness-loading={h}><b>{HARNESS_NAME[h]}</b>: loading models…</p>
                return av.disabled ? <p key={h} className={cn('text-[11px]', form.harness === h ? 'text-red-700' : 'text-muted-foreground')} data-harness-reason={h}><b>{HARNESS_NAME[h]}</b>: {av.reason}</p> : null
              })}
            </Field>

            <Field id="model" label="Model" err={err} hint={!catalog ? 'loading models…' : !catalog.ok ? 'model list unavailable' : undefined}>
              <Select value={form.model ?? DEFAULT} onValueChange={(v) => { const model = v === DEFAULT ? null : v; setForm((f) => ({ ...f, model, effort: effortAfterModelChange(catalog, model, f.effort) })); if (err?.field === 'model' || err?.field === 'effort') setErr(null) }}>
                <SelectTrigger id="model" className="w-full font-mono text-[13px]" aria-invalid={err?.field === 'model' || gone} data-testid="model-select"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={DEFAULT}><span className="font-sans text-muted-foreground">harness default</span></SelectItem>
                  {models.filter((m) => !m.hidden).map((m) => <ModelItem key={m.value} m={m} />)}
                  {hasHidden && (
                    <SelectGroup>
                      <SelectSeparator />
                      <SelectLabel className="text-[11px]">hidden by {form.harness}</SelectLabel>
                      {models.filter((m) => m.hidden).map((m) => <ModelItem key={m.value} m={m} />)}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
              {gone && (
                <p className="text-[11px] text-amber-800" data-testid="model-gone">
                  <b>model gone</b>: {form.model} is no longer offered by {form.harness}. Hires with it are refused; pick another model.
                </p>
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field id="effort" label="Effort" err={err}>
                <Select value={form.effort ?? DEFAULT} disabled={effort.disabled} onValueChange={(v) => set('effort', v === DEFAULT ? null : v)}>
                  <SelectTrigger id="effort" className="w-full" aria-invalid={err?.field === 'effort' || effort.invalid} data-testid="effort-select">
                    <SelectValue placeholder={effort.note ?? 'default'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT}><span className="text-muted-foreground">{effort.note === 'no effort levels' ? 'no effort levels' : 'default'}</span></SelectItem>
                    {form.effort && !effort.efforts.includes(form.effort) && <SelectItem value={form.effort}>{form.effort} (not accepted)</SelectItem>}
                    {effort.efforts.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                  </SelectContent>
                </Select>
                {effort.note && <p className="text-[11px] text-muted-foreground" data-testid="effort-note">{effort.note}</p>}
                {effort.invalid && err?.field !== 'effort' && <p className="text-[11px] text-amber-800">{form.effort} is not accepted by this model</p>}
              </Field>
              <Field id="limits" label="Limits (minutes)" err={err}>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="text-[11px] text-muted-foreground">quiet
                    <Input type="number" min={1} value={form.limits.quiet_minutes} onChange={(e) => set('limits', { ...form.limits, quiet_minutes: Number(e.target.value) })} className="h-8 tabular-nums" aria-label="quiet minutes" />
                  </label>
                  <label className="text-[11px] text-muted-foreground">max call
                    <Input type="number" min={1} value={form.limits.max_call_minutes} onChange={(e) => set('limits', { ...form.limits, max_call_minutes: Number(e.target.value) })} className="h-8 tabular-nums" aria-label="max call minutes" />
                  </label>
                </div>
              </Field>
            </div>

            <Field id="can_hire" label="Can hire" hint={form.can_hire.length ? plural(form.can_hire.length, 'resume') : 'nobody: a leaf agent'} err={err}>
              <div className="flex flex-wrap gap-1" data-testid="can-hire">
                {otherSlugs.concat(form.can_hire.filter((s) => !otherSlugs.includes(s))).map((s) => {
                  const on = form.can_hire.includes(s)
                  return (
                    <button key={s} type="button" aria-pressed={on} onClick={() => set('can_hire', on ? form.can_hire.filter((x) => x !== s) : [...form.can_hire, s])}
                      className={cn('h-6 rounded-full border px-2 font-mono text-[11px] transition-colors', on ? 'border-zinc-800 bg-zinc-800 text-white' : 'text-muted-foreground hover:bg-muted')}>
                      {s}
                    </button>
                  )
                })}
              </div>
            </Field>

            <Field id="skills" label="Skills" hint={(form.skills ?? []).length ? plural((form.skills ?? []).length, 'library skill') : 'Sparrow\'s own only'} err={err}>
              <div className="flex flex-wrap gap-1" data-testid="skills-field">
                {choices.locked.map((n) => (
                  <span key={n} className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed bg-muted/50 px-2 font-mono text-[11px] text-muted-foreground" title="Always on for every agent">
                    <Lock className="size-2.5" />{n}
                  </span>
                ))}
                {choices.available.map((n) => {
                  const on = (form.skills ?? []).includes(n)
                  return (
                    <button key={n} type="button" aria-pressed={on} onClick={() => set('skills', toggleSkill(form.skills ?? [], n))}
                      className={cn('h-6 rounded-full border px-2 font-mono text-[11px] transition-colors', on ? 'border-zinc-800 bg-zinc-800 text-white' : 'text-muted-foreground hover:bg-muted')}>
                      {n}
                    </button>
                  )
                })}
                {choices.missing.map((n) => (
                  <button key={n} type="button" aria-pressed onClick={() => set('skills', toggleSkill(form.skills ?? [], n))}
                    title="Not in the library: agents hired with it start without it. Click to remove."
                    className="inline-flex h-6 items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/15 px-2 font-mono text-[11px] text-amber-900 dark:text-amber-200">
                    <TriangleAlert className="size-2.5" />{n}
                  </button>
                ))}
                {!skillsState && <span className="text-[11px] text-muted-foreground">Loading the library…</span>}
              </div>
              <p className="text-[11px] text-muted-foreground">Takes effect for new hires. Agents already hired keep their skills until you press Apply.</p>
            </Field>

            {!creating && <TestPanel slug={slug!} dirty={dirty} />}
            {resume && (
              <div className="border-t pt-2 text-[11px] text-muted-foreground">
                <PathText path={resume.path} max={56} /> · hash <span className="font-mono">{resume.hash}</span>
                {staleNames.length > 0 && <div className="mt-0.5 text-amber-800">On an older copy: {staleNames.join(', ')}</div>}
              </div>
            )}
          </div>

          <Field id="body" label="Role prompt" hint="markdown; becomes the agent's system prompt. Variables: {{harness}} {{model}} {{effort}} {{runtime}}, filled in from the agent's actual settings" err={err} className="min-h-0">
            <Textarea id="body" value={form.body} onChange={(e) => set('body', e.target.value)} spellCheck={false} aria-invalid={err?.field === 'body'}
              className="min-h-[calc(100vh-11rem)] resize-y bg-background font-mono text-[12.5px] leading-relaxed" data-testid="body" />
          </Field>
        </div>
      </div>

      <DuplicateDialog open={dupOpen} onOpenChange={setDupOpen} from={slug} />
      <Dialog open={delOpen} onOpenChange={setDelOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {slug}?</DialogTitle>
            <DialogDescription>
              The file is removed{resume?.builtin ? ' and the built-in copy stays hidden' : ''}. Agents already hired keep running; new hires of <b>{slug}</b> are refused.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDelOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={remove} disabled={busy === 'delete'} data-testid="confirm-delete">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ModelItem({ m }: { m: ReturnType<typeof modelOptions>[number] }) {
  return (
    <SelectItem value={m.value} data-model={m.value}>
      <span className={cn(m.gone && 'text-amber-800')}>{m.label}</span>
      {m.hint && <span className={cn('font-sans text-[11px]', m.gone ? 'text-amber-700' : 'text-muted-foreground')}>{m.gone ? 'model gone' : m.hint}</span>}
    </SelectItem>
  )
}

function Field({ id, label, hint, err, children, className }: { id: ResumeField; label: string; hint?: string; err: { field: ResumeField | null; msg: string } | null; children: React.ReactNode; className?: string }) {
  const mine = err?.field === id ? stripField(err.msg, id) : null
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={id} className="text-xs">
        {label} {hint && <span className="font-normal text-muted-foreground">· {hint}</span>}
      </Label>
      {children}
      {mine && <p className="text-xs text-red-700" data-field-error={id}>{mine}</p>}
    </div>
  )
}

function Banner({ tone, children, testid }: { tone: 'warn' | 'bad'; children: React.ReactNode; testid?: string }) {
  return <div className={cn('rounded-lg px-3 py-2 text-xs ring-1', tone === 'bad' ? 'bg-red-50 text-red-800 ring-red-200' : 'bg-amber-50 text-amber-900 ring-amber-200')} data-testid={testid}>{children}</div>
}

function TestPanel({ slug, dirty }: { slug: string; dirty: boolean }) {
  const [check, setCheck] = useState<DoctorCheck | null>(null)
  const [starting, setStarting] = useState(false)
  const now = useNow(1000)
  const running = check?.status === 'running'

  useEffect(() => {
    let live = true
    api.resumeTest(slug).then((c) => live && setCheck(c)).catch(() => {})
    return () => { live = false }
  }, [slug])

  // Poll every 2 s while the round trip runs.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => { api.resumeTest(slug).then(setCheck).catch(() => {}) }, 2000)
    return () => clearInterval(t)
  }, [slug, running])

  const start = async () => {
    setStarting(true)
    try {
      setCheck((await api.testResume(slug)).check)
    } catch (e) { toast.error(`Could not start the test: ${(e as Error).message}`) } finally { setStarting(false) }
  }

  return (
    <div className="grid gap-1.5 rounded-lg bg-zinc-50 p-2.5 ring-1 ring-zinc-200" data-testid="test-panel" data-status={check?.status ?? 'none'}>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={start} disabled={running || starting || dirty} title={dirty ? 'Save first: the test runs the saved resume' : undefined} data-testid="test-resume">
          <FlaskConical /> {running ? 'Testing…' : 'Test this resume'}
        </Button>
        {check && (
          <span className="flex items-center gap-1.5 text-xs">
            <span className={cn('inline-block size-2 rounded-full', CHECK_DOT[check.status])} />
            <b className={cn(check.status === 'pass' && 'text-emerald-700', check.status === 'fail' && 'text-red-700')}>{check.status}</b>
            <span className="text-muted-foreground tabular-nums">
              {running ? duration(now - check.updated_at) : `${check.duration_ms != null ? duration(check.duration_ms) + ' · ' : ''}${agoLabel(check.updated_at, now)}`}
            </span>
          </span>
        )}
      </div>
      {!check && <p className="text-[11px] text-muted-foreground">Hires a throwaway agent with exactly this harness, model and effort, waits for it to report, and closes it.</p>}
      {check?.detail && <p className="text-[11px] break-words text-zinc-700">{check.detail}</p>}
      {check?.fix && check.status === 'fail' && <code className="rounded bg-background px-1.5 py-1 font-mono text-[11px] text-zinc-800 ring-1 ring-red-200">{check.fix}</code>}
    </div>
  )
}

function DuplicateDialog({ open, onOpenChange, from }: { open: boolean; onOpenChange: (o: boolean) => void; from: string | null }) {
  const [to, setTo] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open && from) { setTo(`${from}-copy`.slice(0, 32)); setErr(null) } }, [open, from])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!from) return
    const bad = slugError(to)
    if (bad) return setErr(bad)
    setBusy(true)
    try {
      const v = await api.duplicateResume(from, to)
      useStore.setState((st) => ({ resumes: { ...st.resumes, [v.slug]: v } }))
      onOpenChange(false)
      goto(v.slug)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Duplicate {from}</DialogTitle>
            <DialogDescription>Copies every field into a new resume file. Agents on {from} are not affected.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="dup-slug">New slug</Label>
            <Input id="dup-slug" autoFocus value={to} onChange={(e) => { setTo(e.target.value.toLowerCase()); setErr(null) }} className="font-mono" aria-invalid={!!err} />
            {err && <p className="text-xs text-red-700">{err}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>Duplicate</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function OlderResumeBadge() {
  return <span className="inline-flex h-5 items-center rounded-full border border-amber-200 bg-amber-50 px-2 text-[11px] font-medium text-amber-800" title="Hired from an older copy of its resume. Open the resume and use Apply to update it.">older resume</span>
}
