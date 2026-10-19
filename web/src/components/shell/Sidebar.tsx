// Foundation placeholder (owned by the shell builder): captain list + footer nav. See spec §7.1.
import { useStore } from '@/lib/store'
import { captainHref, href, type Route } from '@/lib/route'
import { captainName, groupCaptains } from '@/lib/captains'
import { CaptainAvatar, StatusGlyph } from '@/components/captains/primitives'
import type { Boot } from '@/App'

export function Sidebar({ route }: { route: Route; boot: Boot }) {
  const project = useStore((s) => s.project)
  const captains = useStore((s) => s.captains)
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sm">
      <a href={href({ page: 'captains', project })} className="px-4 py-3 font-semibold">Sparrow · {project}</a>
      <nav className="flex-1 overflow-y-auto px-2">
        {groupCaptains(captains).map((g) => (
          <div key={g.status} className="mb-3">
            <div className="px-2 py-1 text-xs text-muted-foreground">{g.label}</div>
            {g.items.map((s) => (
              <a key={s.agent.id} href={captainHref(s.agent.id, project)} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent" aria-current={route.captain === s.agent.id ? 'page' : undefined}>
                <CaptainAvatar id={s.agent.id} handle={s.agent.handle} />
                <span className="min-w-0 flex-1 truncate">{captainName(s.agent)}</span>
                <StatusGlyph status={s.status} />
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="flex flex-wrap gap-2 border-t p-3 text-xs text-muted-foreground">
        {(['board', 'resumes', 'skills', 'doctor', 'settings'] as const).map((p) => <a key={p} href={href({ page: p, project })}>{p}</a>)}
      </div>
    </aside>
  )
}
