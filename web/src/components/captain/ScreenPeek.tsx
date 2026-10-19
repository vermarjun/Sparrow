// Live screen peek of an agent's tmux window (§7.3): terminal look, polled every 2 s while working, scrolled to the end.
import { useLayoutEffect, useRef } from 'react'
import type { Agent } from '@shared/types'
import { agoLabel } from '@/lib/format'
import { useNow } from '@/components/sparrow/bits'
import { cn } from '@/lib/utils'
import { useScreen } from './hooks'

export function ScreenPeek({ agent, className }: { agent: Agent; className?: string }) {
  const working = agent.state === 'working'
  const { screen, error } = useScreen(agent.id, working)
  const now = useNow(15000)
  const pre = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)

  // Pinned to the end on open and while new text arrives (a second pass after layout settles in the opening sheet).
  useLayoutEffect(() => {
    const el = pre.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
    const raf = requestAnimationFrame(() => { if (pinned.current) el.scrollTop = el.scrollHeight })
    return () => cancelAnimationFrame(raf)
  }, [screen?.text])

  const text = screen?.text?.trimEnd()
  return (
    <section className={className} data-testid="screen-peek">
      <div className="mb-2 flex h-5 items-center justify-between text-xs text-muted-foreground">
        <h3 className="font-medium text-foreground">Screen</h3>
        {screen?.live ? (
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full bg-ok sp-breathe" />live</span>
        ) : screen?.at ? (
          <span>snapshot · {agoLabel(screen.at, now)}</span>
        ) : screen ? <span>no window</span> : null}
      </div>
      {!screen && !error ? (
        <div className="h-80 animate-pulse rounded-lg bg-muted" />
      ) : (
        <pre
          ref={pre}
          data-testid="screen"
          tabIndex={0}
          aria-label={`Screen of @${agent.handle}`}
          onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
          className={cn('h-80 overflow-auto rounded-lg bg-zinc-950 px-3 py-4 font-mono text-[11px] leading-4 whitespace-pre text-zinc-100 ring-1 ring-border/60 outline-none focus-visible:ring-2 focus-visible:ring-ring/50', !text && 'text-zinc-500')}
        >
          {error ? `Could not load the screen: ${error}` : text || 'Nothing captured yet.'}
        </pre>
      )}
    </section>
  )
}
