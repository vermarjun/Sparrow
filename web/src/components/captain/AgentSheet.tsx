// Agent sheet (§7.3): who it is, how to get into its window, a live screen peek, what it last returned, its calls, and its thread.
import { useEffect, useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import type { Agent, CaptainSummary, MessageView } from '@shared/types'
import { AgentAvatar, CaptainAvatar, HarnessTag, RESULT_TONE, StateDot, STATE_LABEL } from '@/components/captains/primitives'
import { useNow } from '@/components/sparrow/bits'
import { Markdown } from '@/components/sparrow/Markdown'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { api, type AgentDetail } from '@/lib/api'
import { copyText } from '@/lib/captainActions'
import { END_REASON_LABEL, agentAttach, agentResumeCommand, agentThread, endReasonTone, modelLine, oneLine } from '@/lib/captainPage'
import { ago, clock, duration } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Message } from './Message'
import { ScreenPeek } from './ScreenPeek'

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-5">
      <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-medium text-muted-foreground">{title}</h3>{aside}</div>
      {children}
    </section>
  )
}

const TONE_TEXT = { ok: 'text-emerald-700 dark:text-emerald-300', warn: 'text-amber-700 dark:text-amber-300', bad: 'text-bad', muted: 'text-muted-foreground' } as const

function Calls({ agent, detail }: { agent: Agent; detail: AgentDetail | null }) {
  const now = useNow(5000)
  if (!detail) return <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-5 animate-pulse rounded-md bg-muted" />)}</div>
  if (!detail.calls.length) return <p className="text-[13px] text-muted-foreground">No calls yet.</p>
  return (
    <ul className="-my-1">
      {detail.calls.slice(0, 8).map((c) => (
        <li key={c.id} className="grid h-8 grid-cols-[116px_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
          <span className="whitespace-nowrap text-muted-foreground tabular">{clock(c.started_at, now)}</span>
          {c.ended_at ? <span className={cn('truncate', TONE_TEXT[endReasonTone(c.end_reason)])}>{c.end_reason ? END_REASON_LABEL[c.end_reason] : 'Ended'}{c.resumed ? <span className="text-muted-foreground"> · resumed</span> : null}</span>
            : <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"><StateDot state={agent.state === 'working' ? 'working' : 'idle'} />Open</span>}
          <span className="text-muted-foreground tabular">{duration((c.ended_at ?? now) - c.started_at)}</span>
        </li>
      ))}
    </ul>
  )
}

function CopyBtn({ text, label, what }: { text: string | null; label: string; what: string }) {
  return (
    <Button variant="outline" size="sm" disabled={!text} onClick={() => void copyText(text!, what)} className="h-8 gap-1.5 px-2.5 text-[13px] sm:h-7">
      <Copy aria-hidden className="size-3.5" />
      {label}
    </Button>
  )
}

function Body({ agent, summary, fleet, messages, handles, onAgent, onCard }: { agent: Agent; summary: CaptainSummary; fleet: Agent[]; messages: MessageView[]; handles: Set<string>; onAgent: (id: string) => void; onCard: (id: number) => void }) {
  const isRoot = agent.id === summary.agent.id
  const lastCall = useStore((s) => s.lastCall)
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const callKey = lastCall && lastCall.agent_id === agent.id ? lastCall.at : 0
  useEffect(() => {
    let live = true
    if (isRoot) { setDetail({ agent, calls: [], children: [] }); return }
    api.agent(agent.id).then((d) => live && setDetail(d)).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, agent.state, callKey, isRoot])

  const thread = useMemo(() => agentThread(messages, agent), [messages, agent])
  const resume = isRoot ? summary.resume.command : agentResumeCommand(agent)
  const attach = isRoot ? summary.resume.attach : agentAttach(agent)
  const sid = isRoot ? summary.resume.session_id : agent.session_id
  const parent = agent.parent_id ? fleet.find((a) => a.id === agent.parent_id) : undefined
  const res = agent.last_result
  const now = useNow(30000)

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pt-1 pb-8">
      <div className="flex flex-wrap gap-2">
        {attach && <CopyBtn text={attach} label="tmux attach" what="tmux attach line copied" />}
        <CopyBtn text={resume} label="Resume command" what="Resume command copied" />
        <CopyBtn text={sid} label="Session id" what="Session id copied" />
      </div>
      {!isRoot && <ScreenPeek agent={agent} />}
      {!isRoot && res && (
        <Section title="Latest result" aside={<span className="text-xs text-muted-foreground tabular">{ago(res.at, now)} ago</span>}>
          <div className={cn('border-l-2 pl-3.5', RESULT_TONE[res.status].rail)}>
            <span className={cn('mb-1.5 inline-flex h-5 items-center rounded-full px-2 text-[11px] leading-none font-medium', RESULT_TONE[res.status].chip)}>{RESULT_TONE[res.status].label}</span>
            <div className="max-h-72 overflow-y-auto"><Markdown text={res.text} handles={handles} className="text-sm" /></div>
          </div>
        </Section>
      )}
      {!isRoot && <Section title="Recent calls"><Calls agent={agent} detail={detail} /></Section>}
      <Section title={isRoot || !parent ? 'Conversation' : `Thread with @${parent.handle}`} aside={<span className="text-xs text-muted-foreground tabular">{thread.length}</span>}>
        {thread.length === 0 ? <p className="text-[13px] text-muted-foreground">No messages yet.</p> : (
          <div className="space-y-4">
            {thread.map((m) => <Message key={m.seq} m={m} compact captainId={summary.agent.id} captainHandle={summary.agent.handle} handles={handles} onAgent={m.from_id !== agent.id ? onAgent : undefined} onCard={onCard} />)}
          </div>
        )}
      </Section>
    </div>
  )
}

