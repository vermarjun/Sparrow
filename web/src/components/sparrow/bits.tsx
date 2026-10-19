import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentState } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { middleTruncate, splitMentions } from '@/lib/format'

export const STATE_STYLE: Record<AgentState, { dot: string; label: string }> = {
  working: { dot: 'bg-ok', label: 'working' },
  queued: { dot: 'bg-ok/40', label: 'queued' },
  waiting: { dot: 'bg-warn', label: 'waiting' },
  idle: { dot: 'bg-zinc-300 dark:bg-zinc-600', label: 'idle' },
  crashed: { dot: 'bg-bad', label: 'crashed' },
  retired: { dot: 'bg-zinc-200 dark:bg-zinc-700', label: 'retired' },
}

export function StateDot({ state, className }: { state: AgentState | 'human'; className?: string }) {
  if (state === 'human') return <span className={cn('inline-block size-2 rounded-full bg-violet-400', className)} />
  const s = STATE_STYLE[state]
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} title={s.label}>
      <span className={cn('relative inline-block size-2 rounded-full', s.dot, state === 'working' && 'sp-breathe')} />
    </span>
  )
}

const HARNESS: Record<string, { label: string; cls: string }> = {
  claude: { label: 'Claude', cls: 'bg-orange-400' },
  codex: { label: 'Codex', cls: 'bg-sky-500' },
  opencode: { label: 'OpenCode', cls: 'bg-emerald-500' },
  fake: { label: 'fake', cls: 'bg-zinc-400' },
  human: { label: 'your session', cls: 'bg-violet-400' },
}

export function HarnessLabel({ harness, className }: { harness: string; className?: string }) {
  const h = HARNESS[harness] ?? { label: harness, cls: 'bg-zinc-400' }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-foreground/80', className)}>
      <span className={cn('size-2 rounded-[3px]', h.cls)} />
      {h.label}
    </span>
  )
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setDone(true)
    setTimeout(() => setDone(false), 1200)
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" className={cn('text-muted-foreground', className)} onClick={copy} aria-label={label ?? 'Copy'}>
          {done ? <Check className="text-emerald-600" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{done ? 'Copied' : (label ?? 'Copy')}</TooltipContent>
    </Tooltip>
  )
}

export function MentionText({ text, handles, className }: { text: string; handles?: Set<string>; className?: string }) {
  return (
    <span className={className}>
      {splitMentions(text, handles).map((s, i) =>
        s.mention ? <span key={i} className="rounded bg-muted px-0.5 font-medium text-foreground">{s.text}</span> : <span key={i}>{s.text}</span>,
      )}
    </span>
  )
}

export function Empty({ title, children, className }: { title: string; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center text-sm text-muted-foreground', className)}>
      <div className="font-medium text-foreground/80">{title}</div>
      {children && <div className="max-w-sm text-xs leading-relaxed">{children}</div>}
    </div>
  )
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** Middle-truncated monospace path with the full path in a tooltip. */
export function PathText({ path, max = 40, className }: { path: string; max?: number; className?: string }) {
  const short = middleTruncate(path.replace(/^\/Users\/[^/]+/, '~'), max)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('font-mono whitespace-nowrap', className)}>{short}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-none font-mono">{path}</TooltipContent>
    </Tooltip>
  )
}
