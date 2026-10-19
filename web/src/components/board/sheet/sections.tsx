// The brief: Context, Problem, Approach, Done when, More details.
import { type ReactNode, useState } from 'react'
import { ArrowDown, ArrowUp, BookOpen, CircleAlert, FileText, ListChecks, Pencil, Plus, Route, X } from 'lucide-react'
import type { Card, CardCheck } from '@shared/types'
import { patchCard } from '@/lib/cardActions'
import { appendCheck, checkProgress, editCheck, hasText, moveCheck, removeCheck, SECTION_HINTS } from '@/lib/sheetLogic'
import { cn } from '@/lib/utils'
import { EditableMarkdown, InlineText } from './fields'

const focusRing = 'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'

function Shell({ icon, label, aside, action, children, id, tone }: { icon: ReactNode; label: string; aside?: ReactNode; action?: ReactNode; children: ReactNode; id: string; tone?: 'done' }) {
  return (
    <section data-section={id} className="group/section rounded-xl border border-zinc-200/90 bg-white px-4 pt-3 pb-3.5 shadow-[0_1px_2px_rgba(24,24,27,0.04)]">
      <header className="mb-2 flex items-center gap-2">
        <span className={cn('flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5', tone === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-600')}>{icon}</span>
        <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-zinc-600 uppercase">{label}</h3>
        {aside}
        <span className="ml-auto flex items-center">{action}</span>
      </header>
      {children}
    </section>
  )
}

function PencilButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className={cn('rounded-md p-1 text-zinc-400 opacity-0 transition-opacity group-hover/section:opacity-100 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100', focusRing)}>
      <Pencil className="size-3.5" aria-hidden />
    </button>
  )
}