export function AgentSheet({ summary, fleet, messages, agentId, onClose, onAgent, onCard }: {
  summary: CaptainSummary
  fleet: Agent[]
  messages: MessageView[]
  agentId: string | null
  onClose: () => void
  onAgent: (id: string) => void
  onCard: (id: number) => void
}) {
  const agent = agentId ? fleet.find((a) => a.id === agentId) : undefined
  const handles = useMemo(() => new Set(fleet.map((a) => a.handle)), [fleet])
  const isRoot = agent?.id === summary.agent.id
  const line = agent ? (isRoot ? 'Captain · your session' : [agent.title, modelLine(agent)].filter(Boolean).join(' · ')) : ''
  return (
    <Sheet open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[520px]" data-testid="agent-sheet" onOpenAutoFocus={(e) => e.preventDefault()}>
        {agent && (
          <>
            <div className="shrink-0 px-5 pt-5 pb-4 pr-14">
              <div className="flex items-center gap-3">
                {isRoot ? <CaptainAvatar id={agent.id} handle={agent.handle} size="md" soft={false} /> : <AgentAvatar handle={agent.handle} size="md" />}
                <div className="min-w-0">
                  <SheetTitle className="flex items-center gap-2 text-base leading-6 font-semibold tracking-tight">
                    <span className="truncate">@{agent.handle}</span>
                    {!isRoot && <HarnessTag harness={agent.harness} />}
                  </SheetTitle>
                  <SheetDescription className="truncate text-[13px]">{line}</SheetDescription>
                </div>
              </div>
              <div className="mt-3 flex min-h-5 items-center gap-2.5 text-[13px]">
                {isRoot ? null : (
                  <span className={cn('inline-flex items-center gap-1.5', agent.state === 'crashed' ? 'text-bad' : agent.state === 'waiting' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
                    <StateDot state={agent.state} />{STATE_LABEL[agent.state]}
                  </span>
                )}
                {!isRoot && agent.last_update && <span className="min-w-0 truncate text-muted-foreground">{oneLine(agent.last_update)}</span>}
              </div>
            </div>
            <Body agent={agent} summary={summary} fleet={fleet} messages={messages} handles={handles} onAgent={onAgent} onCard={onCard} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
