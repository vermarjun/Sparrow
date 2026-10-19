import { Menu } from 'lucide-react'
import { captainName } from '@/lib/captains'
import type { Route } from '@/lib/route'
import { mobileTitle } from '@/lib/shell'
import { useShell } from '@/lib/shellUi'
import { useStore } from '@/lib/store'
import { IconButton } from './IconButton'

/** < md only: a slim bar with the menu button (opens the sidebar sheet) and the current page's name. */
export function MobileBar({ route }: { route: Route }) {
  const project = useStore((s) => s.project)
  const captain = useStore((s) => (route.captain ? s.captains.find((c) => c.agent.id === route.captain) : undefined))
  const setOpen = useShell((s) => s.setMobileOpen)
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 md:hidden">
      <IconButton label="Open menu" size="icon" className="size-10 text-muted-foreground" onClick={() => setOpen(true)}><Menu className="size-5" /></IconButton>
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{mobileTitle(route, project, captain ? captainName(captain.agent) : null)}</h1>
    </header>
  )
}
