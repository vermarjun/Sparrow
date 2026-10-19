import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Save, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import type { SettingField, SettingKey, SettingsView } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { plural } from '@/lib/format'
import { fieldError } from '@/lib/settings'
import { cn } from '@/lib/utils'
import { Empty, PathText } from '@/components/sparrow/bits'

const DOCTOR_HARNESSES = ['claude', 'codex', 'opencode'] as const
const HARNESS_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }

type Draft = Record<SettingKey, string>
const draftOf = (v: SettingsView) => Object.fromEntries(v.fields.map((f) => [f.key, String(f.value)])) as Draft
const modelsOf = (v: SettingsView) => Object.fromEntries(DOCTOR_HARNESSES.map((h) => [h, v.doctor_models[h] ?? ''])) as Record<string, string>

export function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [models, setModels] = useState<Record<string, string>>({})
  const [serverErr, setServerErr] = useState<{ key: string | null; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const take = (v: SettingsView) => { setView(v); setDraft(draftOf(v)); setModels(modelsOf(v)) }
  useEffect(() => { api.settings().then(take).catch((e) => setLoadErr((e as Error).message)) }, [])

  const groups = useMemo(() => {
    const out: { name: string; fields: SettingField[] }[] = []
    for (const f of view?.fields ?? []) {
      const g = out.find((x) => x.name === f.group)
      if (g) g.fields.push(f)
      else out.push({ name: f.group, fields: [f] })
    }
    return out
  }, [view])

  if (loadErr) return <Empty title="Could not load settings" className="h-full">{loadErr}</Empty>
  if (!view || !draft) return <Empty title="Loading settings…" className="h-full" />

  const changed = view.fields.filter((f) => draft[f.key].trim() !== String(f.value))
  const changedModels = DOCTOR_HARNESSES.filter((h) => (models[h] ?? '').trim() !== (view.doctor_models[h] ?? ''))
  const invalid = changed.filter((f) => fieldError(f, draft[f.key]))
  const dirty = changed.length + changedModels.length

  const save = async () => {
    if (invalid.length) return
    setBusy(true); setServerErr(null)
    try {
      const values = Object.fromEntries(changed.map((f) => [f.key, Number(draft[f.key])]))
      const doctor_models = changedModels.length ? Object.fromEntries(changedModels.map((h) => [h, models[h].trim() || null])) : undefined
      take(await api.updateSettings({ values, ...(doctor_models ? { doctor_models } : {}) }))
      toast.success(`Saved ${plural(dirty, 'change')}; applied now`)
    } catch (e) {
      const msg = (e as Error).message
      setServerErr({ key: msg.match(/^([a-z_]+)(?:\.[a-z]+)?:/)?.[1] ?? null, msg })
    } finally { setBusy(false) }
  }

  const reset = async (f: SettingField) => {
    setBusy(true); setServerErr(null)
    try {
      const v = await api.updateSettings({ values: { [f.key]: null } })
      // Keep the user's other unsaved edits; only the reset field takes the server value.
      const kept = Object.fromEntries(view.fields.filter((x) => x.key !== f.key && draft[x.key].trim() !== String(x.value)).map((x) => [x.key, draft[x.key]]))
      setView(v); setDraft({ ...draftOf(v), ...kept })
      toast.success(`${f.label} reset to ${f.default} ${f.unit}`)
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 pb-24">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-sm font-semibold">Settings</h1>
          <span className="text-xs text-muted-foreground">Changes apply at once, no restart. Saved to <PathText path={view.file} max={48} /></span>
        </div>

        {serverErr && !serverErr.key && <div className="rounded-lg bg-red-50 dark:bg-red-500/15 px-3 py-2 text-xs text-red-800 dark:text-red-300 ring-1 ring-red-200 dark:ring-red-500/30" data-testid="settings-error">{serverErr.msg}</div>}

        {groups.map((g) => (
          <section key={g.name} className="rounded-xl border bg-background" data-group={g.name}>
            <h2 className="border-b px-4 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.name}</h2>
            <div className="divide-y">
              {g.fields.map((f) => {
                const text = draft[f.key]
                const isChanged = text.trim() !== String(f.value)
                const bad = isChanged ? fieldError(f, text) : null
                const srv = serverErr?.key === f.key ? serverErr.msg.replace(/^[a-z_]+:\s*/, '') : null
                return (
                  <div key={f.key} className="grid gap-x-6 gap-y-1.5 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto]" data-setting={f.key}>
                    <div className="min-w-0">
                      <label htmlFor={`s-${f.key}`} className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {f.label}
                        <code className="rounded bg-muted px-1 font-mono text-[11px] font-normal text-muted-foreground">{f.key}</code>
                        {f.saved && <span className="rounded-full border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/15 px-1.5 text-[10px] font-medium text-sky-800 dark:text-sky-300">custom</span>}
                        {f.env_override && <span className="rounded-full border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-800 dark:text-amber-300" title="Set by this server's SPARROW_SETTINGS environment variable">env</span>}
                      </label>
                      <p className="mt-0.5 text-xs text-muted-foreground">{f.help}</p>
                      {f.key === 'max_depth' && <DepthHint depth={Number(text) || f.value} />}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-1.5">
                        <Input
                          id={`s-${f.key}`} inputMode="numeric" value={text} disabled={f.env_override || busy}
                          onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }); if (serverErr?.key === f.key) setServerErr(null) }}
                          className={cn('h-8 w-28 text-right tabular-nums', isChanged && 'border-amber-400 ring-1 ring-amber-300 dark:ring-amber-500/30', (bad || srv) && 'border-red-400 ring-red-300 dark:ring-red-500/30')}
                          aria-invalid={!!(bad || srv)} data-testid={`setting-${f.key}`}
                        />
                        <span className="w-14 text-xs text-muted-foreground">{f.unit}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>default {f.default}</span>
                        {f.saved && !f.env_override && (
                          <button type="button" className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline" onClick={() => reset(f)} disabled={busy} data-testid={`reset-${f.key}`}>
                            <RotateCcw className="size-3" /> reset
                          </button>
                        )}
                      </div>
                      {(bad || srv) && <p className="text-[11px] text-red-700 dark:text-red-300" data-field-error={f.key}>{bad ? `must be ${bad}` : srv}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        <section className="rounded-xl border bg-background" data-group="Doctor">
          <h2 className="border-b px-4 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Doctor models</h2>
          <p className="px-4 pt-3 text-xs text-muted-foreground">The model the doctor's live round trip uses per harness. Empty = the cheapest model the harness lists.</p>
          <div className="grid gap-3 px-4 py-3 sm:grid-cols-3">
            {DOCTOR_HARNESSES.map((h) => (
              <label key={h} className="grid gap-1 text-xs font-medium">
                {HARNESS_NAME[h]}
                <Input value={models[h] ?? ''} placeholder="auto (cheapest)" disabled={busy} onChange={(e) => setModels({ ...models, [h]: e.target.value })}
                  className={cn('h-8 font-mono text-[12px]', (models[h] ?? '').trim() !== (view.doctor_models[h] ?? '') && 'border-amber-400 ring-1 ring-amber-300 dark:ring-amber-500/30')} data-testid={`doctor-model-${h}`} />
              </label>
            ))}
          </div>
          {serverErr?.key === 'doctor_models' && <p className="px-4 pb-3 text-[11px] text-red-700 dark:text-red-300">{serverErr.msg}</p>}
        </section>
      </div>

      <div className={cn('fixed inset-x-0 bottom-0 border-t bg-background/95 backdrop-blur transition-transform', dirty ? 'translate-y-0' : 'translate-y-full')} aria-hidden={!dirty}>
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-2.5">
          <span className="text-xs text-amber-800 dark:text-amber-300" data-testid="settings-dirty">{plural(dirty, 'unsaved change')}</span>
          {invalid.length > 0 && <span className="text-xs text-red-700 dark:text-red-300">fix {plural(invalid.length, 'field')} first</span>}
          <div className="ml-auto flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => take(view)} disabled={busy}><Undo2 /> Discard</Button>
            <Button size="sm" onClick={save} disabled={busy || invalid.length > 0} data-testid="settings-save"><Save /> {busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const LEVELS = ['you', 'sub-captain', 'builder', 'helper']

/** "you → sub-captain → builder → helper" for the depth being edited. */
function DepthHint({ depth }: { depth: number }) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 10) return null
  const names = Array.from({ length: depth + 1 }, (_, i) => LEVELS[i] ?? `level ${i}`)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]" data-testid="depth-hint">
      {names.map((n, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">→</span>}
          <span className={cn('rounded-full border px-1.5', i === 0 ? 'border-foreground bg-foreground text-background' : 'bg-muted/60')}>{i} · {n}</span>
        </span>
      ))}
    </div>
  )
}
