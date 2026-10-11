import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Agent, AgentState } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { middleTruncate, splitMentions, tmuxAttach, tmuxSwitch } from '@/lib/format'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export const STATE_STYLE: Record<AgentState, { dot: string; badge: string; label: string }> = {
  working: { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'working' },
  queued: { dot: 'bg-sky-400', badge: 'bg-sky-50 text-sky-700 border-sky-200', label: 'queued' },
  waiting: { dot: 'bg-amber-400', badge: 'bg-amber-50 text-amber-700 border-amber-200', label: 'waiting' },
  idle: { dot: 'bg-zinc-300', badge: 'bg-zinc-50 text-zinc-600 border-zinc-200', label: 'idle' },
  crashed: { dot: 'bg-red-500', badge: 'bg-red-50 text-red-700 border-red-200', label: 'crashed' },
  retired: { dot: 'bg-zinc-200', badge: 'bg-transparent text-zinc-400 border-zinc-200', label: 'retired' },
}

export function StateDot({ state, className }: { state: AgentState | 'human'; className?: string }) {
  if (state === 'human') return <span className={cn('inline-block size-2 rounded-full bg-violet-400', className)} />
  const s = STATE_STYLE[state]
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} title={s.label}>
      {state === 'working' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-60" />}
      <span className={cn('relative inline-block size-2 rounded-full', s.dot)} />
    </span>
  )
}

export function StateBadge({ agent }: { agent: Agent }) {
  if (agent.kind === 'human') {
    return <span className="inline-flex h-5 items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2 text-[11px] font-medium text-violet-700">you</span>
  }
  const s = STATE_STYLE[agent.state]
  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium', s.badge)}>
      <StateDot state={agent.state} />
      {s.label}
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
        s.mention ? <span key={i} className="rounded bg-blue-50 px-0.5 font-medium text-blue-700">{s.text}</span> : <span key={i}>{s.text}</span>,
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

/** Copy menu for the tmux target: attach from a plain terminal, or switch from inside tmux. */
export function TmuxCopyMenu({ agent, className }: { agent: Pick<Agent, 'tmux_session' | 'tmux_window'>; className?: string }) {
  const [done, setDone] = useState<string | null>(null)
  const copy = async (text: string, which: string) => {
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
    setDone(which)
    setTimeout(() => setDone(null), 1200)
  }
  const options = [
    { id: 'attach', label: 'attach (outside tmux)', cmd: tmuxAttach(agent) },
    { id: 'switch', label: 'switch (inside tmux)', cmd: tmuxSwitch(agent) },
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className={cn('text-muted-foreground', className)} aria-label="Copy tmux command" onClick={(e) => e.stopPropagation()}>
          {done ? <Check className="text-emerald-600" /> : <Copy />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-64" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-xs">Copy tmux command</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => void copy(o.cmd, o.id)} className="flex flex-col items-start gap-0.5" data-tmux={o.id}>
            <span className="text-xs font-medium">{o.label}</span>
            <code className="font-mono text-[11px] text-muted-foreground">{o.cmd}</code>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
