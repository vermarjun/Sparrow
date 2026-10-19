import { useState } from 'react'
import { RefreshCw, Stethoscope, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { DoctorCheck, HarnessCatalog } from '@shared/types'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { CHECK_DOT, HARNESSES, groupChecks, providerSummary, healthVerdict, summarizeChecks } from '@/lib/catalog'
import { agoLabel, clock, duration, plural } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CopyButton, Empty, HarnessLabel, PathText, useNow } from '@/components/sparrow/bits'

const TONE = {
  ok: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30',
  bad: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-500/30',
  warn: 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30',
  none: 'bg-muted/50 text-muted-foreground border-border',
}

export function DoctorPage() {
  const run = useStore((s) => s.doctorRun)
  const health = useStore((s) => s.health)
  const loaded = useStore((s) => s.doctorLoaded)
  const [starting, setStarting] = useState(false)
  const running = !!run && !run.ended_at
  const now = useNow(running ? 1000 : 5000)
  const groups = groupChecks(run)

  const start = async () => {
    setStarting(true)
    try {
      const { run } = await api.runDoctor()
      useStore.setState({ doctorRun: run })
    } catch (e) {
      toast.error(`Could not start the doctor: ${(e as Error).message}`)
      void useStore.getState().loadDoctor()
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-semibold">Doctor</h1>
          <span className="text-xs text-muted-foreground" data-testid="doctor-last-run">
            {running
              ? `running since ${clock(run.started_at, now)} · ${duration(Math.max(0, now - run.started_at))}`
              : run?.ended_at
                ? `last run ${agoLabel(run.ended_at, now)} (${clock(run.ended_at, now)}) · took ${duration(run.ended_at - run.started_at)}`
                : 'never run'}
          </span>
          {run && <span className="text-xs text-muted-foreground">· {summarizeChecks(run.checks)}</span>}
          <Button size="sm" className="ml-auto" onClick={start} disabled={running || starting} data-testid="run-doctor">
            <Stethoscope className={cn(running && 'animate-pulse')} />
            {running ? 'Running…' : run ? 'Run doctor again' : 'Run doctor'}
          </Button>
        </div>

        <ProviderPanel />

        {!run ? (
          <div className="rounded-xl border bg-background">
            <Empty title={loaded ? 'The doctor has not run yet' : 'Loading…'} className="py-14">
              {loaded && (
                <>
                  <p>
                    <b>Run doctor</b> checks tmux, the server port, the <code className="rounded bg-muted px-1">sparrow</code> CLI, skills and hooks, then for
                    Claude Code, Codex and OpenCode: installed, logged in, model list, opens in tmux, and a live round trip (a real agent is hired with the
                    cheapest model, reports, and closes). It takes a minute or two and costs a few cents.
                  </p>
                  <p className="mt-2">Sparrow never fixes a harness itself: a failing check shows the command to run, then you run the doctor again.</p>
                </>
              )}
            </Empty>
          </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-3">
              {HARNESSES.map((h) => {
                const v = healthVerdict(health.find((x) => x.harness === h))
                const changed = run.version_changed.includes(h)
                const checks = groups.byHarness[h]
                return (
                  <section key={h} className="flex flex-col rounded-xl border bg-background" data-harness-card={h}>
                    <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
                      <HarnessLabel harness={h} className="text-sm font-medium text-foreground" />
                      {run.versions[h] && <span className="font-mono text-[11px] text-muted-foreground">v{run.versions[h]}</span>}
                      {changed && (
                        <span className="inline-flex h-5 items-center gap-1 rounded-full border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/15 px-2 text-[11px] font-medium text-violet-700 dark:text-violet-300" title="The harness version changed since the previous run; every check ran again on the new version.">
                          <Sparkles className="size-3" /> re-verified on new version
                        </span>
                      )}
                      <span className={cn('ml-auto inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium', running ? TONE.none : TONE[v.tone])}>
                        {running ? 'checking…' : v.label}
                      </span>
                    </header>
                    <ul className="divide-y">
                      {checks.map((c) => <CheckRow key={c.id} check={c} />)}
                      {checks.length === 0 && <li className="px-4 py-3 text-xs text-muted-foreground">No checks for this harness in this run.</li>}
                    </ul>
                  </section>
                )
              })}
            </div>
            {groups.shared.length > 0 && (
              <section className="rounded-xl border bg-background" data-testid="shared-checks">
                <header className="border-b px-4 py-2.5 text-sm font-medium">Shared checks</header>
                <ul className="grid divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-5 [&>li]:sm:border-r [&>li:last-child]:border-r-0">
                  {groups.shared.map((c) => <CheckRow key={c.id} check={c} />)}
                </ul>
              </section>
            )}
          </>
        )}
        <CatalogPanel />
      </div>
    </div>
  )
}

/** Providers whose agents returned errors (D2): degraded ones are warnings until a later call succeeds. */
function ProviderPanel() {
  const providers = useStore((s) => s.providers)
  const now = useNow(15000)
  if (!providers.length) return null
  return (
    <section className="rounded-xl border bg-background" data-testid="provider-panel">
      <header className="border-b px-4 py-2.5 text-sm font-medium">Model providers <span className="text-xs font-normal text-muted-foreground">· counted from agents' provider errors; cleared by the next successful call</span></header>
      <ul className="divide-y">
        {providers.map((p) => (
          <li key={`${p.harness}/${p.provider}`} className="px-4 py-2.5" data-provider={`${p.harness}/${p.provider}`} data-degraded={p.degraded}>
            <div className="flex items-center gap-2">
              <span className={cn('inline-block size-2 shrink-0 rounded-full', p.degraded ? 'bg-amber-500' : p.errors ? 'bg-amber-300' : 'bg-emerald-500')} />
              <HarnessLabel harness={p.harness} className="text-[13px] font-medium text-foreground" />
              <span className="font-mono text-xs">{p.provider}</span>
              <span className={cn('inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium', p.degraded ? TONE.warn : p.errors ? TONE.warn : TONE.ok)}>
                {p.degraded ? 'degraded' : p.errors ? `${p.errors} error${p.errors === 1 ? '' : 's'}` : 'recovered'}
              </span>
              {p.last_error_at && <span className="ml-auto text-[11px] text-muted-foreground">last error {agoLabel(p.last_error_at, now)}</span>}
            </div>
            <p className="mt-0.5 pl-4 text-xs break-words text-muted-foreground">{providerSummary(p)}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function CheckRow({ check: c }: { check: DoctorCheck }) {
  return (
    <li className="px-4 py-2.5" data-check={c.id} data-status={c.status}>
      <div className="flex items-center gap-2">
        <span className={cn('inline-block size-2 shrink-0 rounded-full', CHECK_DOT[c.status])} title={c.status} />
        <span className="text-[13px] font-medium">{c.label}</span>
        <span className={cn('text-[11px]', c.status === 'fail' ? 'text-red-700 dark:text-red-300' : c.status === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{c.status}</span>
        {c.duration_ms != null && <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{c.duration_ms < 1000 ? `${c.duration_ms} ms` : duration(c.duration_ms)}</span>}
      </div>
      {c.detail && <p className="mt-0.5 pl-4 text-xs break-words text-muted-foreground">{c.detail}</p>}
      {c.fix && (c.status === 'warn' || c.status === 'fail') && (
        <div className={cn('mt-1.5 ml-4 flex items-start gap-1 rounded-md px-2 py-1.5 ring-1', c.status === 'fail' ? 'bg-red-50/60 dark:bg-red-500/10 ring-red-200 dark:ring-red-500/30' : 'bg-amber-50/60 dark:bg-amber-500/10 ring-amber-200 dark:ring-amber-500/30')} data-testid="fix">
          <code className="min-w-0 flex-1 font-mono text-[11.5px] break-all whitespace-pre-wrap text-foreground">{c.fix}</code>
          <CopyButton text={c.fix} label="Copy fix" className="-my-0.5" />
        </div>
      )}
    </li>
  )
}

function CatalogPanel() {
  const catalogs = useStore((s) => s.catalogs)
  const loaded = useStore((s) => s.catalogLoaded)
  const [busy, setBusy] = useState(false)
  const now = useNow(15000)

  const refresh = async () => {
    setBusy(true)
    try {
      const list = await api.refreshCatalog()
      useStore.setState({ catalogs: list })
      const bad = list.filter((c) => !c.ok).map((c) => c.harness)
      if (bad.length) toast.error(`Model list failed for ${bad.join(', ')}`)
      else toast.success(`Model lists refreshed (${plural(list.reduce((n, c) => n + c.models.length, 0), 'model')})`)
    } catch (e) {
      toast.error(`Refresh failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const byHarness = new Map<string, HarnessCatalog>(catalogs.map((c) => [c.harness, c]))
  return (
    <section className="rounded-xl border bg-background" data-testid="catalog-panel">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="text-sm font-medium">Model catalog</span>
        <span className="text-xs text-muted-foreground">loaded when the server starts; used by resume dropdowns and the hire check</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={refresh} disabled={busy} data-testid="refresh-models">
          <RefreshCw className={cn(busy && 'animate-spin')} /> {busy ? 'Refreshing…' : 'Refresh models'}
        </Button>
      </header>
      <div className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {HARNESSES.map((h) => {
          const c = byHarness.get(h)
          const hidden = c?.models.filter((m) => m.hidden).length ?? 0
          return (
            <div key={h} className="px-4 py-3" data-catalog={h}>
              <div className="flex items-center gap-2">
                <HarnessLabel harness={h} className="font-medium text-foreground" />
                {c?.version && <span className="font-mono text-[11px] text-muted-foreground">v{c.version}</span>}
                {c && <span className={cn('ml-auto inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium', c.ok ? TONE.ok : TONE.bad)}>{c.ok ? 'ok' : 'failed'}</span>}
              </div>
              {!c ? (
                <p className="mt-1 text-xs text-muted-foreground" data-testid={`catalog-loading-${h}`}>{loaded ? 'loading models…' : 'Loading…'}</p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-foreground/80">
                    <b className="tabular-nums">{c.models.length}</b> models{hidden ? ` (${hidden} hidden)` : ''} · fetched {agoLabel(c.fetched_at, now)}
                  </p>
                  {c.binary && <p className="text-[11px] text-muted-foreground"><PathText path={c.binary} max={44} /></p>}
                  {c.error && <p className="mt-1 rounded-md bg-red-50/60 dark:bg-red-500/10 px-2 py-1 text-xs text-red-800 dark:text-red-300 ring-1 ring-red-200 dark:ring-red-500/30">{c.error}</p>}
                </>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
