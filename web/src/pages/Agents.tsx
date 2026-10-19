import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, TerminalSquare } from 'lucide-react'
import type { Agent } from '@shared/types'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, type AgentDetail, type Screen } from '@/lib/api'
import { ago, agoLabel, buildTree, clock, duration, flattenTree, jobResult, quietMinutes, tmuxAttach } from '@/lib/format'
import { useStore } from '@/lib/store'
import { isOlderResume, resumeHref, runLabel } from '@/lib/catalog'
import { OlderResumeBadge } from '@/pages/Resumes'
import { cn } from '@/lib/utils'
import { CopyButton, Empty, HarnessLabel, PathText, StateBadge, TmuxCopyMenu, useNow } from '@/components/sparrow/bits'

const DEFAULT_QUIET = 15

function useQuietLimit() {
  const resumes = useStore((s) => s.resumes)
  return (a: Agent) => resumes[a.resume]?.limits?.quiet_minutes ?? DEFAULT_QUIET
}

const RESULT_LABEL = { ok: 'done ok', blocked: 'blocked', failed: 'failed' } as const
const RESULT_CHIP = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  blocked: 'border-amber-200 bg-amber-50 text-amber-800',
  failed: 'border-red-200 bg-red-50 text-red-700',
} as const

const shortId = (s: string | null) => (s ? (s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s) : '—')

