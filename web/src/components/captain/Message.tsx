// One message of the Activity feed (§7.3): task (quiet surface), result (status rail), question (amber rail),
// chat, update (one muted line), system (small, centered). `compact` drops the avatar column (Agent sheet thread).
import { memo, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import type { MessageView } from '@shared/types'
import { cardKey } from '@shared/cards'
import { Markdown } from '@/components/sparrow/Markdown'
import { AgentAvatar, CaptainAvatar, RESULT_TONE } from '@/components/captains/primitives'
import { duration, systemNoticeText } from '@/lib/format'
import { resultStatus } from '@/lib/captains'
import { routeLabel, senderKind, timeOfDay } from '@/lib/captainPage'
import { cn } from '@/lib/utils'
import { useOverflow } from './hooks'

export interface MessageProps {
  m: MessageView
  captainId: string
  captainHandle: string
  handles: Set<string>
  /** A question nobody answered yet. */
  waiting?: boolean
  /** Directly after another update (closer spacing is applied by the parent; kept here for the dot rail). */
  compact?: boolean
  onAgent?: (id: string) => void
  onCard?: (id: number) => void
}

const FADE: CSSProperties = { maskImage: 'linear-gradient(to bottom, black calc(100% - 32px), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 32px), transparent)' }

/** Body clamped to `max` with a measured "Show more" (only when the content really overflows). */
function Clamped({ max, deps, children }: { max: string; deps: unknown[]; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [ref, over] = useOverflow<HTMLDivElement>([open, ...deps])
  return (
    <div>
      <div ref={ref} className={cn(!open && max, !open && 'overflow-hidden')} style={!open && over ? FADE : undefined}>{children}</div>
      {(over || open) && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 rounded text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex h-5 items-center rounded-full px-2 text-[11px] leading-none font-medium', className)}>{children}</span>
}

function Head({ m, onAgent, onCard, extra }: Pick<MessageProps, 'm' | 'onAgent' | 'onCard'> & { extra?: ReactNode }) {
  const { from, to } = routeLabel(m)
  return (
    <div className="mb-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] leading-5">
      <button type="button" disabled={!onAgent} onClick={() => onAgent?.(m.from_id)} className="rounded font-medium text-foreground enabled:hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">{from}</button>
      {to.length > 0 && <span className="text-muted-foreground">→ {to.join(' ')}</span>}
      <time className="text-xs text-muted-foreground tabular" dateTime={new Date(m.created_at).toISOString()}>{timeOfDay(m.created_at)}</time>
      {m.card_id != null && (
        <button type="button" onClick={() => onCard?.(m.card_id!)} className="rounded font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          {cardKey({ id: m.card_id, project_id: m.project_id })}
        </button>
      )}
      {extra}
    </div>
  )
}

function SystemNote({ m }: { m: MessageView }) {
  const [open, setOpen] = useState(false)
  const screen = typeof m.meta?.screen === 'string' ? (m.meta.screen as string) : null
  const lines = systemNoticeText(m.text, screen).split('\n').map((l) => l.trim()).filter(Boolean)
  const bad = /crash|exit|restart|failed|error/i.test(lines[0] ?? '') || typeof m.meta?.exit_code === 'number'
  return (
    <div className="flex flex-col items-center gap-1 px-2 py-1 text-center text-xs text-muted-foreground" data-kind="system">
      <div className="flex max-w-full items-center gap-1.5">
        {bad && <AlertTriangle aria-hidden className="size-3.5 shrink-0 text-bad/80" />}
        <span className="min-w-0 break-words">{lines[0]}</span>
        <time className="shrink-0 tabular text-muted-foreground/70">{timeOfDay(m.created_at)}</time>
      </div>
      {lines.slice(1, 3).map((l, i) => <span key={i} className="max-w-full break-words text-muted-foreground/80">{l}</span>)}
      {screen && (
        <>
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 rounded text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            <ChevronRight aria-hidden className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} />
            {open ? 'Hide last screen' : 'Show last screen'}
          </button>
          {open && <pre data-testid="last-screen" className="max-h-72 w-full overflow-auto rounded-lg bg-zinc-950 p-3 text-left font-mono text-[11px] leading-[1.5] whitespace-pre text-zinc-100 ring-1 ring-border/60">{screen}</pre>}
        </>
      )}
    </div>
  )
}

function MessageImpl({ m, captainId, captainHandle, handles, waiting, compact, onAgent, onCard }: MessageProps) {
  const kind = senderKind(m, captainId)

  if (m.kind === 'system') return <SystemNote m={m} />

  if (m.kind === 'update') {
    return (
      <div className="grid h-6 items-center text-[13px] text-muted-foreground" style={{ gridTemplateColumns: compact ? 'minmax(0,1fr) auto' : '28px minmax(0,1fr) auto', columnGap: compact ? 8 : 12 }} data-kind="update" title={m.text}>
        {!compact && <span aria-hidden className="grid place-items-center"><span className="size-1 rounded-full bg-muted-foreground/40" /></span>}
        <span className="truncate"><span className="font-medium text-foreground/70">@{m.from_handle}</span> {m.text.replace(/\s+/g, ' ')}</span>
        <time className="text-xs tabular text-muted-foreground/70">{timeOfDay(m.created_at)}</time>
      </div>
    )
  }

  const body = <Markdown text={m.text} handles={handles} className="text-sm" />
  const status = m.kind === 'result' ? resultStatus(m) : null
  const callMs = typeof m.meta?.call_ms === 'number' ? (m.meta.call_ms as number) : null
  let inner: ReactNode
  if (m.kind === 'task') {
    inner = (
      <>
        <Head m={m} onAgent={onAgent} onCard={onCard} />
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3.5 py-2.5">
          <div className="mb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Task</div>
          <Clamped max="max-h-[8.4rem]" deps={[m.text]}>{body}</Clamped>
        </div>
      </>
    )
  } else if (m.kind === 'result') {
    const tone = RESULT_TONE[status!]
    inner = (
      <>
        <Head m={m} onAgent={onAgent} onCard={onCard} />
        <div className={cn('border-l-2 pl-3.5', tone.rail)}>
          <div className="mb-1 flex items-center gap-2">
            <Chip className={tone.chip}>{tone.label}</Chip>
            {callMs != null && <span className="text-xs text-muted-foreground tabular">took {duration(callMs)}</span>}
          </div>
          <Clamped max="max-h-[18rem]" deps={[m.text]}>{body}</Clamped>
        </div>
      </>
    )
  } else if (m.kind === 'question') {
    const ask = m.to_handles.find((h) => h !== m.from_handle) ?? captainHandle
    inner = (
      <>
        <Head m={m} onAgent={onAgent} onCard={onCard} />
        <div className="border-l-2 border-l-warn pl-3.5">
          <div className="mb-1 flex items-center gap-2">
            <Chip className="bg-warn/15 text-amber-700 dark:text-amber-300">Question</Chip>
            {waiting && <span className="text-xs text-amber-700 dark:text-amber-300">waiting for @{ask}</span>}
          </div>
          <Clamped max="max-h-[18rem]" deps={[m.text]}>{body}</Clamped>
        </div>
      </>
    )
  } else {
    inner = (
      <>
        <Head m={m} onAgent={onAgent} onCard={onCard} />
        {body}
      </>
    )
  }

  if (compact) return <div className="min-w-0" data-kind={m.kind}>{inner}</div>
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3" data-kind={m.kind}>
      <div className="pt-px">
        {kind === 'captain' ? <CaptainAvatar id={captainId} handle={captainHandle} size="md" /> : <AgentAvatar handle={m.from_handle} size="md" />}
      </div>
      <div className="min-w-0">{inner}</div>
    </div>
  )
}

export const Message = memo(MessageImpl)
