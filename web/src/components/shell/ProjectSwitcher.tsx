import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useStore } from '@/lib/store'
import type { Route } from '@/lib/route'
import { projectCaption, switchProject } from '@/lib/shell'
import { cn } from '@/lib/utils'

/** Sparrow's project name as a button; opens a searchable list (↑↓ Enter), each project with its captain/working counts. */
export function ProjectSwitcher({ route, onPicked }: { route: Route; onPicked?: () => void }) {
  const projects = useStore((s) => s.projects)
  const project = useStore((s) => s.project)
  const captains = useStore((s) => s.captains)
  const loaded = useStore((s) => s.captainsLoaded)
  const [open, setOpen] = useState(false)
  const current = projects.find((p) => p.id === project)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Switch project"
          className="group flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent/70"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{current?.name ?? project ?? 'Sparrow'}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-0">
        <Command className="rounded-lg">
          <CommandInput placeholder="Switch project…" className="text-[13px]" />
          <CommandList className="max-h-72">
            <CommandEmpty>No project matches.</CommandEmpty>
            {projects.map((p) => {
              const cap = projectCaption(p, p.id === project && loaded ? captains : null)
              return (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.id}`}
                  className="h-auto min-h-10 py-1.5"
                  onSelect={() => { setOpen(false); onPicked?.(); if (p.id !== project) switchProject(p.id, route) }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground tabular">
                      {cap.text}
                      {cap.working > 0 && <> · <span className="inline-flex items-center gap-1"><span className="inline-block size-1.5 rounded-full bg-ok" />{cap.working} working</span></>}
                    </span>
                  </span>
                  <Check className={cn('size-4', p.id === project ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
