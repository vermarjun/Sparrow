// Activity tab (§7.3): every message of the fleet as one conversation column, oldest → newest, grouped by day.
// Sticks to the latest unless the reader scrolled up (then a "Jump to latest" pill, absolutely positioned: no layout shift).
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { Agent, CaptainSummary, MessageView } from '@shared/types'
import { AgentAvatar, StateDot } from '@/components/captains/primitives'
import { Switch } from '@/components/ui/switch'
import { activityAgents, activityMessages, groupByDay, hiddenUpdates, type UpdatePolicy } from '@/lib/captains'
import { tightWithPrev, waitingQuestions, type OutcomeRow } from '@/lib/captainPage'
import { resumeCaptain } from '@/lib/captainActions'
import { cn } from '@/lib/utils'
import { Message } from './Message'
import { Outcomes } from './Outcomes'
import { EmptyState, FeedSkeleton } from './parts'
import { SessionRail } from './SessionRail'

interface Props {
  summary: CaptainSummary
  fleet: Agent[]
  messages: MessageView[] | undefined
  onAgent: (id: string) => void
  onCard: (id: number) => void
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-7 sm:px-2',
        active ? 'border-border bg-accent text-foreground' : 'border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export function Activity({ summary, fleet, messages, onAgent, onCard }: Props) {
  const captain = summary.agent
  const [filter, setFilter] = useState<string | null>(null)
  const [hideUpdates, setHideUpdates] = useState(false)
  const [allUpdates, setAllUpdates] = useState(false)
  const policy: UpdatePolicy = hideUpdates ? 'none' : allUpdates ? 'all' : 'recent'

  const agents = useMemo(() => activityAgents(fleet, captain.id), [fleet, captain.id])
  const handles = useMemo(() => new Set(fleet.map((a) => a.handle)), [fleet])
  const waiting = useMemo(() => waitingQuestions(messages ?? []), [messages])
  const list = useMemo(() => activityMessages(messages ?? [], { agent: filter, updates: policy }), [messages, filter, policy])
  const hidden = useMemo(() => hiddenUpdates(messages ?? [], filter), [messages, filter])
  const groups = useMemo(() => groupByDay(list), [list])

  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const lastSeq = useRef<number | null>(null)
  const sig = useRef('')
  const [highlight, setHighlight] = useState<number | null>(null)
  const [unseen, setUnseen] = useState(0)
  const [atBottom, setAtBottom] = useState(true)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !messages) return
    const key = `${filter}|${policy}`
    if (sig.current !== key) { sig.current = key; lastSeq.current = null; pinned.current = true }
    const newest = list.at(-1)?.seq ?? 0
    if (lastSeq.current === null || pinned.current) {
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => { if (pinned.current) el.scrollTop = el.scrollHeight })
      setUnseen(0)
    } else if (newest > lastSeq.current) {
      const from = lastSeq.current
      setUnseen((n) => n + list.filter((m) => m.seq > from).length)
    }
    lastSeq.current = newest
  }, [list, messages, filter, policy])

  // Late layout (fonts, measured clamps) must not strand the reader above the latest message.
  useLayoutEffect(() => {
    const box = content.current
    if (!box) return
    const ro = new ResizeObserver(() => {
      const el = scroller.current
      if (el && pinned.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [messages === undefined])

  const onScroll = () => {
    const el = scroller.current!
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinned.current = near
    setAtBottom(near)
    if (near) setUnseen(0)
  }
  const toLatest = () => {
    const el = scroller.current!
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    pinned.current = true
    setUnseen(0)
  }

  // Outcomes → scroll to the result message and flash it; results without a loaded message open the agent instead.
  const openOutcome = (r: OutcomeRow) => {
    if (r.seq == null) { onAgent(r.agentId); return }
    const seq = r.seq
    const reveal = () => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`)
      if (!el) return
      pinned.current = false
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlight(seq)
      setTimeout(() => setHighlight((h) => (h === seq ? null : h)), 1800)
    }
    if (filter && filter !== r.agentId) { setFilter(null); setTimeout(reveal, 60) } else reveal()
  }

  const empty = messages && messages.length === 0
  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!empty && <Outcomes fleet={fleet} messages={messages} captainId={captain.id} onOpen={openOutcome} />}
        {agents.length > 0 && (
          <div className="shrink-0 border-b border-border/60">
            <div className="mx-auto flex w-full max-w-[808px] items-center gap-3 px-4 py-2 sm:px-6">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)] pr-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Filter by agent">
                <Chip active={filter === null} onClick={() => setFilter(null)}>Everyone</Chip>
                {agents.map((a) => (
                  <Chip key={a.id} active={filter === a.id} onClick={() => setFilter(filter === a.id ? null : a.id)}>
                    <AgentAvatar handle={a.handle} size="xs" />
                    @{a.handle}
                    <StateDot state={a.state} />
                  </Chip>
                ))}
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
                Hide updates
                <Switch checked={hideUpdates} onCheckedChange={setHideUpdates} aria-label="Hide updates" />
              </label>
            </div>
          </div>
        )}
        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto" data-testid="feed">
          {!messages ? <FeedSkeleton /> : empty ? (
            <EmptyState
              title="Nothing here yet"
              hint={`@${captain.handle} has not hired anyone, so there are no messages to show.`}
              cli={'sparrow hire <resume> "<task>"'}
              action={{ label: 'Resume this captain', onClick: () => void resumeCaptain(summary) }}
            />
          ) : (
            <div ref={content} className="mx-auto w-full max-w-[808px] px-4 pb-6 sm:px-6">
              {hidden > 0 && !hideUpdates && (
                <div className="flex justify-center pt-4">
                  <button type="button" onClick={() => setAllUpdates((v) => !v)} className="rounded-full px-3 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    {allUpdates ? 'Hide earlier updates' : `Show ${hidden} earlier update${hidden === 1 ? '' : 's'}`}
                  </button>
                </div>
              )}
              {list.length === 0 && <p className="py-16 text-center text-[13px] text-muted-foreground">No messages match this filter.</p>}
              {groups.map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <div className="sticky top-0 z-10 flex h-9 items-center justify-center border-b border-border/40 bg-background">
                    <span className="text-xs font-medium text-muted-foreground">{g.label}</span>
                  </div>
                  <div className="h-4" aria-hidden />
                  <div>
                    {g.items.map((m, i) => (
                      <div key={m.seq} data-seq={m.seq} className={cn('-mx-2 rounded-lg px-2 transition-colors duration-500', highlight === m.seq && 'bg-accent', tightWithPrev(g.items, i) ? 'mt-0.5' : i === 0 ? '' : 'mt-5')}>
                        <Message
                          m={m}
                          captainId={captain.id}
                          captainHandle={captain.handle}
                          handles={handles}
                          waiting={waiting.has(m.seq)}
                          onAgent={onAgent}
                          onCard={onCard}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
        {unseen > 0 && !atBottom && (
          <button
            type="button"
            onClick={toLatest}
            className="absolute bottom-4 left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-3.5 text-[13px] font-medium shadow-md transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ArrowDown aria-hidden className="size-3.5" />
            Jump to latest
            <span className="rounded-full bg-muted px-1.5 text-[11px] tabular">{unseen}</span>
          </button>
        )}
      </div>
      <SessionRail summary={summary} fleet={fleet} onAgent={onAgent} />
    </div>
  )
}
