// Small popover editors behind the property tokens (ticket sheet) and the property chips (new ticket dialog).
// Each takes the trigger as `children`; picking a value saves and closes, Esc cancels.
import { type ReactElement, type ReactNode, useState } from 'react'
import { Check, Plus, X } from 'lucide-react'
import type { Agent, Card, CardLevel, CardState } from '@shared/types'
import { CARD_LEVELS } from '@shared/types'
import { formatEstimate, STATE_LABEL } from '@shared/cards'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StateDot } from '@/components/sparrow/bits'
import { CategoryLabel } from '@/components/board/markers'
import { COLUMN_BY_STATE } from '@/lib/boardStyle'
import { addTags, categoryOptions, newCategory, parseEstimateInput, removeTag } from '@/lib/sheetLogic'
import { cn } from '@/lib/utils'

export const focusRing = 'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'

const row = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-800 transition-colors hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none'
const field = 'h-8 w-full rounded-md border border-zinc-200 bg-white px-2 text-[13px] outline-none placeholder:text-zinc-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-200/70'

function Pop({ name, width = 'w-52', children, content, open, setOpen }: {
  name: string; width?: string; children: ReactElement; content: ReactNode; open: boolean; setOpen: (o: boolean) => void
}) {
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        data-popover={name}
        className={cn('p-1.5', width)}
        // Radix focuses the first focusable thing (a tag's remove button); a popover with a text field wants the field.
        onOpenAutoFocus={(e) => {
          const input = (e.currentTarget as HTMLElement | null)?.querySelector('input')
          if (input) { e.preventDefault(); input.focus() }
        }}
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------- return / effort

const WORD: Record<CardLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' }

function Bars({ level }: { level: CardLevel }) {
  const i = CARD_LEVELS.indexOf(level)
  return (
    <span className="flex items-end gap-px" aria-hidden>
      {[0, 1, 2].map((b) => <span key={b} className={cn('w-[3px] rounded-[1px]', b === 0 ? 'h-1.5' : b === 1 ? 'h-2' : 'h-2.5', b <= i ? 'bg-zinc-700' : 'bg-zinc-300')} />)}
    </span>
  )
}

export function LevelPopover({ label, value, onChange, children }: { label: 'Return' | 'Effort'; value: CardLevel | null; onChange: (v: CardLevel | null) => void; children: ReactElement }) {
  const [open, setOpen] = useState(false)
  const pick = (v: CardLevel | null) => { setOpen(false); if (v !== value) onChange(v) }
  return (
    <Pop
      name={label.toLowerCase()} width="w-44" open={open} setOpen={setOpen}
      content={
        <div role="listbox" aria-label={label} onKeyDown={(e) => { const i = Number(e.key) - 1; if (i >= 0 && i < 3) { e.preventDefault(); pick(CARD_LEVELS[i]) } }}>
          <p className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-zinc-400">{label === 'Return' ? 'Return: how much it is worth' : 'Effort: how much work it takes'}</p>
          {CARD_LEVELS.map((l, i) => (
            <button key={l} type="button" role="option" aria-selected={value === l} data-level={l} onClick={() => pick(l)} className={row}>
              <Bars level={l} />
              {WORD[l]}
              {value === l ? <Check className="ml-auto size-3.5 text-zinc-700" aria-hidden /> : <kbd className="ml-auto font-sans text-[11px] text-zinc-300">{i + 1}</kbd>}
            </button>
          ))}
          {value && <button type="button" data-clear onClick={() => pick(null)} className={cn(row, 'mt-0.5 border-t border-zinc-100 text-[12px] text-zinc-500')}><X className="size-3" aria-hidden />Clear</button>}
        </div>
      }
    >
      {children}
    </Pop>
  )
}

// ---------------------------------------------------------------- estimate

export function EstimatePopover({ minutes, onSave, children }: { minutes: number | null; onSave: (min: number | null) => void; children: ReactElement }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const commit = () => {
    const r = parseEstimateInput(text)
    if (!r.ok) { setError(r.error); return }
    setOpen(false)
    if (r.min !== minutes) onSave(r.min)
  }
  return (
    <Pop
      name="estimate" width="w-48" open={open}
      setOpen={(o) => { setOpen(o); if (o) { setText(formatEstimate(minutes)); setError('') } }}
      content={
        <div>
          <input
            value={text}
            aria-label="Estimate"
            aria-invalid={!!error}
            placeholder="2h, 90m, 1d"
            onChange={(e) => { setText(e.target.value); setError('') }}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
            className={cn(field, 'tabular-nums', error && 'border-red-300 focus:border-red-300 focus:ring-red-200')}
          />
          <p className={cn('px-0.5 pt-1 text-[11px]', error ? 'font-medium text-red-600' : 'text-zinc-400')} role={error ? 'alert' : undefined}>{error || 'Enter to save. Empty clears it.'}</p>
        </div>
      }
    >
      {children}
    </Pop>
  )
}

// ---------------------------------------------------------------- category

export function CategoryPopover({ category, cards, projectId, known, onSave, children }: {
  category: string | null; cards: Card[]; projectId: string; known?: string[]; onSave: (c: string | null) => void; children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const options = categoryOptions(cards, projectId, query, known)
  const created = newCategory(options, query)
  const rows: { name: string; create?: boolean; count?: number }[] = [...options, ...(created ? [{ name: created, create: true }] : [])]
  const pick = (name: string | null) => { setOpen(false); if (name !== category) onSave(name) }
  return (
    <Pop
      name="category" width="w-60" open={open}
      setOpen={(o) => { setOpen(o); if (o) { setQuery(''); setActive(0) } }}
      content={
        <>
          <input
            value={query}
            aria-label="Search or create a category"
            placeholder="Find or create a category"
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) pick(rows[active].name) }
            }}
            className={cn(field, 'mb-1')}
          />
          <div className="max-h-52 overflow-y-auto" role="listbox" aria-label="Categories">
            {rows.map((r, i) => (
              <button
                key={r.name + (r.create ? ':new' : '')}
                type="button"
                role="option"
                aria-selected={r.name === category}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r.name)}
                className={cn(row, 'justify-between', i === active && 'bg-zinc-100')}
              >
                {r.create ? <span className="flex items-center gap-1.5"><Plus className="size-3.5 text-zinc-500" aria-hidden />Create <b className="font-semibold">{r.name}</b></span> : <CategoryLabel name={r.name} className="text-[13px] text-zinc-800" />}
                {r.name === category ? <Check className="size-3.5 text-zinc-700" aria-hidden /> : r.count ? <span className="text-[11px] text-zinc-400 tabular-nums">{r.count}</span> : null}
              </button>
            ))}
            {!rows.length && <p className="px-2 py-2 text-[12px] text-zinc-500">No categories yet. Type a name to create one.</p>}
          </div>
          {category && <button type="button" data-clear onClick={() => pick(null)} className={cn(row, 'mt-0.5 border-t border-zinc-100 text-[12px] text-zinc-500')}><X className="size-3" aria-hidden />Clear category</button>}
        </>
      }
    >
      {children}
    </Pop>
  )
}

