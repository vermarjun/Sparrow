// ⌘K (§7.1): jump to a captain or agent, switch project, start / resume / archive, open pages, toggle theme. Keyboard only.
import { useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Columns3, FileText, FolderGit2, Moon, Play, Plus, Settings, Sparkles, Stethoscope, Sun } from 'lucide-react'
import { AgentAvatar, CaptainAvatar, StateDot, StatusGlyph } from '@/components/captains/primitives'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { RESUME_LABEL, resumeCaptain, resumeMode, setArchived } from '@/lib/captainActions'
import { captainName, compareCaptains } from '@/lib/captains'
import { captainHref, href, navigate, type Page, type Route } from '@/lib/route'
import { useShell } from '@/lib/shellUi'
import { useStore } from '@/lib/store'
import { switchProject } from '@/lib/shell'
import { useTheme } from '@/lib/theme'

const PAGES: { page: Page; label: string; Icon: typeof Columns3 }[] = [
  { page: 'board', label: 'Open Board', Icon: Columns3 },
  { page: 'resumes', label: 'Go to Resumes', Icon: FileText },
  { page: 'skills', label: 'Go to Skills', Icon: Sparkles },
  { page: 'doctor', label: 'Go to Doctor', Icon: Stethoscope },
  { page: 'settings', label: 'Go to Settings', Icon: Settings },
]

export function CommandPalette({ route }: { route: Route }) {
  const open = useShell((s) => s.paletteOpen)
  const setOpen = useShell((s) => s.setPalette)
  const setNew = useShell((s) => s.setNew)
  const project = useStore((s) => s.project)
  const projects = useStore((s) => s.projects)
  const captains = useStore((s) => s.captains)
  const agents = useStore((s) => s.agents)
  const { dark, toggle } = useTheme()
  const [q, setQ] = useState('')

  const sorted = useMemo(() => [...captains].sort(compareCaptains), [captains])
  const current = route.page === 'captain' ? captains.find((c) => c.agent.id === route.captain) : undefined
  const fleetOwner = (id: string) => captains.find((c) => c.agent.id === (agents[id]?.fleet_id ?? id))
  const people = useMemo(() => Object.values(agents).filter((a) => a.kind !== 'human' && a.state !== 'retired' && fleetOwner(a.id)).sort((a, b) => a.handle.localeCompare(b.handle)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, captains])

  const run = (fn: () => void) => () => { setOpen(false); fn() }
  const onOpenChange = (o: boolean) => { setOpen(o); if (!o) setQ('') }
  const mode = current ? resumeMode(current) : 'none'
  const searching = q.trim().length > 0

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} commandProps={{ loop: true }}>
      <CommandInput value={q} onValueChange={setQ} placeholder="Jump to a captain, agent or action…" />
      <CommandList>
        <CommandEmpty>Nothing matches “{q.trim()}”.</CommandEmpty>

        {current && (
          <CommandGroup heading={captainName(current.agent)}>
            {mode !== 'none' && (
              <CommandItem value={`resume ${RESUME_LABEL[mode]} ${current.agent.handle}`} onSelect={run(() => void resumeCaptain(current))}>
                <Play /> {RESUME_LABEL[mode]}
              </CommandItem>
            )}
            <CommandItem value={`${current.status === 'archived' ? 'unarchive' : 'archive'} ${current.agent.handle}`} onSelect={run(() => void setArchived(current, current.status !== 'archived'))}>
              {current.status === 'archived' ? <ArchiveRestore /> : <Archive />} {current.status === 'archived' ? 'Unarchive' : 'Archive'} this captain
            </CommandItem>
          </CommandGroup>
        )}

        {sorted.length > 0 && (
          <CommandGroup heading="Captains">
            {sorted.map((s) => (
              <CommandItem
                key={s.agent.id}
                value={`${captainName(s.agent)} @${s.agent.handle}`}
                keywords={[s.agent.handle, s.agent.captain?.branch ?? '']}
                onSelect={run(() => navigate(captainHref(s.agent.id, project)))}
              >
                <CaptainAvatar id={s.agent.id} handle={s.agent.handle} />
                <span className="min-w-0 flex-1 truncate">{captainName(s.agent)}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">@{s.agent.handle}</span>
                <span className="flex w-[84px] shrink-0 items-center justify-end gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                  {s.status === 'working' || s.status === 'attention' ? <StatusGlyph status={s.status} /> : null}
                  {s.status === 'working' ? 'working' : s.status === 'attention' ? 'needs you' : s.status === 'archived' ? 'archived' : ''}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Actions">
          <CommandItem value="new captain start" onSelect={run(() => setNew(true))}><Plus /> New captain</CommandItem>
          {PAGES.map(({ page, label, Icon }) => (
            <CommandItem key={page} value={`${label} ${page}`} onSelect={run(() => navigate(href({ page, project })))}><Icon /> {label}</CommandItem>
          ))}
          <CommandItem value="Toggle theme" keywords={['dark', 'light']} onSelect={run(toggle)}>{dark ? <Sun /> : <Moon />} Toggle theme<CommandShortcut>{dark ? 'light' : 'dark'}</CommandShortcut></CommandItem>
        </CommandGroup>

        {searching && people.length > 0 && (
          <CommandGroup heading="Agents">
            {people.map((a) => {
              const owner = fleetOwner(a.id)!
              return (
                <CommandItem key={a.id} value={`${a.handle} @${a.handle} ${a.resume ?? ''} agent`} onSelect={run(() => navigate(captainHref(owner.agent.id, project, { tab: 'team', agent: a.id })))}>
                  <AgentAvatar handle={a.handle} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">@{a.handle}</span>
                  <span className="shrink-0 truncate text-xs text-muted-foreground">{captainName(owner.agent)}</span>
                  <StateDot state={a.state} />
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {projects.length > 1 && (
          <CommandGroup heading="Projects">
            {projects.filter((p) => p.id !== project).map((p) => (
              <CommandItem key={p.id} value={`switch project ${p.name}`} onSelect={run(() => switchProject(p.id, route))}>
                <FolderGit2 /> Switch to {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
