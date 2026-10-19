// "Migrate existing skills": plan (grouped by action, variant picker) → confirm (type "migrate") → result (+ roll back).
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, RotateCcw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { agoLabel, plural } from '@/lib/format'
import {
  KEEP_AS_CONFLICT, MIGRATE_WORD, ROLLBACK_WORD, choicesFor, harnessList, initialSelection, typedOk, viewPlan,
  type MigApplyResult, type MigBackupInfo, type MigDecision, type MigPlan, type MigRollbackResult, type PlanRow, type Selection,
} from '@/lib/migration'
import { ROOT_LABEL, tilde } from '@/lib/skills'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/components/sparrow/bits'
import { DiffView, Pill, Tilde } from './bits'

type Step = 'plan' | 'confirm' | 'done' | 'rolled'

const rootLabel = (r: string) => (r === 'desktop' ? '~/Desktop/Skills' : (ROOT_LABEL as Record<string, string>)[r] ?? r)
const entries = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`
const bytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function Section({ title, count, tone, children, testid }: { title: string; count: number; tone?: 'warn'; children: React.ReactNode; testid: string }) {
  if (!count) return null
  return (
    <section className="overflow-hidden rounded-lg border" data-testid={testid}>
      <h3 className={cn('flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase', tone === 'warn' && 'text-amber-700 dark:text-amber-300')}>
        {title}<span className="font-normal normal-case">{count}</span>
      </h3>
      <div className="divide-y">{children}</div>
    </section>
  )
}

const LETTERS = 'ABCDEFGH'

/** One skill with differing copies: the copies side by side, their diff inline, an explicit choice (default: keep as conflict). */
function ChoiceCard({ d, sel, setSel, diffs, home }: { d: MigDecision; sel: Selection; setSel: (s: Selection) => void; diffs: Record<string, { text?: string; error?: string }>; home: string }) {
  const cur = sel[d.name] ?? KEEP_AS_CONFLICT
  const pick = (value: string) => setSel({ ...sel, [d.name]: value })
  return (
    <div className="px-3 py-3 text-[13px]" data-testid={`choice-${d.name}`} data-plan-name={d.name}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{d.name}</span>
        <span className="text-xs text-muted-foreground">{d.variants.length} copies with different contents. Sparrow does not pick one for you.</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(d.variants.length, 3)}, minmax(0, 1fr))` }}>
        {d.variants.map((v, i) => (
          <label
            key={v.path} data-copy={LETTERS[i]}
            className={cn('flex cursor-pointer flex-col gap-1 rounded-lg border p-2.5 text-xs transition-colors hover:bg-muted/40', cur === v.path && 'border-foreground/50 bg-muted/50')}
          >
            <span className="flex items-center gap-2">
              <input type="radio" name={`pick-${d.name}`} checked={cur === v.path} onChange={() => pick(v.path)} className="accent-foreground" />
              <span className="font-medium">Copy {LETTERS[i]}</span>
              <Pill>{rootLabel(v.root)}</Pill>
            </span>
            <span className="font-mono break-all text-muted-foreground">{tilde(v.path, home)}</span>
            <span className="text-muted-foreground" title={new Date(v.mtime).toLocaleString()}>edited {new Date(v.mtime).toLocaleDateString()} ({agoLabel(v.mtime)})</span>
            <span className="text-muted-foreground">{plural(v.files, 'file')} · hash <span className="font-mono">{v.hash.slice(0, 7)}</span></span>
            <span className="text-[11px] text-muted-foreground">{cur === v.path ? 'Goes into the library; every other copy becomes a link and is saved in the backup.' : 'Use this copy'}</span>
          </label>
        ))}
      </div>
      <label className={cn('mt-2 flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs hover:bg-muted/40', cur === KEEP_AS_CONFLICT && 'border-foreground/50 bg-muted/50')} data-testid={`keep-${d.name}`}>
        <input type="radio" name={`pick-${d.name}`} checked={cur === KEEP_AS_CONFLICT} onChange={() => pick(KEEP_AS_CONFLICT)} className="accent-foreground" />
        <span className="font-medium">Keep as conflict</span>
        <span className="text-muted-foreground">(default) not copied into the library; every copy stays exactly where it is. Decide later.</span>
      </label>
      <div className="mt-3 space-y-2" data-testid={`diffs-${d.name}`}>
        {d.variants.slice(1).map((v, i) => {
          const df = diffs[`${d.name}\0${v.path}`]
          return (
            <div key={v.path}>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Copy A → Copy {LETTERS[i + 1]}</div>
              {df?.error ? <div className="text-xs text-red-700 dark:text-red-300">{df.error}</div>
                : df?.text === undefined ? <div className="text-xs text-muted-foreground">Loading diff…</div>
                : <div className="max-h-72 overflow-y-auto"><DiffView text={df.text} name={d.name} label={`Copy A → Copy ${LETTERS[i + 1]}`} /></div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RowHead({ row, from }: { row: PlanRow; from: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-medium">{row.name}</span>
      <span className="text-xs text-muted-foreground">{harnessList(row.decision.harnesses)}</span>
      <span className="ml-auto text-xs text-muted-foreground">{from}</span>
    </div>
  )
}

export function MigrateWizard({ open, onOpenChange, home }: { open: boolean; onOpenChange: (o: boolean) => void; home: string }) {
  const [step, setStep] = useState<Step>('plan')
  const [plan, setPlan] = useState<MigPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection>({})
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MigApplyResult | null>(null)
  const [rolled, setRolled] = useState<MigRollbackResult | null>(null)
  const [rbTyped, setRbTyped] = useState('')
  const [askRb, setAskRb] = useState<{ id: string } | null>(null)
  const [backups, setBackups] = useState<MigBackupInfo[]>([])
  const [diffs, setDiffs] = useState<Record<string, { text?: string; error?: string }>>({})

  const load = useCallback(async () => {
    setPlan(null); setError(null)
    try {
      const p = await api.migrationPlan()
      setPlan(p); setSel(initialSelection(p)); setDiffs({})
      // The differences are shown inline, so fetch them up front: copy A against every other copy.
      for (const d of p.decisions.filter((x) => x.needsChoice)) {
        for (const v of d.variants.slice(1)) {
          api.migrationDiff(d.name, d.variants[0]!.path, v.path).then(
            (r) => setDiffs((m) => ({ ...m, [`${d.name}\0${v.path}`]: { text: r.diff } })),
            (e: Error) => setDiffs((m) => ({ ...m, [`${d.name}\0${v.path}`]: { error: e.message } })),
          )
        }
      }
    } catch (e) { setError((e as Error).message) }
    try { setBackups(await api.migrationBackups()) } catch { /* the list is a convenience */ }
  }, [])

  useEffect(() => {
    if (!open) return
    setStep('plan')
    setTyped(''); setRbTyped('')
    void load()
  }, [open, load])

  const view = plan ? viewPlan(plan, sel) : null
  const needChoice = plan ? plan.decisions.filter((d) => d.needsChoice && view!.copy.concat(view!.conflict).some((r) => r.name === d.name)) : []
  const reload = () => useStore.getState().loadSkills()

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const r = await api.migrationApply(plan.plan_id, choicesFor(plan, sel))
      setResult(r); setStep('done')
      toast.success(`Migrated ${entries(r.applied.length)}: backup saved`)
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
      setStep('plan'); setTyped('')
      void load()
    } finally { setBusy(false) }
  }

  const rollback = async (id: string) => {
    setBusy(true)
    try {
      const r = await api.migrationRollback(id)
      setRolled(r); setStep('rolled'); setAskRb(null); setRbTyped('')
      toast.success('Rolled back: every folder is as it was before the migration')
      await reload()
      void load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setBusy(false) }
  }

  const live = backups.filter((b) => !b.rolled_back_at)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-3 sm:max-w-4xl" data-testid="migrate-wizard">
        <DialogHeader>
          <DialogTitle>Migrate existing skills</DialogTitle>
          <DialogDescription>
            {step === 'plan' && 'Moves the skills already in your harness folders into the git library and leaves a link behind. Nothing is deleted: every touched folder is backed up first.'}
            {step === 'confirm' && 'Last look. A backup of every touched folder is written before anything moves.'}
            {step === 'done' && 'Migration finished.'}
            {step === 'rolled' && 'Rolled back.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'plan' && (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" data-testid="plan-body">
              {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}
              {!plan && !error && <div className="py-6 text-center text-xs text-muted-foreground">Planning… (hashing every skill folder)</div>}
              {view && plan && (
                <>
                  <div className="text-xs text-muted-foreground" data-testid="plan-summary">
                    {plural(view.total, 'skill')}: <b className="text-foreground">{view.copy.length}</b> copy into the library ·{' '}
                    <b className="text-foreground">{view.conflict.length}</b> kept as conflict ·{' '}
                    <b className="text-foreground">{view.skipped.length}</b> skipped{view.managed > 0 && <> · {view.managed} already linked</>}
                  </div>
                  <Section title="Needs your choice: copies differ" count={needChoice.length} tone="warn" testid="sec-choice">
                    {needChoice.map((d) => <ChoiceCard key={d.name} d={d} sel={sel} setSel={setSel} diffs={diffs} home={home} />)}
                  </Section>
                  <Section title="Copy into the library" count={view.copy.filter((r) => !r.decision.needsChoice).length} testid="sec-copy">
                    {view.copy.filter((r) => !r.decision.needsChoice).map((r) => (
                      <div key={r.name} className="px-3 py-2 text-[13px]" data-plan-name={r.name}>
                        <RowHead row={r} from={`from ${tilde(r.chosen!.path, home)}${r.replaces.length > 1 ? ` (and ${r.replaces.length - 1} other ${r.replaces.length === 2 ? 'location' : 'locations'} link to it)` : ''}`} />
                      </div>
                    ))}
                  </Section>
                  <Section title="Skipped, left untouched" count={view.skipped.length} testid="sec-skipped">
                    {view.skipped.map((s) => (
                      <div key={s.path} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-xs">
                        <Tilde path={s.path} home={home} max={60} />
                        <span className="text-muted-foreground">{s.reason}</span>
                      </div>
                    ))}
                  </Section>
                  {view.protectedCount > 0 && <div className="text-xs text-muted-foreground">{plural(view.protectedCount, 'protected skill')} (claude.ai synced, Codex built-ins) are never touched.</div>}
                  {view.total === 0 && <div className="py-4 text-center text-sm text-muted-foreground">Nothing to migrate: every skill is already linked.</div>}
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs" data-testid="backup-note">
                    <b>Backup:</b> a tar of every touched folder and your current library goes to{' '}
                    <span className="font-mono break-all">{tilde(plan.backup_root, home)}/&lt;timestamp&gt;/backup.tar</span>, with its SHA-256. Originals are moved there, never deleted.
                  </div>
                </>
              )}
              {live.length > 0 && (
                <div className="rounded-md border px-3 py-2 text-xs" data-testid="earlier-backups">
                  <div className="mb-1 font-medium">Earlier migrations</div>
                  {live.map((b) => (
                    <div key={b.id} className="flex items-center gap-2">
                      <span className="font-mono">{b.id}</span>
                      <span className="text-muted-foreground">{entries(b.moved)} · {bytes(b.size)}</span>
                      <Button size="xs" variant="outline" className="ml-auto" onClick={() => { setAskRb({ id: b.id }); setRbTyped('') }}><RotateCcw /> Roll back</Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t pt-3">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => { setStep('confirm'); setTyped('') }} disabled={!view || view.total === 0} data-testid="to-confirm">Continue</Button>
            </div>
          </>
        )}

        {step === 'confirm' && plan && view && (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto text-[13px]" data-testid="confirm-body">
              <ul className="list-disc space-y-1 pl-5">
                <li>{plural(view.copy.length, 'skill')} copied into <span className="font-mono">{tilde(plan.library, home)}</span>, each copy checked byte for byte.</li>
                <li>{plural(view.copy.reduce((n, r) => n + r.replaces.length, 0), 'entry')} (folders and links in your harness folders, ~/.agents/skills and Desktop/Skills) move to the backup. Harness folders and Desktop/Skills get a link to the library copy; ~/.agents/skills entries just move out.</li>
                <li>Each skill is switched on for the harnesses that can see it today, so your own sessions see the same skills; trim them later in the library.</li>
              </ul>
              {needChoice.length > 0 && (
                <div className="space-y-1.5" data-testid="recap-choices">
                  <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Skills with differing copies</div>
                  {needChoice.map((d) => {
                    const row = view.copy.find((r) => r.name === d.name)
                    const letter = row?.chosen ? LETTERS[d.variants.findIndex((v) => v.path === row.chosen!.path)] : null
                    return (
                      <div key={d.name} className="rounded-md border px-3 py-2 text-xs" data-recap={d.name}>
                        <b>{d.name}</b>:{' '}
                        {row?.chosen
                          ? <>Copy {letter} (<span className="font-mono">{tilde(row.chosen.path, home)}</span>) goes into the library. {d.variants.length === 2 ? 'The other copy becomes a link' : `The other ${d.variants.length - 1} copies become links`} and the originals are saved in the backup.</>
                          : <>kept as conflict. Not copied into the library; {d.variants.map((v) => <span key={v.path} className="font-mono">{tilde(v.path, home)} </span>)}stay exactly where they are. You can adopt one later from the Unmanaged tab.</>}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                Backup: <span className="font-mono break-all">{tilde(plan.backup_root, home)}/&lt;timestamp&gt;/backup.tar</span>. You can roll back from this window or the backup list afterwards.
              </div>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Type <b className="font-mono text-foreground">{MIGRATE_WORD}</b> to confirm</span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={MIGRATE_WORD} className="max-w-xs" data-testid="type-migrate" />
              </label>
            </div>
            <div className="flex items-center gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setStep('plan')} disabled={busy}><ArrowLeft /> Back</Button>
              <Button className="ml-auto" onClick={() => void apply()} disabled={busy || !typedOk(typed, MIGRATE_WORD)} data-testid="apply-migration">
                {busy ? 'Migrating…' : 'Migrate'}
              </Button>
            </div>
          </>
        )}

        {step === 'done' && result && (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto text-[13px]" data-testid="result-body">
              <div className="flex flex-wrap gap-2">
                <Pill tone="ok">{entries(result.applied.length)} now linked</Pill>
                <Pill tone={result.skipped.length ? 'warn' : 'none'}>{result.skipped.length} skipped</Pill>
                <Pill tone={result.conflicts_left.length ? 'warn' : 'none'}>{plural(result.conflicts_left.length, 'conflict')} left</Pill>
              </div>
              {result.skipped.length > 0 && (
                <div className="rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs" data-testid="result-skipped">
                  <div className="mb-1 flex items-center gap-1.5 font-medium"><TriangleAlert className="size-3.5" /> Changed since the plan: left exactly as you have it</div>
                  {result.skipped.map((s) => <div key={s.path} className="font-mono">{tilde(s.path, home)} <span className="font-sans text-muted-foreground">({s.reason})</span></div>)}
                </div>
              )}
              {result.kept_as_conflict.length > 0 && (
                <div className="rounded-md border px-3 py-2 text-xs" data-testid="result-kept">
                  <div className="mb-1 font-medium">Kept as conflict: nothing copied, every copy untouched</div>
                  {result.kept_as_conflict.map((k) => <div key={k.name}><b>{k.name}</b> <span className="font-mono text-muted-foreground">{k.paths.map((p) => tilde(p, home)).join('  ·  ')}</span></div>)}
                  <div className="mt-1 text-muted-foreground">They are listed in the Unmanaged tab. Adopt one to make it the library copy; the others then show up under Conflicts.</div>
                </div>
              )}
              {result.conflicts_left.length > 0 && (
                <div className="text-xs text-muted-foreground">Left as conflict: {result.conflicts_left.map((c) => `${c.name} (${rootLabel(c.root)})`).join(', ')}. Resolve them in the Conflicts tab.</div>
              )}
              <div className="rounded-md border px-3 py-2 text-xs" data-testid="result-backup">
                <div className="mb-1 font-medium">Backup</div>
                <div className="flex items-center gap-1"><span className="font-mono break-all">{tilde(result.backup.path, home)}</span><CopyButton text={result.backup.path} label="Copy path" /></div>
                <div className="text-muted-foreground">{bytes(result.backup.size)} · SHA-256 <span className="font-mono">{result.backup.sha256.slice(0, 16)}…</span></div>
              </div>
              <div className="text-xs text-muted-foreground">The library now has uncommitted changes: use <b>Commit &amp; push</b> when you are happy with it.</div>
            </div>
            <div className="flex items-center gap-2 border-t pt-3">
              <Button variant="outline" onClick={() => { setAskRb({ id: result.backup.id }); setRbTyped('') }} data-testid="rollback"><RotateCcw /> Roll back</Button>
              <Button className="ml-auto" onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </>
        )}

        {step === 'rolled' && rolled && (
          <>
            <div className="min-h-0 flex-1 space-y-2 text-[13px]" data-testid="rolled-body">
              {rolled.notRestored.length === 0
                ? <p data-testid="rolled-all">All {rolled.restored.length} migrated {rolled.restored.length === 1 ? 'entry is' : 'entries are'} back as before, verified. {rolled.libraryRestored ? 'The previous library is restored.' : rolled.libraryNote ? `Library: ${rolled.libraryNote}.` : ''}</p>
                : <p className="text-amber-700 dark:text-amber-300" data-testid="rolled-partial">{rolled.restored.length} restored, <b>{rolled.notRestored.length} NOT restored</b>. {rolled.libraryRestored ? 'The previous library is restored.' : rolled.libraryNote ? `Library: ${rolled.libraryNote}.` : ''}</p>}
              {rolled.notRestored.length > 0 && (
                <div className="rounded-md border px-3 py-2 text-xs" data-testid="not-restored">
                  {rolled.notRestored.map((n) => <div key={n.path}><span className="font-mono break-all">{tilde(n.path, home)}</span> <span className="text-muted-foreground">({n.reason})</span></div>)}
                </div>
              )}
              {rolled.removedLinks.length > 0 && <p className="text-xs text-muted-foreground">{plural(rolled.removedLinks.length, 'library link')} added later moved aside so nothing dangles.</p>}
              {rolled.addedSkills.length > 0 && <p className="text-xs text-muted-foreground">Skills added to the library since: {rolled.addedSkills.join(', ')}. The current library was kept in the backup folder{rolled.preservedAt && <> (<span className="font-mono break-all">{tilde(rolled.preservedAt, home)}</span>)</>}.</p>}
            </div>
            <div className="flex justify-end border-t pt-3"><Button onClick={() => onOpenChange(false)}>Close</Button></div>
          </>
        )}
      </DialogContent>

      <Dialog open={askRb !== null} onOpenChange={(o) => { if (!o && !busy) setAskRb(null) }}>
        <DialogContent className="sm:max-w-md" data-testid="rollback-dialog">
          <DialogHeader>
            <DialogTitle>Roll back this migration?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Restores every migrated folder and your previous library from the backup (checked against its SHA-256 first). Anything you added to the library since is kept in the backup folder.</p>
                <p>Type <b className="font-mono text-foreground">{ROLLBACK_WORD}</b> to confirm.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <Input value={rbTyped} onChange={(e) => setRbTyped(e.target.value)} autoFocus placeholder={ROLLBACK_WORD} data-testid="type-rollback" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAskRb(null)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" disabled={busy || !typedOk(rbTyped, ROLLBACK_WORD)} onClick={() => askRb && void rollback(askRb.id)} data-testid="confirm-rollback">{busy ? 'Rolling back…' : 'Roll back'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}

