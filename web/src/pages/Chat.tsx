import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Eye } from 'lucide-react'
import type { Agent, MessageView } from '@shared/types'
import type { ThreadRow } from '@/lib/api'
import { ago, clock, previewLine, systemNoticeText, threadTitle } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Empty, MentionText, StateDot, useNow } from '@/components/sparrow/bits'
import { Markdown } from '@/components/sparrow/Markdown'

export function ChatPage() {
  const allThreads = useStore((s) => s.threads)
  const threads = allThreads.filter((t) => t.thread.startsWith('dm:'))
  const [selected, setSelected] = useState<string | null>(null)

  const current = selected && threads.some((t) => t.thread === selected) ? selected : (threads[0]?.thread ?? null)

  return (
    <div className="grid h-full grid-cols-[320px_minmax(0,1fr)] border-t-0">
      <ThreadList threads={threads} selected={current} onSelect={setSelected} />
      {current ? <ThreadView key={current} thread={current} /> : (
        <Empty title="No messages yet" className="h-full">
          Messages appear here when a captain hires an agent or agents talk with <code className="rounded bg-muted px-1">sparrow send</code>.
        </Empty>
      )}
    </div>
  )
}

function ThreadList({ threads, selected, onSelect }: { threads: ThreadRow[]; selected: string | null; onSelect: (t: string) => void }) {
  const agents = useStore((s) => s.agents)
  const now = useNow()
  return (
    <aside className="flex min-h-0 flex-col border-r bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {threads.length > 0 && <SectionLabel>Direct · {threads.length}</SectionLabel>}
        {threads.map((t) => <ThreadItem key={t.thread} t={t} agents={agents} now={now} active={t.thread === selected} onClick={() => onSelect(t.thread)} />)}
        {threads.length === 0 && <p className="px-4 py-6 text-xs text-muted-foreground">No threads yet.</p>}
      </div>
      <div className="flex items-center gap-1.5 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <Eye className="size-3" /> Read-only. Talk to agents from your captain session.
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</div>
}

function dmIds(thread: string): string[] {
  return thread.startsWith('dm:') ? thread.slice(3).split(':') : []
}

function ThreadItem({ t, agents, now, active, onClick }: { t: ThreadRow; agents: Record<string, Agent>; now: number; active: boolean; onClick: () => void }) {
  const other = dmIds(t.thread).map((id) => agents[id]).filter(Boolean).sort((a, b) => b.depth - a.depth)[0]
  const last = t.last
  return (
    <button onClick={onClick} className={cn('flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50', active && 'bg-zinc-100 hover:bg-zinc-100')}>
      <div className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-600 uppercase ring-1 ring-zinc-200">
        {(other?.handle ?? '?').slice(0, 2)}
        {other && other.kind !== 'human' && <StateDot state={other.state} className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-background" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium">{threadTitle(t.label)}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{last ? ago(last.created_at, now) : ''}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {last ? <><span className="text-foreground/70">{last.from_handle === 'system' ? 'system' : `@${last.from_handle}`}:</span> {previewLine(last.text)}</> : 'empty'}
          </span>
          <span className="ml-auto shrink-0 rounded-full bg-zinc-100 px-1.5 text-[10px] text-zinc-500 tabular-nums">{t.count}</span>
        </div>
      </div>
    </button>
  )
}



function ThreadView({ thread }: { thread: string }) {
  const row = useStore((s) => s.threads.find((t) => t.thread === thread))
  const messages = useStore((s) => s.messages[thread])
  const agents = useStore((s) => s.agents)
  const loadThread = useStore((s) => s.loadThread)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [unseen, setUnseen] = useState(0)
  const lastLen = useRef(0)

  useEffect(() => { void loadThread(thread) }, [thread, loadThread])

  const handles = useMemo(() => new Set(Object.values(agents).map((a) => a.handle)), [agents])
  const byHandle = useMemo(() => new Map(Object.values(agents).map((a) => [a.handle, a])), [agents])
  const members = dmIds(thread).map((id) => agents[id]).filter(Boolean).sort((a, b) => a.depth - b.depth)
  const senior = members.length ? members[0] : Object.values(agents).find((a) => a.kind === 'human')

  // Stick to the bottom unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !messages) return
    const added = messages.length - lastLen.current
    lastLen.current = messages.length
    if (pinned.current) el.scrollTop = el.scrollHeight
    else if (added > 0) setUnseen((n) => n + added)
  }, [messages])

  const onScroll = () => {
    const el = scroller.current!
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (pinned.current) setUnseen(0)
  }
  const toBottom = () => {
    const el = scroller.current!
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setUnseen(0)
  }

  const title = row ? threadTitle(row.label) : thread
  const memberLine = members.map((m) => `@${m.handle} (${m.kind === 'human' ? 'you' : m.title})`).join(' ↔ ')

  return (
    <section className="relative flex min-h-0 flex-col bg-[#f6f6f3]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">{memberLine}</div>
        </div>
        <div className="ml-auto text-[11px] text-muted-foreground tabular-nums">{row?.count ?? 0} messages</div>
      </div>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {!messages ? (
          <p className="py-10 text-center text-xs text-muted-foreground">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">No messages in this thread.</p>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {messages.map((m, i) => (
              <div key={m.seq} className="contents">
                {(i === 0 || dayKey(messages[i - 1].created_at) !== dayKey(m.created_at)) && <DayDivider at={m.created_at} />}
                <MessageRow m={m} right={!!senior && m.from_id === senior.id} handles={handles} from={byHandle.get(m.from_handle)} />
              </div>
            ))}
          </div>
        )}
      </div>
      {unseen > 0 && (
        <button onClick={toBottom} className="absolute right-6 bottom-5 flex items-center gap-1 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-md hover:bg-zinc-50">
          <ArrowDown className="size-3.5" /> {unseen} new
        </button>
      )}
    </section>
  )
}

