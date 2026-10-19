// Captain page (#/captain/<id>), spec §7.3. Foundation stub, owned by the captain-page builder.
import type { Route } from '@/lib/route'
import { useStore } from '@/lib/store'
import { captainName } from '@/lib/captains'

export function CaptainPage({ route }: { route: Route }) {
  const summary = useStore((s) => s.captains.find((c) => c.agent.id === route.captain || c.agent.handle === route.captain))
  if (!summary) return null
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold tracking-tight">{captainName(summary.agent)}</h1>
      <p className="text-sm text-muted-foreground">@{summary.agent.handle} · {summary.status}</p>
    </div>
  )
}
