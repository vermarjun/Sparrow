// Inline editors used all over the ticket sheet. Rule everywhere: click to edit, Enter / blur saves,
// Esc cancels (and never closes the sheet), Cmd+Enter saves multi-line text.
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Pencil, Plus, X } from 'lucide-react'
import type { Agent, Card, CardLevel } from '@shared/types'
import { CARD_LEVELS } from '@shared/types'
import { formatEstimate } from '@shared/cards'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StateDot } from '@/components/sparrow/bits'
import { Markdown } from '@/components/sparrow/Markdown'
import { CategoryChip, Tip } from '@/components/board/markers'
import { addTags, categoryOptions, newCategory, parseEstimateInput, removeTag } from '@/lib/sheetLogic'
import { cn } from '@/lib/utils'

const focusRing = 'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'

/** Grow a textarea to fit its text. */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, active = true) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value, active])
}

// ---------------------------------------------------------------- single-line text (title, blocked-on, check text)

export function InlineText({ value, onSave, className, inputClassName, placeholder, label, allowEmpty, startEditing, onDone }: {
  value: string
  onSave: (v: string) => void
  className?: string
  inputClassName?: string
  placeholder?: string
  label: string
  allowEmpty?: boolean
  startEditing?: boolean
  onDone?: () => void
}) {
  const [editing, setEditing] = useState(!!startEditing)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(ref, draft, editing)
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select() } }, [editing])
  const open = () => { setDraft(value); setEditing(true) }
  const finish = (save: boolean) => {
    setEditing(false)
    const t = draft.trim()
    if (save && t !== value && (t || allowEmpty)) onSave(t)
    onDone?.()
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
  }
  if (editing) {
    return (
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={key}
        onBlur={() => finish(true)}
        className={cn('block w-full resize-none rounded-md bg-white px-1.5 py-0.5 -mx-1.5 ring-2 ring-sky-400/60 outline-none', className, inputClassName)}
      />
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      aria-label={`Edit ${label}`}
      className={cn('group/inline relative -mx-1.5 block w-[calc(100%+0.75rem)] cursor-text rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-zinc-900/[0.045]', focusRing, className)}
    >
      {value || <span className="text-zinc-400">{placeholder}</span>}
      <Pencil className="absolute top-1.5 right-1.5 size-3 text-zinc-400 opacity-0 transition-opacity group-hover/inline:opacity-100" aria-hidden />
    </button>
  )
}

// ---------------------------------------------------------------- markdown text (sections, details)

export function MarkdownEditor({ value, onSave, onClose, placeholder, label }: {
  value: string
  onSave: (v: string) => void
  onClose: () => void
  placeholder: string
  label: string
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useAutoGrow(ref, draft)
  useEffect(() => {
    const el = ref.current
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
  }, [])
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save && draft.trim() !== value.trim()) onSave(draft.trim())
    onClose()
  }
  return (
    <div>
      <textarea
        ref={ref}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
        }}
        className="block min-h-[5.5rem] w-full resize-none rounded-lg border border-sky-300 bg-white px-3 py-2 text-[13.5px] leading-relaxed text-zinc-900 shadow-[0_0_0_3px_rgba(14,165,233,0.12)] outline-none placeholder:text-zinc-400"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span>Markdown works. <kbd className="rounded border border-zinc-300 bg-white px-1 font-sans">⌘ Enter</kbd> saves, <kbd className="rounded border border-zinc-300 bg-white px-1 font-sans">Esc</kbd> cancels.</span>
        <span className="flex gap-1">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(false)} className={cn('rounded-md px-2 py-0.5 font-medium text-zinc-600 hover:bg-zinc-200/70', focusRing)}>Cancel</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(true)} className={cn('rounded-md bg-zinc-900 px-2.5 py-0.5 font-medium text-white hover:bg-zinc-700', focusRing)}>Save</button>
        </span>
      </div>
    </div>
  )
}

