import { useEffect, useState } from 'react'
import { FolderInput, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { tilde, viewCounts, type SkillsView } from '@/lib/skills'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Empty } from '@/components/sparrow/bits'
import { GitBar } from '@/components/skills/GitBar'
import { LibraryView } from '@/components/skills/Library'
import { ConflictsView, ExternalView, UnmanagedView } from '@/components/skills/Lists'
import { MatrixView } from '@/components/skills/Matrix'
import { SkillDetailPage } from '@/components/skills/Detail'
import { AddSkillDialog } from '@/components/skills/AddSkillDialog'
import { MigrateWizard } from '@/components/skills/MigrateWizard'
import { offerMigration } from '@/lib/migration'

export function SkillsPage({ name }: { name: string | null }) {
  const state = useStore((s) => s.skills)
  const error = useStore((s) => s.skillsError)
  const [view, setView] = useState<SkillsView>('library')
  const [initing, setIniting] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [migrateOpen, setMigrateOpen] = useState(false)
  // Stays offered after a run so the result (and Roll back) is reachable until the page is left.
  const [migrated, setMigrated] = useState(false)

  useEffect(() => { void useStore.getState().loadSkills() }, [])

  const counts = viewCounts(state)
  // The Conflicts tab only exists while there is something to settle; fall back if the last one was resolved.
  const active: SkillsView = view === 'conflicts' && counts.conflicts === 0 ? 'library' : view

  if (!state) {
    return error
      ? <Empty title="Could not load skills" className="h-full">{error}</Empty>
      : <div className="p-4 text-xs text-muted-foreground">Loading skills…</div>
  }
  if (name) return <SkillDetailPage key={name} name={name} home={state.paths.home} />

  const init = async () => {
    setIniting(true)
    try {
      await api.initSkillsLibrary()
      toast.success('Skills library created')
      await useStore.getState().loadSkills()
    } catch (e) {
      toast.error(`Could not create the library: ${(e as Error).message}`)
    } finally { setIniting(false) }
  }

  const tabs: { id: SkillsView; label: string; count?: number }[] = [
    { id: 'library', label: 'Library' },
    { id: 'matrix', label: 'Agent matrix' },
    { id: 'unmanaged', label: 'Unmanaged', count: counts.unmanaged },
    { id: 'external', label: 'External', count: counts.external },
    ...(counts.conflicts > 0 ? [{ id: 'conflicts' as const, label: 'Conflicts', count: counts.conflicts }] : []),
  ]
  const notes = state.warnings.filter((w) => !w.includes('not set up') && w !== state.library_problem)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2.5">
        <h1 className="text-sm font-semibold">Skills</h1>
        <span className="text-xs text-muted-foreground" title={state.paths.library}>library {tilde(state.paths.library, state.paths.home)}</span>
        <div className="ml-auto flex items-center gap-3">
          {state.git.available && <GitBar git={state.git} />}
          {(offerMigration(state) || migrated) && !state.library_problem && (
            <Button size="sm" variant="outline" onClick={() => { setMigrated(true); setMigrateOpen(true) }} data-testid="migrate-open"><FolderInput />Migrate existing skills</Button>
          )}
          <Button size="sm" onClick={() => setAddOpen(true)}><Plus />Add skill</Button>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-4 pt-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id} role="tab" aria-selected={active === t.id} data-subtab={t.id} onClick={() => setView(t.id)}
            className={cn(
              '-mb-px flex h-8 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
              active === t.id && 'border-foreground text-foreground',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className={cn('rounded-full bg-muted px-1.5 text-[11px] leading-4', t.id === 'conflicts' && 'bg-red-500/15 text-red-700 dark:text-red-300')}>{t.count}</span>}
          </button>
        ))}
        <div data-slot="skills-subtab-extra" />
      </div>
      <div className="mb-2 shrink-0 border-b" />

      {state.library_problem && (
        <div className="mx-4 mb-2 flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px]" role="alert" data-testid="library-problem">
          <TriangleAlert className="size-4 shrink-0 text-red-600 dark:text-red-400" />
          <span className="min-w-0 flex-1">{state.library_problem} Skills changes are disabled until it is fixed.</span>
        </div>
      )}
      {state.library_missing && !state.library_problem && (
        <div className="mx-4 mb-2 flex items-center gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[13px]" data-testid="library-missing">
          <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            No skills library at <span className="font-mono">{tilde(state.paths.library, state.paths.home)}</span>. Create it to adopt skills and keep them in git.
          </span>
          <Button size="sm" onClick={() => void init()} disabled={initing} data-testid="init-library">{initing ? 'Creating…' : 'Create library'}</Button>
        </div>
      )}
      {notes.length > 0 && (
        <details className="mx-4 mb-2 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground" data-testid="warnings">
          <summary className="cursor-pointer select-none">{notes.length} note{notes.length === 1 ? '' : 's'} about the library</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
      )}

      {active === 'library' ? <LibraryView state={state} />
        : active === 'matrix' ? <MatrixView state={state} />
        : active === 'unmanaged' ? <UnmanagedView state={state} />
        : active === 'external' ? <ExternalView state={state} />
        : <ConflictsView state={state} />}
      <MigrateWizard open={migrateOpen} onOpenChange={setMigrateOpen} home={state.paths.home} />
      <AddSkillDialog open={addOpen} onOpenChange={setAddOpen} onComplete={() => { void useStore.getState().loadSkills() }} />
    </div>
  )
}
