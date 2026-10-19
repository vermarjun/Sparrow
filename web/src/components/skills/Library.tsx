import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lock, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { HARNESS_NAME, HARNESS_ORDER, filterSkills, skillsHref, type SkillUpdate, type SkillsState } from '@/lib/skills'
import { plural } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Empty } from '@/components/sparrow/bits'
import { setHarness } from '@/lib/skillActions'
import { HarnessCell, Pill, SourceBadge } from './bits'

export function LibraryView({ state }: { state: SkillsState }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [updates, setUpdates] = useState<SkillUpdate[]>([])
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const rows = useMemo(() => filterSkills(state.library, query), [state.library, query])
  const needSync = state.library.some((s) => s.links.some((l) => l.state === 'missing'))

  const checkUpdates = useCallback(async (notify: boolean) => {
    setCheckingUpdates(true)
    try { setUpdates(await api.skillUpdates()) }
    catch (e) { if (notify) toast.error(`Update check failed: ${(e as Error).message}`) }
    finally { setCheckingUpdates(false) }
  }, [])

  // Each check shallow-clones every Git source, so check automatically only when the set of Git-sourced skills
  // changes (not on every library refresh: toggles, SSE events, reconnects). "Check updates" re-runs it on demand.
  const gitSources = useMemo(() => state.library
    .filter((s) => s.source !== 'local' && s.source !== 'sparrow' && s.sourceUrl)
    .map((s) => `${s.name}\t${s.sourceUrl}`).sort().join('\n'), [state.library])
  useEffect(() => {
    if (!gitSources) return
    let active = true
    void api.skillUpdates().then((next) => { if (active) setUpdates(next) }).catch(() => {})
    return () => { active = false }
  }, [gitSources])

  const toggle = async (key: string, run: () => Promise<boolean>) => {
    setBusy(key)
    try { await run() } finally { setBusy(null) }
  }
  const sync = async () => {
    setBusy('sync')
    try {
      const r = await api.syncSkills()
      toast.success(r.actions.length ? `Synced: ${plural(r.actions.length, 'link')} changed` : 'Links already match the library')
      if (r.conflicts.length) toast.warning(`${plural(r.conflicts.length, 'conflict')} left untouched: see Conflicts`)
      await useStore.getState().loadSkills()
    } catch (e) {
      toast.error(`Sync failed: ${(e as Error).message}`)
    } finally { setBusy(null) }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter skills" className="h-7 w-56 pl-7 text-[13px]" aria-label="Filter skills" />
        </div>
        <span className="text-xs text-muted-foreground">{plural(state.library.length, 'skill')} · a switch links the skill into that harness's skills folder</span>
        <Button
          variant="outline" size="sm" onClick={() => void checkUpdates(true)} disabled={checkingUpdates || state.library_missing}
          title="Check upstream Git sources for changes"
        >
          <RefreshCw className={cn(checkingUpdates && 'animate-spin')} /> Check updates
        </Button>
        <Button
          variant="outline" size="sm" className="ml-auto" onClick={() => void sync()} disabled={busy === 'sync' || state.library_missing}
          title="Create the links the library says should exist (use after pulling or cloning)"
        >
          <RefreshCw className={cn(busy === 'sync' && 'animate-spin')} /> Sync links{needSync ? ' · needed' : ''}
        </Button>
      </div>
      <div className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-xl border bg-background">
        {rows.length === 0 ? (
          <Empty title={query ? 'No skills match' : 'The library is empty'} className="h-full">
            {query ? 'Try another word.' : 'Adopt skills from the Unmanaged and External tabs, or add one with Add skill.'}
          </Empty>
        ) : (
          <Table className="text-[13px]">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="text-[11px] tracking-wide uppercase hover:bg-transparent">
                <TableHead className="h-8 pl-4">Skill</TableHead>
                <TableHead className="h-8">Source</TableHead>
                {HARNESS_ORDER.map((h) => <TableHead key={h} className="h-8">{HARNESS_NAME[h]}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((skill) => (
                <TableRow key={skill.name} className={cn(skill.locked && 'bg-muted/30')} data-skill={skill.name}>
                  <TableCell className="max-w-[28rem] py-2 pl-4 whitespace-normal">
                    <div className="flex items-center gap-1.5">
                      {skill.locked && <Lock className="size-3 text-muted-foreground" />}
                      <a href={skillsHref(skill.name)} className="font-medium hover:underline" data-testid="skill-link">{skill.name}</a>
                      {updates.find((update) => update.name === skill.name)?.available && (
                        <Pill tone="info" title={`Upstream changed (${updates.find((update) => update.name === skill.name)?.current ?? 'unknown'} → ${updates.find((update) => update.name === skill.name)?.latest ?? 'unknown'})`}>update available</Pill>
                      )}
                      {updates.find((update) => update.name === skill.name)?.error && (
                        <Pill tone="warn" title={updates.find((update) => update.name === skill.name)?.error}>update check failed</Pill>
                      )}
                      {!skill.inManifest && <Pill tone="warn" title="This folder is not in skills.json: toggles are saved once you use one">not in manifest</Pill>}
                      {skill.problems.some((p) => p.code !== 'not-in-manifest') && (
                        <span title={skill.problems.map((p) => p.message).join('\n')}><TriangleAlert className="size-3.5 text-amber-600 dark:text-amber-400" /></span>
                      )}
                    </div>
                    <div className="line-clamp-1 text-xs text-muted-foreground">{skill.description ?? <i>no description</i>}</div>
                  </TableCell>
                  <TableCell className="py-2"><SourceBadge skill={skill} /></TableCell>
                  {skill.links.map((link) => (
                    <TableCell key={link.harness} className="py-2">
                      <HarnessCell
                        skill={skill} link={link} busy={busy === `${skill.name}:${link.harness}`}
                        onToggle={() => void toggle(`${skill.name}:${link.harness}`, () => setHarness(skill, link.harness))}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