/** One markdown section: rendered text, a dashed prompt when empty, a textarea while editing. */
function TextSection({ id, icon, label, hint, value, onSave, optionalWhenEmpty }: {
  id: 'context' | 'problem' | 'approach' | 'details'
  icon: ReactNode
  label: string
  hint: string
  value: string
  onSave: (v: string) => void
  optionalWhenEmpty?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const filled = hasText(value)
  if (optionalWhenEmpty && !filled && !editing) {
    return (
      <button type="button" data-section={id} data-empty onClick={() => setEditing(true)} className={cn('flex w-full items-center gap-2 rounded-xl border border-dashed border-zinc-300 px-4 py-2.5 text-left text-[12.5px] text-zinc-500 transition-colors hover:border-zinc-400 hover:bg-white hover:text-zinc-700', focusRing)}>
        <Plus className="size-3.5" aria-hidden />Add {label.toLowerCase()}<span className="text-zinc-400">· {hint}</span>
      </button>
    )
  }
  return (
    <Shell id={id} icon={icon} label={label} action={!editing && filled ? <PencilButton label={`Edit ${label}`} onClick={() => setEditing(true)} /> : null}>
      {!filled && !editing ? (
        <button type="button" onClick={() => setEditing(true)} data-empty className={cn('flex w-full items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-3 py-3 text-left text-[13px] text-zinc-500 transition-colors hover:border-zinc-400 hover:bg-zinc-50', focusRing)}>
          <Plus className="size-3.5 shrink-0" aria-hidden />
          <span>{hint}</span>
        </button>
      ) : (
        <EditableMarkdown value={value} onSave={onSave} placeholder={hint} label={label} editing={editing} setEditing={setEditing} />
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------- done when

function ProgressBar({ done, total, pct }: { done: number; total: number; pct: number }) {
  const all = total > 0 && done === total
  return (
    <div className="flex items-center gap-2" aria-label={`${done} of ${total} checks done`}>
      <span className={cn('text-[12px] font-semibold tabular-nums', all ? 'text-emerald-700' : 'text-zinc-500')}>{done}/{total}</span>
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span className="block h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </span>
    </div>
  )
}

function CheckRow({ card, check, index, count }: { card: Card; check: CardCheck; index: number; count: number }) {
  const setChecks = (checks: CardCheck[]) => patchCard(card.id, { checks })
  return (
    <li data-check-index={index} className="group/check flex items-start gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-zinc-50">
      <button
        type="button"
        role="checkbox"
        aria-checked={check.done}
        aria-label={`${check.done ? 'Untick' : 'Tick'}: ${check.text}`}
        onClick={() => patchCard(card.id, { check: { index, done: !check.done } })}
        className={cn('mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors', focusRing, check.done ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-zinc-300 bg-white hover:border-zinc-500')}
      >
        {check.done && <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2.5 6.5l2.5 2.5 4.5-5.5" /></svg>}
      </button>
      <div className={cn('min-w-0 flex-1 text-[13.5px] leading-snug', check.done && 'text-zinc-500 line-through decoration-zinc-300')}>
        <InlineText value={check.text} label={`check ${index + 1}`} onSave={(text) => setChecks(editCheck(card.checks, index, text))} allowEmpty className="py-0.5" />
      </div>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/check:opacity-100 group-hover/check:opacity-100">
        <RowIcon label="Move up" disabled={index === 0} onClick={() => setChecks(moveCheck(card.checks, index, index - 1))}><ArrowUp /></RowIcon>
        <RowIcon label="Move down" disabled={index === count - 1} onClick={() => setChecks(moveCheck(card.checks, index, index + 1))}><ArrowDown /></RowIcon>
        <RowIcon label="Remove" tone="bad" onClick={() => setChecks(removeCheck(card.checks, index))}><X /></RowIcon>
      </span>
    </li>
  )
}

function RowIcon({ label, onClick, disabled, tone, children }: { label: string; onClick: () => void; disabled?: boolean; tone?: 'bad'; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={cn('rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200/70 hover:text-zinc-700 disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5', tone === 'bad' && 'hover:bg-red-50 hover:text-red-600', focusRing)}>
      {children}
    </button>
  )
}

function AddCheck({ card }: { card: Card }) {
  const [text, setText] = useState('')
  const add = () => {
    if (!text.trim()) return
    patchCard(card.id, { checks: appendCheck(card.checks, text) })
    setText('')
  }
  return (
    <div className="mt-1 flex items-center gap-2.5 rounded-lg px-1.5 py-1">
      <Plus className="size-[18px] shrink-0 text-zinc-400" aria-hidden />
      <input
        value={text}
        aria-label="Add a check"
        placeholder={card.checks.length ? 'Add another check' : SECTION_HINTS.checks}
        onChange={(e) => setText(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setText(''); e.currentTarget.blur() }
        }}
        className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-zinc-400"
      />
    </div>
  )
}

function DoneWhen({ card }: { card: Card }) {
  const p = checkProgress(card.checks)
  return (
    <Shell id="checks" tone={p.total > 0 && p.done === p.total ? 'done' : undefined} icon={<ListChecks />} label="Done when" action={p.total ? <ProgressBar {...p} /> : null}>
      {p.total === 0 && <p className="mb-1 px-1.5 text-[12.5px] text-zinc-500">Nothing to verify yet. Write checks someone else could tick without asking you.</p>}
      <ul className="-mx-1.5 space-y-px">
        {card.checks.map((c, i) => <CheckRow key={`${i}:${c.text}`} card={card} check={c} index={i} count={card.checks.length} />)}
      </ul>
      <div className="-mx-1.5"><AddCheck card={card} /></div>
    </Shell>
  )
}

export function Brief({ card }: { card: Card }) {
  const save = (field: 'context' | 'problem' | 'approach' | 'details') => (v: string) => { patchCard(card.id, { [field]: v }) }
  return (
    <div className="space-y-3" data-brief>
      <TextSection id="context" icon={<BookOpen />} label="Context" hint={SECTION_HINTS.context} value={card.context ?? ''} onSave={save('context')} />
      <TextSection id="problem" icon={<CircleAlert />} label="Problem" hint={SECTION_HINTS.problem} value={card.problem ?? ''} onSave={save('problem')} />
      <TextSection id="approach" icon={<Route />} label="Approach" hint={SECTION_HINTS.approach} value={card.approach ?? ''} onSave={save('approach')} />
      <DoneWhen card={card} />
      <TextSection id="details" icon={<FileText />} label="More details" hint={SECTION_HINTS.details} value={card.details ?? ''} onSave={save('details')} optionalWhenEmpty />
    </div>
  )
}
