// Quick create: a title and a row of property chips; Enter creates. "Add details" opens the four brief sections.
import { type ReactNode, useRef, useState } from 'react'
import { ChevronRight, Flame } from 'lucide-react'
import { toast } from 'sonner'
import type { CardCreateReq, CardLevel, CardState } from '@shared/types'
import { cardKey, formatEstimate } from '@shared/cards'
import { createCard } from '@/lib/cardActions'
import { useStore } from '@/lib/store'
import { categoriesOf } from '@/lib/boardFilter'
import { parseCheckLines } from '@/lib/cardText'
import { COLUMN_BY_STATE } from '@/lib/boardStyle'
import { SECTION_HINTS } from '@/lib/sheetLogic'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { CategoryLabel, PayoffLabel } from '@/components/board/markers'
import { CategoryPopover, EstimatePopover, focusRing, LevelPopover, StatePopover, TagsPopover } from './sheet/pickers'

const chip = cn('inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-[12.5px] whitespace-nowrap transition-colors hover:border-border hover:bg-muted/50 data-[state=open]:border-foreground/40', focusRing)
const quiet = 'text-muted-foreground'
const level = (v: CardLevel | null, noun: string) => (v ? `${v[0].toUpperCase()}${v.slice(1)} ${noun}` : noun[0].toUpperCase() + noun.slice(1))