const dayKey = (at: number) => new Date(at).toDateString()

function DayDivider({ at }: { at: number }) {
  const d = new Date(at)
  const today = new Date()
  const label = d.toDateString() === today.toDateString()
    ? 'Today'
    : d.toDateString() === new Date(Date.now() - 86400000).toDateString()
      ? 'Yesterday'
      : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return (
    <div className="my-1 flex justify-center">
      <span className="rounded-md bg-white/80 px-2.5 py-0.5 text-[11px] text-zinc-500 shadow-xs ring-1 ring-zinc-200/70">{label}</span>
    </div>
  )
}

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-emerald-600 text-white',
  blocked: 'bg-amber-500 text-white',
  failed: 'bg-red-600 text-white',
}

function MessageRow({ m, right, handles, from }: { m: MessageView; right: boolean; handles: Set<string>; from?: Agent }) {
  const time = clock(m.created_at)
  const fromLabel = m.from_handle === 'system' ? 'system' : `@${m.from_handle}`
  const to = m.to_handles.filter((h) => h !== m.from_handle)

  if (m.kind === 'system') {
    const screen = typeof m.meta?.screen === 'string' ? (m.meta.screen as string) : null
    return (
      <div className="my-1 flex flex-col items-center gap-1" data-kind="system">
        <div className="max-w-[85%] rounded-lg bg-zinc-200/70 px-3 py-1.5 text-center text-xs whitespace-pre-line text-zinc-700">
          <MentionText text={systemNoticeText(m.text, screen)} handles={handles} />
          <span className="ml-2 text-[10px] text-zinc-500">{time}</span>
        </div>
        {screen && (
          <details className="w-[85%] text-xs" data-testid="last-screen">
            <summary className="cursor-pointer text-center text-[11px] text-zinc-500">last screen</summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-zinc-900 p-2 font-mono text-[11px] leading-[1.4] whitespace-pre text-zinc-100">{screen}</pre>
          </details>
        )}
      </div>
    )
  }

  if (m.kind === 'update') {
    return (
      <div className={cn('flex gap-2 px-1 text-xs text-zinc-500', right && 'justify-end')} data-kind="update">
        <span className="shrink-0 font-medium text-zinc-600">{fromLabel}</span>
        <span className="min-w-0 break-words"><MentionText text={m.text} handles={handles} /></span>
        {m.card_id != null && <span className="shrink-0 text-zinc-400">#{m.card_id}</span>}
        <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{time}</span>
      </div>
    )
  }

  const status = m.kind === 'result' ? String(m.meta?.status ?? 'ok') : null
  const tone =
    m.kind === 'task' ? 'border-l-[3px] border-l-blue-500 bg-white'
      : m.kind === 'question' ? 'bg-amber-50 ring-amber-200'
        : m.kind === 'result' ? (status === 'failed' ? 'bg-red-50 ring-red-200' : status === 'blocked' ? 'bg-amber-50 ring-amber-200' : 'bg-emerald-50 ring-emerald-200')
          : right ? 'bg-[#e7f3ff]' : 'bg-white'
  const tag =
    m.kind === 'task' ? <Tag className="bg-blue-100 text-blue-700">task</Tag>
      : m.kind === 'question' ? <Tag className="bg-amber-200/70 text-amber-800">question</Tag>
        : m.kind === 'result' ? <Tag className={STATUS_STYLE[status!] ?? STATUS_STYLE.ok}>result · {status}</Tag>
          : null

  return (
    <div className={cn('flex', right ? 'justify-end' : 'justify-start')} data-kind={m.kind}>
      <div className={cn('max-w-[78%] min-w-48 rounded-xl px-3 py-2 shadow-xs ring-1 ring-zinc-200/80', right ? 'rounded-tr-sm' : 'rounded-tl-sm', tone)}>
        <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="inline-flex items-center gap-1 font-semibold text-zinc-800">
            {from && from.kind !== 'human' && <StateDot state={from.state} />}
            {fromLabel}
          </span>
          {to.length > 0 && <span className="text-zinc-400">→ {to.map((h) => `@${h}`).join(' ')}</span>}
          {tag}
          {m.card_id != null && <span className="rounded border border-zinc-200 bg-white/70 px-1 text-[10px] text-zinc-500">#{m.card_id}</span>}
        </div>
        <Markdown text={m.text} handles={handles} />
        <div className="mt-0.5 text-right text-[10px] text-zinc-400 tabular-nums">{time}</div>
      </div>
    </div>
  )
}

function Tag({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn('rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase', className)}>{children}</span>
}