export function AgentsPage() {
  const agents = useStore((s) => s.agents)
  const [showRetired, setShowRetired] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const now = useNow(15000)
  const quietLimit = useQuietLimit()
  const resumes = useStore((s) => s.resumes)

  const all = Object.values(agents)
  const retired = all.filter((a) => a.state === 'retired').length
  const rows = useMemo(
    () => flattenTree(buildTree(Object.values(agents).filter((a) => showRetired || a.state !== 'retired'))),
    [agents, showRetired],
  )
  const counts = all.reduce<Record<string, number>>((acc, a) => {
    if (a.kind !== 'human') acc[a.state] = (acc[a.state] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 px-4">
        <h1 className="text-sm font-semibold">Agents</h1>
        <span className="text-xs text-muted-foreground">
          {(['working', 'queued', 'waiting', 'idle', 'crashed'] as const).filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(' · ') || 'nobody hired yet'}
        </span>
        {retired > 0 && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} className="accent-zinc-700" />
            show {retired} retired
          </label>
        )}
      </div>
      <div className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-xl border bg-background">
        {rows.length === 0 ? (
          <Empty title="No agents yet" className="h-full">
            Your captain session hires agents with <code className="rounded bg-muted px-1">sparrow hire &lt;resume&gt; "task"</code>. Each one opens in its own tmux window.
          </Empty>
        ) : (
          <Table className="text-[13px]">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="text-[11px] tracking-wide uppercase hover:bg-transparent">
                <TableHead className="h-8 pl-4">Agent</TableHead>
                <TableHead className="h-8">Harness</TableHead>
                <TableHead className="h-8">State</TableHead>
                <TableHead className="h-8">Where</TableHead>
                <TableHead className="h-8">Session</TableHead>
                <TableHead className="h-8 pr-4">Last update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ agent: a, depth }) => {
                const quiet = a.state === 'working' ? quietMinutes(a, now) : 0
                const isQuiet = a.state === 'working' && quiet >= quietLimit(a)
                return (
                  <TableRow key={a.id} onClick={() => setOpen(a.id)} className={cn('cursor-pointer', a.state === 'retired' && 'opacity-55')} data-agent={a.handle}>
                    <TableCell className="py-2 pl-4">
                      <div className="flex items-center" style={{ paddingLeft: depth * 20 }}>
                        {depth > 0 && <span className="mr-2 -ml-1 h-3.5 w-3 shrink-0 rounded-bl-md border-b border-l border-zinc-300" />}
                        <div className="min-w-0">
                          <div className="font-semibold">@{a.handle}</div>
                          <div className="truncate text-xs text-muted-foreground">{a.kind === 'human' ? 'captain · your session' : a.title}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <HarnessLabel harness={a.harness} />
                      {a.kind !== 'human' && <div className="text-xs text-muted-foreground">{a.model ?? 'default'}{a.effort ? ` · ${a.effort}` : ''}</div>}
                      {a.last_run && a.kind !== 'human' && (
                        <div className="text-[11px] text-muted-foreground/80" title="What the latest call actually launched with" data-last-run>last run: {runLabel(a.last_run)}</div>
                      )}
                      {isOlderResume(a, resumes[a.resume]) && <div className="mt-0.5"><OlderResumeBadge /></div>}
                    </TableCell>
                    <TableCell className="py-2">
                      <div className="flex flex-col items-start gap-1">
                        <StateBadge agent={a} />
                        {isQuiet && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
                            <AlertTriangle className="size-3" /> quiet {quiet}m
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-72 py-2">
                      <div className="text-xs text-zinc-600"><PathText path={a.cwd} max={40} /></div>
                      {a.kind !== 'human' && (
                        <div className="flex items-center gap-0.5 font-mono text-xs text-muted-foreground">
                          <span className="truncate">{a.tmux_session}:{a.tmux_window}{a.tmux_window_id ? ` (${a.tmux_window_id})` : ''}</span>
                          <TmuxCopyMenu agent={a} />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="py-2">
                      {a.session_id ? (
                        <div className="flex items-center gap-0.5 font-mono text-xs text-zinc-600">
                          <span title={a.session_id}>{shortId(a.session_id)}</span>
                          <CopyButton text={a.session_id} label="Copy session id" />
                        </div>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="max-w-96 py-2 pr-4">
                      <LastActivity agent={a} now={now} />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <AgentSheet agentId={open} onClose={() => setOpen(null)} />
    </div>
  )
}

/** An idle agent whose last call ended `done` shows how the job ended; everyone else shows the latest progress update. */
export function LastActivity({ agent: a, now }: { agent: Agent; now: number }) {
  const res = jobResult(a)
  if (res) {
    return (
      <div className="flex items-baseline gap-2" data-testid="job-result" data-result-status={res.status}>
        <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium whitespace-nowrap', RESULT_CHIP[res.status])}>{RESULT_LABEL[res.status]}</span>
        <span className="line-clamp-2 text-xs text-zinc-700">{res.line}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{ago(res.at, now)}</span>
      </div>
    )
  }
  const providerError = a.state === 'idle' && a.last_end_reason === 'provider_error'
  if (!a.last_update && !providerError) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex items-baseline gap-2">
      {providerError && (
        <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-amber-200 bg-amber-50 px-2 text-[11px] font-medium whitespace-nowrap text-amber-800" title="The model provider answered with an error; message the agent to retry" data-testid="provider-error-chip">provider error</span>
      )}
      {a.last_update && <span className="line-clamp-2 text-xs text-zinc-700">{a.last_update}</span>}
      {a.last_update && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{ago(a.last_update_at, now)}</span>}
    </div>
  )
}

function AgentSheet({ agentId, onClose }: { agentId: string | null; onClose: () => void }) {
  const agent = useStore((s) => (agentId ? s.agents[agentId] : undefined))
  const lastCall = useStore((s) => s.lastCall)
  const resumes = useStore((s) => s.resumes)
  const agents = useStore((s) => s.agents)
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const now = useNow(5000)

  // Detail (calls, children): on open, on state change, and on call events for this agent.
  const callKey = lastCall && lastCall.agent_id === agentId ? lastCall.at : 0
  useEffect(() => {
    if (!agentId) { setDetail(null); return }
    let live = true
    api.agent(agentId).then((d) => live && setDetail(d)).catch(() => {})
    return () => { live = false }
  }, [agentId, agent?.state, callKey])

  const resume = agent ? resumes[agent.resume] : undefined
  const parent = agent?.parent_id ? agents[agent.parent_id] : null

  return (
    <Sheet open={!!agentId && !!agent} onOpenChange={(o) => !o && onClose()}>
      <SheetContent onOpenAutoFocus={(e) => e.preventDefault()} className="gap-0 p-0 data-[side=right]:w-[min(800px,92vw)] data-[side=right]:sm:max-w-[800px]">
        {agent && (
          <>
            <SheetHeader className="border-b px-5 pt-5 pb-4">
              <div className="flex items-center gap-2 pr-8">
                <SheetTitle className="text-base">@{agent.handle}</SheetTitle>
                <StateBadge agent={agent} />
                <span className="ml-auto"><HarnessLabel harness={agent.harness} /></span>
              </div>
              <SheetDescription className="text-xs">
                {agent.kind === 'human' ? 'Captain — your own session; never spawned by Sparrow.' : `${agent.title}${resume?.description ? ` — ${resume.description}` : ''}`}
              </SheetDescription>
              <dl className="mt-3 grid grid-cols-[88px_minmax(0,1fr)_88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                <Field k="resume">
                  <a className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500" href={resumeHref(agent.resume)}>{agent.resume}</a>
                  {isOlderResume(agent, resume) && <span className="ml-1.5"><OlderResumeBadge /></span>}
                </Field>
                <Field k="parent">{parent ? `@${parent.handle}` : '—'}</Field>
                <Field k="model">{agent.model ?? 'harness default'}</Field>
                <Field k="effort">{agent.effort ?? 'default'}</Field>
                <Field k="last run" wide>{runLabel(agent.last_run) ?? '—'}{agent.last_run && <span className="ml-1.5 text-muted-foreground">· {agoLabel(agent.last_run.at, now)}</span>}</Field>
                <Field k="cwd" wide mono>{agent.cwd}</Field>
                {agent.kind !== 'human' && (
                  <Field k="tmux" wide mono>
                    <span className="truncate">{tmuxAttach(agent)}</span>
                    <TmuxCopyMenu agent={agent} />
                  </Field>
                )}
                <Field k="session" wide mono>
                  <span className="truncate">{agent.session_id ?? '— (not known yet)'}</span>
                  {agent.session_id && <CopyButton text={agent.session_id} label="Copy session id" />}
                </Field>
                <Field k="agent id" wide mono>
                  <span className="truncate">{agent.id}</span>
                  <CopyButton text={agent.id} label="Copy agent id" />
                </Field>
                <Field k="last seen">{agoLabel(agent.last_seen_at, now)}</Field>
                <Field k="last end">{agent.last_end_reason ?? '—'}</Field>
              </dl>
              {agent.last_update && (
                <div className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-700 ring-1 ring-zinc-200">
                  <span className="font-medium">Last update</span> <span className="text-muted-foreground">· {ago(agent.last_update_at, now)}</span>
                  <div className="mt-0.5 whitespace-pre-wrap">{agent.last_update}</div>
                </div>
              )}
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {agent.kind !== 'human' && <ScreenPeek agent={agent} />}
              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent calls</h3>
                {!detail ? <p className="text-xs text-muted-foreground">Loading…</p> : detail.calls.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No calls yet.</p>
                ) : (
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="h-7">Started</TableHead>
                        <TableHead className="h-7">Duration</TableHead>
                        <TableHead className="h-7">End</TableHead>
                        <TableHead className="h-7">Exit</TableHead>
                        <TableHead className="h-7">Session</TableHead>
                        <TableHead className="h-7">Ran with</TableHead>
                        <TableHead className="h-7 text-right">Nudges · restarts</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.calls.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="py-1.5 tabular-nums">{clock(c.started_at, now)}</TableCell>
                          <TableCell className="py-1.5 tabular-nums">{c.ended_at ? duration(c.ended_at - c.started_at) : <span className="text-emerald-700">{duration(now - c.started_at)} · open</span>}</TableCell>
                          <TableCell className="py-1.5">
                            <span className={cn(c.end_reason === 'crashed' && 'text-red-600', c.end_reason === 'unreported' && 'text-amber-700')}>{c.end_reason ?? '—'}</span>
                          </TableCell>
                          <TableCell className="py-1.5 tabular-nums">{c.exit_code ?? '—'}</TableCell>
                          <TableCell className="py-1.5">{c.resumed ? 'resumed' : 'fresh'}</TableCell>
                          <TableCell className="py-1.5 text-muted-foreground">{c.harness ? [c.model ?? 'default', c.effort].filter(Boolean).join(' · ') : '—'}</TableCell>
                          <TableCell className="py-1.5 text-right tabular-nums">{c.nudges} · {c.restarts}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </section>
              {detail && detail.children.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Hired · {detail.children.length}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.children.map((c) => <span key={c.id} className="inline-flex items-center gap-1.5"><StateBadge agent={c} /><span className="text-xs">@{c.handle}</span></span>)}
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Field({ k, children, wide, mono }: { k: string; children: React.ReactNode; wide?: boolean; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('flex min-w-0 items-center gap-0.5 text-foreground', wide && 'col-span-3', mono && 'font-mono text-[11.5px]')}>{children}</dd>
    </>
  )
}

function ScreenPeek({ agent }: { agent: Agent }) {
  const [screen, setScreen] = useState<Screen | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  const working = agent.state === 'working'
  const now = useNow(5000)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const s = await api.screen(agent.id, 200)
        if (!live) return
        setScreen(s); setErr(null)
      } catch (e) {
        if (live) setErr((e as Error).message)
      }
      if (live && working) timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [agent.id, working])

  useLayoutEffect(() => {
    const el = pre.current
    if (el) el.scrollTop = el.scrollHeight
  }, [screen?.text])

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <TerminalSquare className="size-3.5" /> Screen
        <span className="font-normal tracking-normal normal-case">
          {screen?.live ? (
            <span className="inline-flex items-center gap-1 text-emerald-700"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> live · refreshes every 2 s</span>
          ) : screen?.at ? `last snapshot · ${agoLabel(screen.at, now)}` : screen ? 'no window' : ''}
        </span>
      </h3>
      <pre ref={pre} className="h-[max(12rem,min(45vh,calc(100vh_-_34rem)))] overflow-auto rounded-lg bg-[#16181d] px-3 py-2.5 font-mono text-[12px] leading-[1.35] break-normal whitespace-pre text-zinc-200 shadow-inner [overflow-wrap:normal]" data-testid="screen">
        {err ? `Could not load the screen: ${err}` : screen?.text?.trimEnd() || (screen ? 'Nothing captured yet.' : 'Loading…')}
      </pre>
    </section>
  )
}
