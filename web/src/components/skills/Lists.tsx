// Unmanaged · External · Conflicts (+ broken links) sub-tabs.
import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { HARNESS_NAME, ROOT_LABEL, originLabel, tilde, type SkillEntry, type SkillsState } from '@/lib/skills'
import { useStore } from '@/lib/store'
import { Empty } from '@/components/sparrow/bits'
import { ConfirmDialog, DiffView, Pill, Tilde } from './bits'

const reload = () => useStore.getState().loadSkills()

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-xl border bg-background">{children}</div>
}

function Head({ cols }: { cols: string[] }) {
  return (
    <TableHeader className="sticky top-0 z-10 bg-background">
      <TableRow className="text-[11px] tracking-wide uppercase hover:bg-transparent">
        {cols.map((c, i) => <TableHead key={c || i} className={i === 0 ? 'h-8 pl-4' : 'h-8'}>{c}</TableHead>)}
      </TableRow>
    </TableHeader>
  )
}

function NameCell({ entry, copies = 1 }: { entry: SkillEntry; copies?: number }) {
  return (
    <TableCell className="max-w-[26rem] py-2 pl-4 whitespace-normal">
      <div className="flex items-center gap-1.5 font-medium">
        {entry.name}
        {copies > 1 && <Pill tone="warn" title="Several folders share this name. Adopting one makes it the library copy; the others then appear under Conflicts.">{copies} copies</Pill>}
      </div>
      <div className="line-clamp-1 text-xs text-muted-foreground">{entry.frontmatter?.description ?? <i>no description</i>}</div>
    </TableCell>
  )
}

// ---------------------------------------------------------------- adopt