// ---------------------------------------------------------------- assignee

export function AssigneePopover({ assigneeId, agents, onSave, children }: { assigneeId: string | null; agents: Record<string, Agent>; onSave: (id: string | null) => void; children: ReactElement }) {
  const [open, setOpen] = useState(false)
  const list = Object.values(agents)
    .filter((a) => a.kind !== 'probe' && (a.state !== 'retired' || a.id === assigneeId))
    .sort((a, b) => a.handle.localeCompare(b.handle))
  const pick = (id: string | null) => { setOpen(false); if (id !== assigneeId) onSave(id) }
  return (
    <Pop
      name="assignee" width="w-60" open={open} setOpen={setOpen}
      content={
        <div role="listbox" aria-label="Assignee" className="max-h-64 overflow-y-auto">
          <button type="button" role="option" aria-selected={!assigneeId} data-assignee="none" onClick={() => pick(null)} className={cn(row, 'text-zinc-500')}>
            Unassigned{!assigneeId && <Check className="ml-auto size-3.5 text-zinc-700" aria-hidden />}
          </button>
          {list.map((a) => (
            <button key={a.id} type="button" role="option" aria-selected={a.id === assigneeId} data-assignee={a.handle} onClick={() => pick(a.id)} className={row}>
              <StateDot state={a.kind === 'human' ? 'human' : a.state} />
              <span className="font-medium">@{a.handle}</span>
              <span className="min-w-0 truncate text-[12px] text-zinc-400">{a.kind === 'human' ? 'you' : a.title}</span>
              {a.id === assigneeId && <Check className="ml-auto size-3.5 shrink-0 text-zinc-700" aria-hidden />}
            </button>
          ))}
        </div>
      }
    >
      {children}
    </Pop>
  )
}

// ---------------------------------------------------------------- tags

export function TagsPopover({ tags, onSave, children }: { tags: string[]; onSave: (t: string[]) => void; children: ReactElement }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const add = () => {
    if (!draft.trim()) return
    const next = addTags(tags, draft)
    setDraft('')
    if (next.length !== tags.length) onSave(next)
  }
  return (
    <Pop
      name="tags" width="w-64" open={open}
      setOpen={(o) => { if (!o) add(); setOpen(o) }}
      content={
        <div>
          {tags.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {tags.map((t) => (
                <span key={t} data-tag={t} className="inline-flex items-center gap-0.5 rounded-md bg-zinc-100 py-px pr-0.5 pl-1.5 text-[12px] leading-5 text-zinc-700">
                  {t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onSave(removeTag(tags, t))} className={cn('rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700', focusRing)}><X className="size-3" aria-hidden /></button>
                </span>
              ))}
            </div>
          )}
          <input
            value={draft}
            aria-label="Add a tag"
            placeholder={tags.length ? 'Add tag' : 'Add tags, comma separated'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
              else if (e.key === 'Backspace' && !draft && tags.length) onSave(tags.slice(0, -1))
            }}
            className={field}
          />
        </div>
      }
    >
      {children}
    </Pop>
  )
}

// ---------------------------------------------------------------- state (new ticket dialog)

export function StatePopover({ value, options, onChange, children }: { value: CardState; options: CardState[]; onChange: (s: CardState) => void; children: ReactElement }) {
  const [open, setOpen] = useState(false)
  return (
    <Pop
      name="state" width="w-44" open={open} setOpen={setOpen}
      content={
        <div role="listbox" aria-label="State">
          {options.map((s) => (
            <button key={s} type="button" role="option" aria-selected={s === value} data-state-option={s} onClick={() => { setOpen(false); onChange(s) }} className={row}>
              <span className={cn('size-2 rounded-full', COLUMN_BY_STATE[s].dot)} aria-hidden />
              {STATE_LABEL[s]}
              {s === value && <Check className="ml-auto size-3.5 text-zinc-700" aria-hidden />}
            </button>
          ))}
        </div>
      }
    >
      {children}
    </Pop>
  )
}
