import { useEffect, useRef, useState } from 'react'
import { AlertCircle, FileArchive, FileUp, LoaderCircle, Link2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { executionWarning, freshAddState, HARNESS_NAME, HARNESS_ORDER, stagedGone, type Harness, type StagedImport, type StagedSkill } from '@/lib/skills'
import { cn } from '@/lib/utils'

type Mode = 'create' | 'upload' | 'link'

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function HarnessChoices({ value, onChange }: { value: Harness[]; onChange: (next: Harness[]) => void }) {
  const toggle = (harness: Harness) => onChange(
    value.includes(harness) ? value.filter((item) => item !== harness) : HARNESS_ORDER.filter((item) => item === harness || value.includes(item)),
  )
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted-foreground">Link installed skills into</legend>
      <div className="flex flex-wrap gap-2">
        {HARNESS_ORDER.map((harness) => (
          <label key={harness} className={cn(
            'inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors',
            value.includes(harness) ? 'border-foreground/25 bg-muted text-foreground' : 'border-border text-muted-foreground hover:bg-muted/50',
          )}>
            <input type="checkbox" checked={value.includes(harness)} onChange={() => toggle(harness)} className="size-3.5 accent-foreground" />
            {HARNESS_NAME[harness]}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function SkillPreview({
  skill, checked, onToggle,
}: { skill: StagedSkill; checked: boolean; onToggle: () => void }) {
  const invalid = skill.problems.length > 0
  const warning = executionWarning(skill)
  return (
    <section className="rounded-lg border bg-background" data-preview-skill={skill.name}>
      <div className="flex items-start gap-3 p-3">
        <input
          type="checkbox" checked={checked && !invalid} onChange={onToggle} disabled={invalid}
          aria-label={`Import ${skill.name}`} className="mt-0.5 size-4 accent-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{skill.name}</h3>
            <span className="text-[11px] text-muted-foreground">{skill.files.length} file{skill.files.length === 1 ? '' : 's'}</span>
            {warning && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-900 dark:text-amber-200">{warning.files.length} code-risk file{warning.files.length === 1 ? '' : 's'}</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{skill.description || 'No description'}</p>
          {!!skill.warnings?.length && <ul className="mt-2 list-disc pl-4 text-xs text-amber-800 dark:text-amber-200" data-testid="skill-warnings">{skill.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          {invalid && <ul className="mt-2 list-disc pl-4 text-xs text-destructive">{skill.problems.map((problem) => <li key={`${problem.code}:${problem.message}`}>{problem.message}</li>)}</ul>}
        </div>
      </div>
      {warning && <aside role="note" data-testid="execution-warning" className="mx-3 mb-3 rounded-lg border border-amber-600/40 bg-amber-50 px-3 py-2.5 text-xs text-amber-950 dark:border-amber-400/40 dark:bg-amber-950/45 dark:text-amber-100">
        <p className="font-semibold">{warning.message}</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 font-mono text-[11px]">
          {warning.files.map((file) => <li key={file.path} className="break-all">{file.path} <span className="font-sans">({file.reasons.join(', ')})</span></li>)}
        </ul>
      </aside>}
      <details open className="border-t px-3 py-2 text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground">Review files ({skill.files.length}){skill.scripts.length ? ` · scripts: ${skill.scripts.join(', ')}` : ''}</summary>
        <ul className="mt-2 max-h-32 space-y-1 overflow-auto font-mono text-[11px] text-muted-foreground">
          {skill.files.map((file) => {
            const script = skill.scriptDetails.find((item) => item.path === file.path)
            return <li key={file.path} className="flex items-start justify-between gap-3">
              <span className="break-all">{file.path}{skill.scripts.includes(file.path) && <span className="ml-2 font-sans text-amber-700 dark:text-amber-300">script</span>}
                {script && <span className="ml-2 font-sans text-amber-700 dark:text-amber-300">
                  [{script.executable ? 'executable' : 'not executable'}{script.shebang ? ` · ${script.shebang}` : ''}]
                </span>}
              </span>
              <span className="shrink-0 font-sans">{sizeLabel(file.size)}</span>
            </li>
          })}
        </ul>
      </details>
    </section>
  )
}

export function AddSkillDialog({
  open, onOpenChange, onComplete,
}: { open: boolean; onOpenChange: (open: boolean) => void; onComplete: () => void }) {
  const folderInput = useRef<HTMLInputElement>(null)
  const zipInput = useRef<HTMLInputElement>(null)
  const fresh = freshAddState()
  const [mode, setMode] = useState<Mode>(fresh.mode)
  const [name, setName] = useState(fresh.name)
  const [description, setDescription] = useState(fresh.description)
  const [source, setSource] = useState(fresh.source)
  const [harnesses, setHarnesses] = useState<Harness[]>(fresh.harnesses)
  const [staged, setStaged] = useState<StagedImport | null>(fresh.staged)
  const [selected, setSelected] = useState<string[]>(fresh.selected)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(fresh.error)

  const reset = () => {
    const next = freshAddState()
    setMode(next.mode)
    setName(next.name)
    setDescription(next.description)
    setSource(next.source)
    setHarnesses(next.harnesses)
    setStaged(next.staged)
    setSelected(next.selected)
    setError(next.error)
  }

  // Every open and every close starts clean. Closing from inside (after an import, Cancel) goes through
  // onOpenChange directly, not through Radix, so the state is reset here on the `open` flag itself: a staged
  // import is consumed by importing, and reopening with its id would answer "staged import has expired".
  useEffect(reset, [open])

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const fail = (e: unknown) => {
    const message = (e as Error).message
    if (stagedGone(message)) { setStaged(null); setSelected([]) }
    setError(message)
  }

  const acceptPreview = (next: StagedImport) => {
    setStaged(next)
    setSelected(next.skills.filter((skill) => skill.problems.length === 0).map((skill) => skill.name))
    setError(null)
  }

  const previewFiles = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      for (const file of files) {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
        form.append('files', file, relative || file.name)
      }
      acceptPreview((await api.uploadSkills(form)).staged)
    } catch (e) {
      setError((e as Error).message)
    } finally { setBusy(false) }
  }

  const previewLink = async () => {
    setBusy(true)
    setError(null)
    setStaged(null)
    try { acceptPreview((await api.previewSkillSource(source.trim())).staged) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.createSkill({ name, description, harnesses })
      toast.success(`Created ${name.trim()}`)
      onComplete()
      handleOpenChange(false)
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  const importSelected = async () => {
    if (!staged || !selected.length) return
    setBusy(true)
    setError(null)
    try {
      await api.importSkills(staged.id, selected, harnesses)
      toast.success(`Imported ${selected.length} skill${selected.length === 1 ? '' : 's'}`)
      onComplete()
      handleOpenChange(false)
    } catch (e) { fail(e) }
    finally { setBusy(false) }
  }

  const toggleSkill = (skill: StagedSkill) => setSelected((current) =>
    current.includes(skill.name) ? current.filter((name) => name !== skill.name) : [...current, skill.name],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-3xl" data-testid="add-skill-dialog">
        <div className="shrink-0 space-y-4">
          <DialogHeader>
            <DialogTitle>Add a skill</DialogTitle>
            <DialogDescription>Create a starter skill or stage skills from a folder, ZIP, or Git source. Review the files and scripts before importing.</DialogDescription>
          </DialogHeader>

          <Tabs value={mode} onValueChange={(value) => { setMode(value as Mode); setError(null) }}>
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="create">Create</TabsTrigger>
              <TabsTrigger value="upload">Upload folder / ZIP</TabsTrigger>
              <TabsTrigger value="link">From link</TabsTrigger>
            </TabsList>
          </Tabs>

          {error && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {mode === 'create' ? (
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_15rem]">
              <div className="space-y-4">
                <div className="space-y-2"><Label htmlFor="new-skill-name">Name</Label><Input id="new-skill-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="meeting-notes" autoFocus /></div>
                <div className="space-y-2"><Label htmlFor="new-skill-description">Description</Label><Textarea id="new-skill-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this skill helps an agent do." rows={3} /></div>
              </div>
              <HarnessChoices value={harnesses} onChange={setHarnesses} />
            </div>
          ) : mode === 'upload' ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-dashed bg-muted/25 p-4 text-center">
                <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-background shadow-sm"><FileUp className="size-4 text-muted-foreground" /></div>
                <h3 className="mt-2 text-sm font-medium">Choose a skill folder or one ZIP</h3>
                <p className="mt-1 text-xs text-muted-foreground">The upload is staged for review. Scripts are listed for you and never run.</p>
                <p className="mt-1 text-xs text-muted-foreground">Browser folder selection does not expose POSIX executable bits, so those files are treated as non-executable. ZIP uploads preserve supplied mode metadata.</p>
                <div className="mt-3 flex justify-center gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => folderInput.current?.click()}><FileUp />Choose folder</Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => zipInput.current?.click()}><FileArchive />Choose ZIP</Button>
                </div>
                <input ref={folderInput} type="file" multiple className="sr-only" {...({ webkitdirectory: '', directory: '' } as any)} onChange={(e) => { void previewFiles(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = '' }} />
                <input ref={zipInput} type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => { void previewFiles(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = '' }} />
              </div>
              {staged && <StagedReview staged={staged} selected={selected} onToggle={toggleSkill} harnesses={harnesses} onHarnessesChange={setHarnesses} />}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1"><Link2 className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void previewLink() } }} placeholder="owner/repo, Git URL, or ~/path" className="pl-9" aria-label="Git or local source" /></div>
                <Button type="button" variant="outline" disabled={busy || !source.trim()} onClick={() => void previewLink()}>{busy ? <LoaderCircle className="animate-spin" /> : <Link2 />}Preview</Button>
              </div>
              <p className="text-xs text-muted-foreground">Git sources are cloned into Sparrow staging. Local folders are copied there for review.</p>
              {staged && <StagedReview staged={staged} selected={selected} onToggle={toggleSkill} harnesses={harnesses} onHarnessesChange={setHarnesses} />}
            </div>
          )}
        </div>

        <div className="shrink-0">
          {mode === 'create' ? (
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button type="button" disabled={busy || !name.trim() || !description.trim()} onClick={() => void create()}>{busy ? <LoaderCircle className="animate-spin" /> : <Plus />}Create skill</Button>
            </DialogFooter>
          ) : staged ? (
            <DialogFooter>
              <div className="mr-auto text-xs text-muted-foreground">{selected.length} selected · {harnesses.length} harness{harnesses.length === 1 ? '' : 'es'}</div>
              <Button variant="outline" type="button" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button type="button" disabled={busy || !selected.length} onClick={() => void importSelected()}>{busy ? <LoaderCircle className="animate-spin" /> : <Plus />}Import selected</Button>
            </DialogFooter>
          ) : (
            <DialogFooter><Button variant="outline" type="button" onClick={() => handleOpenChange(false)}>Close</Button></DialogFooter>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StagedReview({
  staged, selected, onToggle, harnesses, onHarnessesChange,
}: { staged: StagedImport; selected: string[]; onToggle: (skill: StagedSkill) => void; harnesses: Harness[]; onHarnessesChange: (next: Harness[]) => void }) {
  return (
    <div className="space-y-3" data-testid="staged-review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-sm font-medium">Review staged skills</h3><p className="text-xs text-muted-foreground">{staged.source?.source ?? 'Uploaded folder or ZIP'} · {staged.skills.length} found</p></div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onHarnessesChange(harnesses.length === HARNESS_ORDER.length ? [] : [...HARNESS_ORDER])}>{harnesses.length === HARNESS_ORDER.length ? 'Clear harnesses' : 'All harnesses'}</Button>
      </div>
      {(staged.problems?.length || staged.notices?.length) ? <div className="space-y-1 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        {staged.problems?.map((problem) => <p key={`${problem.code}:${problem.message}`}>{problem.message}</p>)}
        {staged.notices?.map((notice) => <p key={notice}>{notice}</p>)}
      </div> : null}
      <HarnessChoices value={harnesses} onChange={onHarnessesChange} />
      <div className="max-h-[38vh] space-y-2 overflow-auto pr-1">
        {staged.skills.map((skill, index) => <SkillPreview key={`${index}:${skill.name}:${skill.files.map((file) => file.path).join('|')}`} skill={skill} checked={selected.includes(skill.name)} onToggle={() => onToggle(skill)} />)}
      </div>
    </div>
  )
}
