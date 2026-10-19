import { useRef, useState } from 'react'
import { Flame, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import type { CardCreateReq, CardLevel, CardState } from '@shared/types'
import { cardKey, formatEstimate, parseEstimate } from '@shared/cards'
import { createCard } from '@/lib/cardActions'
import { useStore } from '@/lib/store'
import { categoriesOf } from '@/lib/boardFilter'
import { parseCheckLines } from '@/lib/cardText'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const LEVELS: { value: CardLevel | 'none'; label: string }[] = [
  { value: 'none', label: 'Not set' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
]

export function NewTicketDialog({ open, onOpenChange, defaultState = 'todo' }: { open: boolean; onOpenChange: (o: boolean) => void; defaultState?: CardState }) {
  const project = useStore((s) => s.project)
  const cardsById = useStore((s) => s.cards)
  const categories = categoriesOf(Object.values(cardsById))
  const formRef = useRef<HTMLFormElement>(null)
  const [title, setTitle] = useState('')
  const [state, setState] = useState<CardState>(defaultState)
  const [category, setCategory] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [impact, setImpact] = useState<CardLevel | 'none'>('none')
  const [effort, setEffort] = useState<CardLevel | 'none'>('none')
  const [estimate, setEstimate] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [context, setContext] = useState('')
  const [problem, setProblem] = useState('')
  const [approach, setApproach] = useState('')
  const [checks, setChecks] = useState('')
  const [busy, setBusy] = useState(false)
  const estimateMin = parseEstimate(estimate)

  const resetForm = () => {
    setTitle(''); setState(defaultState); setCategory(''); setUrgent(false); setImpact('none'); setEffort('none')
    setEstimate(''); setTags([]); setTagDraft(''); setContext(''); setProblem(''); setApproach(''); setChecks('')
  }
  const changeOpen = (next: boolean) => {
    if (!next) resetForm()
    onOpenChange(next)
  }

  const addTag = (raw = tagDraft) => {
    const next = raw.split(',').map((t) => t.trim().toLowerCase().slice(0, 32)).filter(Boolean)
    if (next.length) setTags((prev) => [...new Set([...prev, ...next])].slice(0, 12))
    setTagDraft('')
  }
  const removeTag = (tag: string) => setTags((prev) => prev.filter((t) => t !== tag))

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!project || !title.trim() || busy || (!!estimate.trim() && estimateMin == null)) return
    const finalTags = [...new Set([...tags, ...tagDraft.split(',').map((tag) => tag.trim().toLowerCase().slice(0, 32)).filter(Boolean)])].slice(0, 12)
    const body: CardCreateReq = {
      title: title.trim(), state, category: category.trim().toLowerCase() || null, urgent,
      impact: impact === 'none' ? null : impact, effort: effort === 'none' ? null : effort,
      estimate_min: estimate.trim() ? estimateMin : null, tags: finalTags,
      context: context.trim(), problem: problem.trim(), approach: approach.trim(),
      checks: parseCheckLines(checks).map((text) => ({ text, done: false })),
    }
    setBusy(true)
    try {
      const card = await createCard(project, body)
      if (!card) return
      toast.success(`${cardKey(card)} created`)
      changeOpen(false)
    } catch (err) {
      toast.error(`Could not create ticket: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="flex max-h-[calc(100vh-4rem)] w-[min(850px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); formRef.current?.requestSubmit() } }}
        data-testid="new-ticket-dialog"
      >
        <DialogHeader className="shrink-0 border-b border-zinc-200/80 bg-white px-6 py-5 pr-14">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-violet-700 uppercase"><Plus className="size-3.5" /> Board intake</div>
          <DialogTitle className="text-lg font-semibold tracking-tight">New ticket</DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">Write a clear brief so the next person can start without asking what it means.</DialogDescription>
        </DialogHeader>

        <form ref={formRef} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div data-testid="new-ticket-body" className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain bg-zinc-50/60 px-6 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <Field label="Title" hint="One outcome-first sentence. Only required field." htmlFor="new-ticket-title">
                <Input id="new-ticket-title" data-testid="new-ticket-title" autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Show estimate vs actual on done tickets" className="h-10 border-zinc-300 bg-white text-[13px] shadow-xs" />
              </Field>
              <Field label="State" hint="Add to the active board or keep it proposed." htmlFor="new-ticket-state">
                <Select value={state} onValueChange={(v) => setState(v as CardState)}>
                  <SelectTrigger id="new-ticket-state" className="h-10 w-full border-zinc-300 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="todo">To do</SelectItem><SelectItem value="proposed">Proposed</SelectItem></SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_170px_170px_170px]">
              <Field label="Category" hint="Choose an existing category or type a new one." htmlFor="new-ticket-category">
                <Input id="new-ticket-category" list="new-ticket-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="ui, server, docs…" className="h-9 border-zinc-300 bg-white" />
                <datalist id="new-ticket-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Return" hint="How much value does this create?" htmlFor="new-ticket-impact">
                <LevelSelect id="new-ticket-impact" label="Return" value={impact} onChange={setImpact} />
              </Field>
              <Field label="Effort" hint="How much work does it take?" htmlFor="new-ticket-effort">
                <LevelSelect id="new-ticket-effort" label="Effort" value={effort} onChange={setEffort} />
              </Field>
              <Field label="Estimate" hint="A planning guess; use 2h, 90m, or 1d." htmlFor="new-ticket-estimate">
                <Input id="new-ticket-estimate" value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="2h" aria-invalid={!!estimate.trim() && estimateMin == null} className="h-9 border-zinc-300 bg-white font-mono text-[12px]" />
                {estimate.trim() && <p className={cn('mt-1 text-[10px]', estimateMin ? 'text-zinc-500' : 'text-red-600')}>{estimateMin ? `Parsed as ${formatEstimate(estimateMin)} · ${estimateMin} min` : 'Use a time such as 2h, 90m, or 1d.'}</p>}
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
              <Field label="Tags" hint="Press Enter or comma to add a tag." htmlFor="new-ticket-tags">
                <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                  {tags.map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-zinc-600">{tag}<button type="button" onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`} className="rounded text-zinc-400 hover:text-zinc-800"><X className="size-3" /></button></span>)}
                  <input id="new-ticket-tags" data-testid="new-ticket-tags" value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }} onBlur={() => tagDraft.trim() && addTag()} placeholder={tags.length ? 'Add another…' : 'finance, migration…'} className="h-6 min-w-32 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-zinc-400" />
                </div>
              </Field>
              <div className="flex items-end pb-0.5">
                <button type="button" role="switch" aria-checked={urgent} onClick={() => setUrgent((v) => !v)} onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); setUrgent((v) => !v) } }} className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-red-200 hover:bg-red-50/50">
                  <span className="flex items-center gap-2"><Flame className="size-4 text-red-600" /><span><span className="block text-xs font-medium text-zinc-800">Urgent</span><span className="block text-[10px] text-zinc-400">Blocks someone right now</span></span></span>
                  <span aria-hidden className={cn('relative h-5 w-9 rounded-full transition-colors', urgent ? 'bg-red-500' : 'bg-zinc-300')}><span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform', urgent ? 'translate-x-4' : 'translate-x-0.5')} /></span>
                </button>
              </div>
            </div>

            <div className="grid gap-2 border-t border-zinc-200/80 pt-4 sm:grid-cols-2">
              <BriefField title="Context" hint="Why does this exist? Who asked, where did it come from?" value={context} onChange={setContext} placeholder="From Monday’s finance review — the audit needs a monthly export." />
              <BriefField title="Problem" hint="What is wrong right now? Observed vs expected." value={problem} onChange={setProblem} placeholder="Observed: … Expected: …" />
              <BriefField title="Approach" hint="Plain-English plan. No code." value={approach} onChange={setApproach} placeholder="Describe the shape of the fix in a few sentences." />
              <BriefField title="Done when" hint="One binary, verifiable check per line." value={checks} onChange={setChecks} placeholder={'Export includes all rows in the selected range.\nCommas and newlines round-trip correctly.'} rows={4} />
            </div>
          </div>

          <DialogFooter className="mx-0 mb-0 shrink-0 border-t border-zinc-200 bg-white px-6 py-3">
            <span className="mr-auto hidden items-center text-[10px] text-zinc-400 sm:flex"><kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 py-0.5 font-mono">⌘</kbd><span className="mx-1">+</span><kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 py-0.5 font-mono">↵</kbd><span className="ml-2">to create</span></span>
            <Button type="button" variant="ghost" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim() || (!!estimate.trim() && estimateMin == null)} data-testid="new-ticket-submit" className="min-w-28">{busy ? 'Creating…' : 'Create ticket'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, hint, htmlFor, children }: { label: string; hint: string; htmlFor: string; children: React.ReactNode }) {
  return <div className="min-w-0 space-y-1.5"><Label htmlFor={htmlFor} className="text-[11px] font-semibold text-zinc-700">{label}</Label>{children}<p className="text-[10px] leading-snug text-zinc-400">{hint}</p></div>
}

function LevelSelect({ id, label, value, onChange }: { id: string; label: string; value: CardLevel | 'none'; onChange: (v: CardLevel | 'none') => void }) {
  return <Select value={value} onValueChange={(v) => onChange(v as CardLevel | 'none')}>
    <SelectTrigger id={id} aria-label={label} className="h-9 w-full border-zinc-300 bg-white"><SelectValue /></SelectTrigger>
    <SelectContent>{LEVELS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
  </Select>
}

function BriefField({ title, hint, value, onChange, placeholder, rows = 3 }: { title: string; hint: string; value: string; onChange: (v: string) => void; placeholder: string; rows?: number }) {
  return <Field label={title} hint={hint} htmlFor={`brief-${title.toLowerCase().replaceAll(' ', '-')}`}>
    <Textarea id={`brief-${title.toLowerCase().replaceAll(' ', '-')}`} data-brief={title.toLowerCase().replaceAll(' ', '-')} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} className="resize-y border-zinc-300 bg-white text-[11px] leading-relaxed placeholder:text-zinc-300" />
  </Field>
}
