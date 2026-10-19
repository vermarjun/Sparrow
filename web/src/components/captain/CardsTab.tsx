// Cards tab (§7.3): the fleet's cards as compact rows; a click opens the ticket sheet.
import type { Agent, Card } from '@shared/types'
import { STATE_LABEL, cardKey } from '@shared/cards'
import { AgentAvatar } from '@/components/captains/primitives'
import { cn } from '@/lib/utils'
import { EmptyState } from './parts'
import { useRowNav } from './hooks'

const DOT: Record<Card['state'], string> = {
  in_progress: 'bg-ok', review: 'bg-warn', todo: 'bg-zinc-300 dark:bg-zinc-600', proposed: 'bg-zinc-300 dark:bg-zinc-600', done: 'bg-ok/40', dropped: 'bg-zinc-200 dark:bg-zinc-700',
}

export function CardsTab({ cards, agents, onCard }: { cards: Card[]; agents: Record<string, Agent>; onCard: (id: number) => void }) {
  const onKeyDown = useRowNav()
  if (!cards.length) {
    return (
      <EmptyState
        title="No cards for this team yet"
        hint="Cards assigned to this captain's team, or proposed by it, appear here."
        cli={'sparrow propose "<title>"'}
        action={{ label: 'Open the board', href: '#/board' }}
      />
    )
  }
  return (
    <div className="h-full overflow-y-auto" onKeyDown={onKeyDown}>
      <ul className="mx-auto max-w-[920px] px-3 py-4 sm:px-6 sm:py-6">
        {cards.map((c) => {
          const who = c.assignee_id ? agents[c.assignee_id] : undefined
          return (
            <li key={c.id}>
              <button
                type="button"
                data-row
                onClick={() => onCard(c.id)}
                className={cn('flex h-11 w-full items-center gap-3 rounded-lg px-2 text-left outline-none transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 sm:px-3', (c.state === 'done' || c.state === 'dropped') && 'text-muted-foreground')}
              >
                <span className="w-14 shrink-0 font-mono text-[12px] text-muted-foreground tabular">{cardKey(c)}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
                  <span aria-hidden className={cn('size-1.5 rounded-full', DOT[c.state])} />
                  {STATE_LABEL[c.state]}
                </span>
                <span className="inline-flex w-24 shrink-0 items-center justify-end gap-1.5 text-[13px] text-muted-foreground sm:w-28">
                  {who ? <><AgentAvatar handle={who.handle} size="xs" /><span className="truncate">@{who.handle}</span></> : <span className="text-muted-foreground/60">unassigned</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