function AdoptButton({ entry, external, home }: { entry: SkillEntry; external: boolean; home: string }) {
  const [open, setOpen] = useState(false)
  const confirm = async () => {
    try {
      const r = await api.adoptSkill(entry.path)
      toast.success(
        external
          ? `Adopted ${entry.name}: copied into the library. The original was not touched.`
          : `Adopted ${entry.name}: the folder moved to the backup and is now a link to the library.`,
        { description: r.backup ? `Backup: ${tilde(r.backup, home)}` : undefined, action: { label: 'Open', onClick: () => { location.hash = `/skills/${encodeURIComponent(entry.name)}` } } },
      )
      await reload()
    } catch (e) {
      toast.error(`Could not adopt ${entry.name}: ${(e as Error).message}`)
      void reload()
      throw e
    }
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="adopt" data-adopt={entry.name}>Adopt</Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title={`Adopt ${entry.name}?`} confirmLabel="Adopt" onConfirm={confirm}>
        {external ? (
          <>
            <p>Copies <b className="text-foreground">{entry.name}</b> into your library (a git folder), where you can edit it, version it and switch it on per harness.</p>
            <p>The original at <span className="font-mono break-all text-foreground">{tilde(entry.path, home)}</span> <b className="text-foreground">stays where it is</b>: the tool that installed it keeps managing it.</p>
          </>
        ) : (
          <>
            <p>Copies <b className="text-foreground">{entry.name}</b> into your library, checks the copy byte for byte, then replaces the folder at <span className="font-mono break-all text-foreground">{tilde(entry.path, home)}</span> with a link to it.</p>
            <p>The original folder is moved to the backup area, never deleted.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  )
}

// ---------------------------------------------------------------- lists

export function UnmanagedView({ state }: { state: SkillsState }) {
  const rows = state.unmanaged
  const copies = (name: string) => rows.filter((r) => r.name === name).length
  return (
    <Shell>
      {rows.length === 0 ? (
        <Empty title="Nothing unmanaged" className="h-full">Every skill in the Claude, Codex and OpenCode folders is either in the library or an External entry.</Empty>
      ) : (
        <Table className="text-[13px]">
          <Head cols={['Skill', 'Found in', 'Path', '']} />
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.path} data-entry={`${e.root}/${e.name}`}>
                <NameCell entry={e} copies={copies(e.name)} />
                <TableCell className="py-2 text-xs whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">{e.kind === 'link' ? <Link2 className="size-3.5 text-muted-foreground" /> : <Folder className="size-3.5 text-muted-foreground" />}{HARNESS_NAME[e.root as keyof typeof HARNESS_NAME] ?? e.root}</span>
                </TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground"><Tilde path={e.path} home={state.paths.home} /></TableCell>
                <TableCell className="py-2 pr-4 text-right"><AdoptButton entry={e} external={false} home={state.paths.home} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Shell>
  )
}

export function ExternalView({ state }: { state: SkillsState }) {
  const rows = state.external
  return (
    <Shell>
      {rows.length === 0 ? (
        <Empty title="No external skills" className="h-full">Skills installed by other tools (~/.agents/skills, claude.ai sync, brew) show up here, read-only.</Empty>
      ) : (
        <Table className="text-[13px]">
          <Head cols={['Skill', 'Origin', 'Read by', 'Path', '']} />
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.path} data-entry={`${e.root}/${e.name}`}>
                <NameCell entry={e} />
                <TableCell className="py-2 text-xs">{originLabel(e)}</TableCell>
                <TableCell className="py-2"><div className="flex gap-1">{e.readers.map((h) => <Pill key={h}>{HARNESS_NAME[h]}</Pill>)}</div></TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground"><Tilde path={e.path} home={state.paths.home} /></TableCell>
                <TableCell className="py-2 pr-4 text-right"><AdoptButton entry={e} external home={state.paths.home} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------- conflicts

function ConflictRow({ entry, home }: { entry: SkillEntry; home: string }) {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ask, setAsk] = useState<'library' | 'entry' | null>(null)
  const identical = entry.conflict === 'identical'

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && !diff) {
      try {
        const r = await api.skillDiff(entry.name, entry.path)
        setDiff({ text: r.diff, truncated: !!r.truncated })
      } catch (e) { setError((e as Error).message) }
    }
  }
  const resolve = (keep: 'library' | 'entry') => async () => {
    try {
      const r = await api.resolveConflict(entry.path, keep)
      toast.success(keep === 'library' ? `${entry.name}: now a link to the library copy` : `${entry.name}: this copy is now the library version`, {
        description: `Replaced folder saved in ${tilde(r.backup, home)}`,
      })
      await reload()
    } catch (e) {
      toast.error(`Could not resolve ${entry.name}: ${(e as Error).message}`)
      void reload()
      throw e
    }
  }
  return (
    <Fragment>
      <TableRow data-entry={`${entry.root}/${entry.name}`} data-conflict={entry.conflict}>
        <TableCell className="py-2 pl-4">
          <button className="flex items-center gap-1 text-left font-medium" onClick={() => void toggle()} aria-expanded={open} data-testid="conflict-toggle">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {entry.name}
          </button>
        </TableCell>
        <TableCell className="py-2 text-xs whitespace-nowrap">{HARNESS_NAME[entry.root as keyof typeof HARNESS_NAME] ?? entry.root}</TableCell>
        <TableCell className="py-2">
          {identical ? <Pill tone="ok" title="Same bytes as the library copy">identical</Pill> : <Pill tone="warn" title="Contents differ from the library copy">differs</Pill>}
        </TableCell>
        <TableCell className="py-2 text-xs text-muted-foreground"><Tilde path={entry.path} home={home} /></TableCell>
        <TableCell className="py-2 pr-4">
          <div className="flex justify-end gap-1.5">
            {identical ? (
              <Button size="sm" onClick={() => void resolve('library')().catch(() => {})} data-testid="replace-with-link">Replace with link</Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setAsk('library')} data-testid="keep-library">Keep library</Button>
                <Button size="sm" variant="outline" onClick={() => setAsk('entry')} data-testid="keep-entry">Keep this copy</Button>
              </>
            )}
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/20 px-4 py-3 whitespace-normal">
            {error ? <div className="text-xs text-red-700 dark:text-red-300">{error}</div>
              : !diff ? <div className="text-xs text-muted-foreground">Loading diff…</div>
              : identical ? <div className="text-xs text-muted-foreground">Identical to the library copy: replacing it with a link loses nothing.</div>
              : <><DiffView text={diff.text} name={entry.name} />{diff.truncated && <div className="mt-1 text-[11px] text-muted-foreground">Diff truncated.</div>}</>}
          </TableCell>
        </TableRow>
      )}
      <ConfirmDialog
        open={ask !== null} onOpenChange={(o) => { if (!o) setAsk(null) }} confirmLabel={ask === 'library' ? 'Keep library copy' : 'Keep this copy'}
        title={ask === 'library' ? `Keep the library copy of ${entry.name}?` : `Make this copy the library version of ${entry.name}?`}
        onConfirm={resolve(ask ?? 'library')}
      >
        {ask === 'library' ? (
          <p>The folder at <span className="font-mono break-all text-foreground">{tilde(entry.path, home)}</span> is moved to the backup area and replaced with a link to the library copy.</p>
        ) : (
          <>
            <p>This folder's contents replace the library copy (checked byte for byte), and the folder becomes a link to it.</p>
            <p>The previous library copy and this folder are both saved in the backup area.</p>
          </>
        )}
      </ConfirmDialog>
    </Fragment>
  )
}

export function ConflictsView({ state }: { state: SkillsState }) {
  const { conflicts, broken } = state
  return (
    <Shell>
      {conflicts.length === 0 && broken.length === 0 ? (
        <Empty title="No conflicts" className="h-full">Nothing shares a name with a library skill without being linked to it.</Empty>
      ) : (
        <>
          {conflicts.length > 0 && (
            <Table className="text-[13px]">
              <Head cols={['Skill', 'Harness', 'Copy', 'Path', '']} />
              <TableBody>{conflicts.map((e) => <ConflictRow key={e.path} entry={e} home={state.paths.home} />)}</TableBody>
            </Table>
          )}
          {broken.length > 0 && (
            <div data-testid="broken">
              <div className="border-y bg-muted/40 px-4 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Broken links · {broken.length}</div>
              <Table className="text-[13px]">
                <TableBody>
                  {broken.map((e) => (
                    <TableRow key={e.path} data-entry={`${e.root}/${e.name}`}>
                      <TableCell className="w-48 py-2 pl-4 font-medium">{e.name}</TableCell>
                      <TableCell className="py-2 text-xs whitespace-nowrap">{ROOT_LABEL[e.root]}</TableCell>
                      <TableCell className="py-2"><Pill tone="bad">dangling</Pill></TableCell>
                      <TableCell className="py-2 text-xs text-muted-foreground">points to <span className="font-mono">{e.linkTarget ? tilde(e.linkTarget, state.paths.home) : '?'}</span></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </Shell>
  )
}
