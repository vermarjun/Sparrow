import { useCallback, useEffect, useState } from 'react'
import { Lock, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { resumeHref } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { changeNote, warningRows, type SkillMatrix } from '@/lib/skillMatrix'
import { skillsHref, type SkillsState } from '@/lib/skills'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Empty, HarnessLabel } from '@/components/sparrow/bits'

/** Rows = skills, columns = resumes. A switch edits that resume's `skills:` through the normal resume save. */
export function MatrixView({ state }: { state: SkillsState }) {
  const rev = useStore((s) => s.skillsRev)
  const resumes = useStore((s) => s.resumes)
  const [m, setM] = useState<SkillMatrix | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; slug: string } | null>(null)

  const load = useCallback(async () => {
    try { setM(await api.skillsMatrix()); setError(null) } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => {
    let live = true
    api.skillsMatrix().then((x) => { if (live) { setM(x); setError(null) } }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [rev, resumes])

  if (!m) return error ? <Empty title="Could not load the matrix" className="h-full">{error}</Empty> : <div className="px-4 text-xs text-muted-foreground">Loading…</div>
  const warnings = warningRows(m)
  const descriptions = new Map(state.library.map((s) => [s.name, s.description]))

  const toggle = async (slug: string, skill: string) => {
    const key = `${slug}:${skill}`
    setBusy(key)
    try {
      const row = m.resumes.find((r) => r.slug === slug)
      const on = !(row?.skills ?? []).includes(skill) // what the person sees is what they asked for
      const { resume: v } = await api.setMatrixSkill(slug, skill, on) // the server does the read-modify-write
      useStore.setState((st) => ({ resumes: { ...st.resumes, [v.slug]: v } }))
      setNote({ text: changeNote(v.title, skill, on, row?.hired ?? 0), slug })
      await load()
    } catch (e) {
      toast.error(`Could not save ${slug}: ${(e as Error).message}`)
    } finally { setBusy(null) }
  }

  const cell = (slug: string, title: string, skill: string, on: boolean, locked = false) => (
    <TableCell key={slug} className="py-1.5 text-center">
      <Switch
        checked={on} disabled={locked || busy !== null} onCheckedChange={() => void toggle(slug, skill)}
        aria-label={`${skill} for ${title}`} data-testid={`cell-${slug}-${skill}`} className="mx-auto"
      />
    </TableCell>
  )

  if (m.resumes.length === 0) return <Empty title="No resumes" className="h-full">Create a resume first; its Skills are chosen here or in the resume editor.</Empty>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-4 pb-2 text-xs text-muted-foreground">
        {plural(m.skills.length, 'library skill')} × {plural(m.resumes.length, 'resume')} · a switch edits that resume's <span className="font-mono">skills:</span>; Sparrow's own two are always on
      </div>
      {note && (
        <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-xs" role="status" data-testid="matrix-note">
          <span className="min-w-0 flex-1">{note.text}</span>
          <a href={resumeHref(note.slug)} className="shrink-0 font-medium underline" data-testid="matrix-note-link">Resume / Apply</a>
          <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {/* this div is the one scroller, so the sticky header row and skill column work (the Table wrapper would swallow them) */}
      <div className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-xl border bg-background [&_[data-slot=table-container]]:overflow-visible" data-testid="matrix">
        <Table className="text-[13px]">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="hover:bg-transparent">
              <TableHead className="sticky left-0 z-20 h-auto min-w-56 bg-background py-2 pl-4 text-[11px] tracking-wide uppercase">Skill</TableHead>
              {m.resumes.map((r) => (
                <TableHead key={r.slug} className="h-auto min-w-28 py-2 text-center align-bottom" data-resume={r.slug}>
                  <a href={resumeHref(r.slug)} className="block truncate text-[13px] font-medium text-foreground hover:underline" title={r.slug}>{r.title}</a>
                  <HarnessLabel harness={r.harness} className="justify-center" />
                  <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                    {r.hired ? plural(r.hired, 'hired agent') : 'none hired'}
                    {r.stale > 0 && (
                      <a href={resumeHref(r.slug)} className="ml-1 text-amber-700 underline dark:text-amber-300" title="These agents were hired from an older copy of the resume: open it and press Apply">
                        · {r.stale} on an older copy
                      </a>
                    )}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {m.locked.map((name) => (
              <TableRow key={name} className="bg-muted/30" data-skill={name} data-locked="true">
                <TableCell className="sticky left-0 bg-muted py-1.5 pl-4">
                  <div className="flex items-center gap-1.5 font-medium"><Lock className="size-3 text-muted-foreground" />{name}<span className="text-[11px] font-normal text-muted-foreground">always on</span></div>
                </TableCell>
                {m.resumes.map((r) => (
                  <TableCell key={r.slug} className="py-1.5 text-center"><Switch checked disabled aria-label={`${name} for ${r.title} (always on)`} className="mx-auto" /></TableCell>
                ))}
              </TableRow>
            ))}
            {m.skills.map((name) => (
              <TableRow key={name} data-skill={name}>
                <TableCell className="sticky left-0 max-w-72 bg-background py-1.5 pl-4 whitespace-normal">
                  <a href={skillsHref(name)} className="font-medium hover:underline">{name}</a>
                  <div className="line-clamp-1 text-xs text-muted-foreground">{descriptions.get(name) ?? ''}</div>
                </TableCell>
                {m.resumes.map((r) => cell(r.slug, r.title, name, r.skills.includes(name)))}
              </TableRow>
            ))}
            {m.skills.length === 0 && (
              <TableRow className="hover:bg-transparent"><TableCell colSpan={m.resumes.length + 1} className="py-4 pl-4 text-xs text-muted-foreground">The library has no skills yet: adopt some from the Unmanaged and External tabs.</TableCell></TableRow>
            )}
            {warnings.map((name) => (
              <TableRow key={name} className="bg-amber-500/10 hover:bg-amber-500/15" data-skill={name} data-warning="missing">
                <TableCell className="sticky left-0 bg-amber-50 py-1.5 pl-4 whitespace-normal dark:bg-amber-950">
                  <div className="flex items-center gap-1.5 font-medium">
                    <TriangleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />{name}
                  </div>
                  <div className="text-xs text-amber-800 dark:text-amber-300">not in the library: agents hired with it start without it. Untick to remove.</div>
                </TableCell>
                {m.resumes.map((r) => r.skills.includes(name)
                  ? cell(r.slug, r.title, name, true)
                  : <TableCell key={r.slug} className={cn('py-1.5')} />)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