export function NewTicketDialog({ open, onOpenChange, defaultState = 'todo' }: { open: boolean; onOpenChange: (o: boolean) => void; defaultState?: CardState }) {
  const project = useStore((s) => s.project)
  const cardsById = useStore((s) => s.cards)
  const cards = Object.values(cardsById)
  const formRef = useRef<HTMLFormElement>(null)
  const [title, setTitle] = useState('')
  const [state, setState] = useState<CardState>(defaultState)
  const [category, setCategory] = useState<string | null>(null)
  const [urgent, setUrgent] = useState(false)
  const [impact, setImpact] = useState<CardLevel | null>(null)
  const [effort, setEffort] = useState<CardLevel | null>(null)
  const [estimateMin, setEstimateMin] = useState<number | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [details, setDetails] = useState(false)
  const [context, setContext] = useState('')
  const [problem, setProblem] = useState('')
  const [approach, setApproach] = useState('')
  const [checks, setChecks] = useState('')
  const [busy, setBusy] = useState(false)

  const resetForm = () => {
    setTitle(''); setState(defaultState); setCategory(null); setUrgent(false); setImpact(null); setEffort(null)
    setEstimateMin(null); setTags([]); setDetails(false); setContext(''); setProblem(''); setApproach(''); setChecks('')
  }
  const changeOpen = (next: boolean) => {
    if (!next) resetForm()
    onOpenChange(next)
  }

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!project || !title.trim() || busy) return
    const body: CardCreateReq = {
      title: title.trim(), state, category, urgent, impact, effort, estimate_min: estimateMin, tags,
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
        showCloseButton={false}
        className="top-[12vh]! flex max-h-[calc(100vh-8rem)] w-[min(680px,calc(100vw-2rem))] translate-y-0! flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); formRef.current?.requestSubmit() } }}
        data-testid="new-ticket-dialog"
      >
        <DialogTitle className="sr-only">New ticket</DialogTitle>
        <DialogDescription className="sr-only">Type a title and press Enter. Add details to write the full brief.</DialogDescription>
        <form ref={formRef} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div data-testid="new-ticket-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-4">
            <input
              id="new-ticket-title"
              data-testid="new-ticket-title"
              autoFocus
              required
              maxLength={200}
              value={title}
              aria-label="Title"
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              className="block w-full bg-transparent text-[20px] leading-tight font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/45"
            />

            <div className="mt-4 flex flex-wrap items-center gap-1.5" data-chips>
              <StatePopover value={state} options={['todo', 'proposed']} onChange={setState}>
                <button type="button" data-chip="state" aria-label="State" className={chip}>
                  <span className={cn('size-2 rounded-full', COLUMN_BY_STATE[state].dot)} aria-hidden />{COLUMN_BY_STATE[state].name}
                </button>
              </StatePopover>
              <CategoryPopover category={category} cards={cards} projectId={project ?? ''} known={categoriesOf(cards)} onSave={setCategory}>
                <button type="button" data-chip="category" aria-label="Category" className={cn(chip, !category && quiet)}>
                  {category ? <CategoryLabel name={category} className="text-[12.5px] text-foreground" /> : 'Category'}
                </button>
              </CategoryPopover>
              <button
                type="button"
                data-chip="urgent"
                aria-pressed={urgent}
                onClick={() => setUrgent((v) => !v)}
                className={cn(chip, urgent ? 'border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 font-semibold text-red-700 dark:text-red-300 hover:border-red-300 hover:bg-red-50' : quiet)}
              >
                <Flame className="size-3.5" aria-hidden />Urgent
              </button>
              <LevelPopover label="Return" value={impact} onChange={setImpact}>
                <button type="button" data-chip="return" aria-label="Return" className={cn(chip, !impact && quiet)}>{level(impact, 'return')}</button>
              </LevelPopover>
              <LevelPopover label="Effort" value={effort} onChange={setEffort}>
                <button type="button" data-chip="effort" aria-label="Effort" className={cn(chip, !effort && quiet)}>{level(effort, 'effort')}</button>
              </LevelPopover>
              <EstimatePopover minutes={estimateMin} onSave={setEstimateMin}>
                <button type="button" data-chip="estimate" aria-label="Estimate" className={cn(chip, 'tabular-nums', !estimateMin && quiet)}>{estimateMin ? `~${formatEstimate(estimateMin)}` : 'Estimate'}</button>
              </EstimatePopover>
              {impact && effort && <span className="inline-flex items-center gap-1.5 pl-1 text-[12.5px] text-muted-foreground/70" data-payoff-preview>→ <PayoffLabel card={{ impact, effort, estimate_min: estimateMin }} className="text-[12.5px]" /></span>}
            </div>

            <button
              type="button"
              data-add-details
              aria-expanded={details}
              onClick={() => setDetails((d) => !d)}
              className={cn('mt-4 -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground', focusRing)}
            >
              <ChevronRight className={cn('size-3.5 transition-transform', details && 'rotate-90')} aria-hidden />{details ? 'Hide details' : 'Add details'}
            </button>

            {details && (
              <div className="mt-3 space-y-4" data-details>
                <Brief id="context" title="Context" value={context} onChange={setContext} />
                <Brief id="problem" title="Problem" value={problem} onChange={setProblem} />
                <Brief id="approach" title="Approach" value={approach} onChange={setApproach} />
                <Brief id="done-when" title="Done when" value={checks} onChange={setChecks} rows={3} placeholder={'One check per line.\nExport includes all rows in the selected range.'} />
                <div>
                  <h3 className="mb-1 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground/70 uppercase">Tags</h3>
                  <TagsPopover tags={tags} onSave={setTags}>
                    <button type="button" data-testid="new-ticket-tags" aria-label="Tags" className={cn('inline-flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] hover:bg-foreground/[0.05]', tags.length ? 'text-muted-foreground' : 'text-muted-foreground/70', focusRing)}>
                      {tags.length ? tags.map((t) => <span key={t}>#{t}</span>) : '+ tags'}
                    </button>
                  </TagsPopover>
                </div>
              </div>
            )}
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-border/80 bg-background px-5 py-3">
            <span className="mr-auto text-[12px] text-muted-foreground/70"><Kbd>↵</Kbd> to create{details && <> · <Kbd>⌘ ↵</Kbd> from any field</>}</span>
            <Button type="button" variant="ghost" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()} data-testid="new-ticket-submit" className="min-w-28">{busy ? 'Creating…' : 'Create ticket'}</Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-muted/50 px-1 font-sans text-[11px] text-muted-foreground">{children}</kbd>
}

function Brief({ id, title, value, onChange, rows = 2, placeholder }: { id: 'context' | 'problem' | 'approach' | 'done-when'; title: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  const hint = id === 'done-when' ? SECTION_HINTS.checks : SECTION_HINTS[id]
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground/70 uppercase"><label htmlFor={`brief-${id}`}>{title}</label></h3>
      <textarea
        id={`brief-${id}`}
        data-brief={id}
        value={value}
        rows={rows}
        placeholder={placeholder ?? hint}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/45 focus:border-sky-300 focus:ring-2 focus:ring-sky-200/70"
      />
    </div>
  )
}
