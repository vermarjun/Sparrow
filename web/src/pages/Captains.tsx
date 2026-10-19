// Project home (#/captains), spec §7.2. Foundation stub, owned by the shell builder.
import type { Route } from '@/lib/route'
import { useStore } from '@/lib/store'
import { projectLine } from '@/lib/captains'

export function CaptainsPage(_: { route: Route }) {
  const project = useStore((s) => s.project)
  const captains = useStore((s) => s.captains)
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold tracking-tight">{project}</h1>
      <p className="text-sm text-muted-foreground">{projectLine(captains)}</p>
    </div>
  )
}