/** Markdown view that turns into an editor on click. */
export function EditableMarkdown({ value, onSave, placeholder, label, editing, setEditing }: {
  value: string
  onSave: (v: string) => void
  placeholder: string
  label: string
  editing: boolean
  setEditing: (e: boolean) => void
}) {
  if (editing) return <MarkdownEditor value={value} onSave={onSave} onClose={() => setEditing(false)} placeholder={placeholder} label={label} />
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Edit ${label}`}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) setEditing(true) }}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setEditing(true) }}
      className={cn('-mx-2 cursor-text rounded-lg px-2 py-1 transition-colors hover:bg-zinc-900/[0.035]', focusRing)}
    >
      <Markdown text={value} className="text-[13.5px] leading-[1.65] text-zinc-800" />
    </div>
  )
}

// ---------------------------------------------------------------- toggles

const TOGGLE_TONE = {
  red: 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100/70',
  orange: 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100/70',
  slate: 'border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200/70',
} as const

export function ToggleChip({ icon, label, active, tone, onClick, title }: {
  icon: ReactNode
  label: string
  active: boolean
  tone: keyof typeof TOGGLE_TONE
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-toggle={label.toLowerCase()}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors [&_svg]:size-3.5',
        focusRing,
        active ? TOGGLE_TONE[tone] : 'border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800',
      )}
    >
      {icon}
      {label}
      {active && <Check className="size-3 opacity-70" aria-hidden />}
    </button>
  )
}

// ---------------------------------------------------------------- return / effort

const WORD: Record<CardLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' }

export function LevelPicker({ value, onChange, label }: { value: CardLevel | null; onChange: (v: CardLevel | null) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} data-level-picker={label.toLowerCase()} className="inline-flex h-8 items-center gap-px rounded-lg bg-zinc-200/60 p-0.5">
      {CARD_LEVELS.map((l, i) => {
        const on = value === l
        return (
          <Tip key={l} label={on ? `${label}: ${l} (click to clear)` : `${label}: ${l}`}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              data-level={l}
              onClick={() => onChange(on ? null : l)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors',
                focusRing,
                on ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:text-zinc-800',
              )}
            >
              <span className="flex items-end gap-px" aria-hidden>
                {[0, 1, 2].map((b) => <span key={b} className={cn('w-[3px] rounded-[1px]', b === 0 ? 'h-1.5' : b === 1 ? 'h-2' : 'h-2.5', b <= i ? (on ? 'bg-zinc-800' : 'bg-zinc-400') : 'bg-zinc-300/80')} />)}
              </span>
              {WORD[l]}
            </button>
          </Tip>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- estimate

/** Mount with `key={minutes}` so a change from outside (SSE, another edit) resets the text. */
export function EstimateField({ minutes, onSave }: { minutes: number | null; onSave: (min: number | null) => void }) {
  const shown = formatEstimate(minutes)
  const [text, setText] = useState(shown)
  const [error, setError] = useState('')
  const commit = (): boolean => {
    const r = parseEstimateInput(text)
    if (!r.ok) { setError(r.error); return false }
    setError('')
    if (r.min !== minutes) onSave(r.min)
    else setText(shown)
    return true
  }
  return (
    <div>
      <input
        value={text}
        aria-label="Estimate"
        aria-invalid={!!error}
        placeholder="2h, 90m, 1d"
        onChange={(e) => { setText(e.target.value); setError('') }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const r = parseEstimateInput(text)
            if (r.ok) e.currentTarget.blur() // blur commits, once
            else setError(r.error)
          }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setText(shown); setError(''); e.currentTarget.blur() }
        }}
        className={cn('h-8 w-full rounded-lg border bg-white px-2.5 text-[13px] tabular-nums outline-none transition-colors placeholder:text-zinc-400 focus:ring-2', error ? 'border-red-300 focus:ring-red-200' : 'border-zinc-200 hover:border-zinc-300 focus:border-sky-300 focus:ring-sky-200/70')}
      />
      {error && <p className="mt-1 text-[11px] font-medium text-red-600" role="alert">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- category combobox

export function CategoryField({ category, cards, projectId, known, onSave }: { category: string | null; cards: Card[]; projectId: string; known?: string[]; onSave: (c: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const options = categoryOptions(cards, projectId, query, known)
  const created = newCategory(options, query)
  const rows: { name: string; create?: boolean; count?: number }[] = [...options, ...(created ? [{ name: created, create: true }] : [])]
  const pick = (name: string | null) => { setOpen(false); if (name !== category) onSave(name) }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) { setQuery(''); setActive(0) } }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Category"
          data-field="category"
          className={cn('flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 text-left text-[13px] transition-colors hover:border-zinc-300', focusRing)}
        >
          {category ? <CategoryChip name={category} className="max-w-[12rem] text-[12px]" /> : <span className="text-zinc-400">Set a category</span>}
          <ChevronDown className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5" align="start">
        <input
          autoFocus
          value={query}
          aria-label="Search or create a category"
          placeholder="Find or create a category"
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) pick(rows[active].name) }
          }}
          className="mb-1 h-8 w-full rounded-md border border-zinc-200 bg-white px-2 text-[13px] outline-none placeholder:text-zinc-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-200/70"
        />
        <div className="max-h-56 overflow-y-auto" role="listbox" aria-label="Categories">
          {rows.map((r, i) => (
            <button
              key={r.name + (r.create ? ':new' : '')}
              type="button"
              role="option"
              aria-selected={r.name === category}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(r.name)}
              className={cn('flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px]', i === active && 'bg-zinc-100')}
            >
              <span className="flex min-w-0 items-center gap-2">
                {r.create ? <><Plus className="size-3.5 text-zinc-500" aria-hidden /><span>Create <b className="font-semibold">{r.name}</b></span></> : <CategoryChip name={r.name} />}
              </span>
              {r.name === category ? <Check className="size-3.5 text-zinc-700" aria-hidden /> : r.count ? <span className="text-[11px] text-zinc-400 tabular-nums">{r.count}</span> : null}
            </button>
          ))}
          {!rows.length && <p className="px-2 py-2 text-[12px] text-zinc-500">No categories yet. Type a name to create one.</p>}
        </div>
        {category && (
          <button type="button" onClick={() => pick(null)} className="mt-1 flex w-full items-center gap-1.5 rounded-md border-t border-zinc-100 px-2 pt-2 pb-1 text-left text-[12px] text-zinc-500 hover:text-zinc-800">
            <X className="size-3" aria-hidden />Clear category
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------- tags

export function TagsField({ tags, onSave }: { tags: string[]; onSave: (t: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    if (!draft.trim()) return
    const next = addTags(tags, draft)
    setDraft('')
    if (next.length !== tags.length) onSave(next)
  }
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1 transition-colors focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-200/70 hover:border-zinc-300">
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-0.5 rounded-md border border-zinc-300/80 bg-zinc-50 py-px pr-0.5 pl-1.5 text-[12px] leading-5 text-zinc-700" data-tag={t}>
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onSave(removeTag(tags, t))} className={cn('rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700', focusRing)}>
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        value={draft}
        aria-label="Add a tag"
        placeholder={tags.length ? 'Add tag' : 'Add tags, comma separated'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
          else if (e.key === 'Backspace' && !draft && tags.length) onSave(tags.slice(0, -1))
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(''); e.currentTarget.blur() }
        }}
        className="h-6 min-w-24 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-zinc-400"
      />
    </div>
  )
}


// ---------------------------------------------------------------- assignee

const NONE = '__none'

export function AssigneeField({ assigneeId, agents, onSave }: { assigneeId: string | null; agents: Record<string, Agent>; onSave: (id: string | null) => void }) {
  const list = Object.values(agents)
    .filter((a) => a.kind !== 'probe' && (a.state !== 'retired' || a.id === assigneeId))
    .sort((a, b) => a.handle.localeCompare(b.handle))
  return (
    <Select value={assigneeId ?? NONE} onValueChange={(v) => onSave(v === NONE ? null : v)}>
      <SelectTrigger size="default" aria-label="Assignee" data-field="assignee" className="h-8 w-full bg-white text-[13px] hover:border-zinc-300">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="min-w-56">
        <SelectItem value={NONE}><span className="text-zinc-500">Unassigned</span></SelectItem>
        {list.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            <StateDot state={a.kind === 'human' ? 'human' : a.state} />
            <span className="font-medium">@{a.handle}</span>
            <span className="text-zinc-400">{a.kind === 'human' ? 'you' : a.title}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
