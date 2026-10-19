// The brief: Context, Problem, Approach, Done when, More details. Unboxed; empty sections fold into one muted line.
import { type ReactNode, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import type { Card, CardCheck } from '@shared/types'
import { patchCard } from '@/lib/cardActions'
import { appendCheck, checkProgress, editCheck, hasText, moveCheck, removeCheck, SECTION_HINTS } from '@/lib/sheetLogic'
import { cn } from '@/lib/utils'
import { EditableMarkdown, InlineText } from './fields'
import { focusRing } from './pickers'

type SectionId = 'context' | 'problem' | 'approach' | 'checks' | 'details'
const LABEL: Record<SectionId, string> = { context: 'Context', problem: 'Problem', approach: 'Approach', checks: 'Done when', details: 'More details' }
/** What the muted "+ …" line calls each one (details is shorter there). */
const ADD_LABEL: Record<SectionId, string> = { ...LABEL, details: 'Details' }

/** Unboxed: a quiet heading, then the text. */
function Section({ id, aside, children }: { id: SectionId; aside?: ReactNode; children: ReactNode }) {
  return (
    <section data-section={id}>
      <h3 className="mb-1 flex items-center gap-2.5 text-[11px] font-semibold tracking-[0.09em] text-zinc-400 uppercase">{LABEL[id]}{aside}</h3>
      {children}
    </section>
  )
}

function TextSection({ id, value, onSave, editing, setEditing }: {
  id: 'context' | 'problem' | 'approach' | 'details'
  value: string
  onSave: (v: string) => void
  editing: boolean
  setEditing: (e: boolean) => void
}) {
  return (
    <Section id={id}>
      <EditableMarkdown value={value} onSave={onSave} placeholder={SECTION_HINTS[id]} label={LABEL[id]} editing={editing} setEditing={setEditing} />
    </Section>
  )
}

// ---------------------------------------------------------------- done when

function ProgressBar({ done, total, pct }: { done: number; total: number; pct: number }) {
  const all = total > 0 && done === total
  return (
    <div className="flex items-center gap-2 tracking-normal normal-case" aria-label={`${done} of ${total} checks done`}>
      <span className={cn('text-[12px] font-semibold tabular-nums', all ? 'text-emerald-700' : 'text-zinc-500')}>{done}/{total}</span>
      <span className="h-1 w-16 overflow-hidden rounded-full bg-zinc-200/80" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
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
      <div className={cn('min-w-0 flex-1 text-[14px] leading-snug', check.done && 'text-zinc-500 line-through decoration-zinc-300')}>
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

function AddCheck({ card, autoFocus, onLeave }: { card: Card; autoFocus?: boolean; onLeave: () => void }) {
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
        autoFocus={autoFocus}
        value={text}
        aria-label="Add a check"
        placeholder={card.checks.length ? 'Add another check' : SECTION_HINTS.checks}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { add(); onLeave() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setText(''); e.currentTarget.blur() }
        }}
        className="h-7 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-zinc-400"
      />
    </div>
  )
}

function DoneWhen({ card, editing, setEditing }: { card: Card; editing: boolean; setEditing: (e: boolean) => void }) {
  const p = checkProgress(card.checks)
  return (
    <Section id="checks" aside={p.total ? <ProgressBar {...p} /> : null}>
      <ul className="-mx-1.5 space-y-px">
        {card.checks.map((c, i) => <CheckRow key={`${i}:${c.text}`} card={card} check={c} index={i} count={card.checks.length} />)}
      </ul>
      <div className="-mx-1.5"><AddCheck card={card} autoFocus={editing} onLeave={() => setEditing(false)} /></div>
    </Section>
  )
}

/** Context → Problem → Approach → Done when (the user's order), then More details. Empty sections fold into one muted "+ Context  + Problem" line. */
export function Brief({ card }: { card: Card }) {
  const [editing, setEditing] = useState<SectionId | null>(null)
  const filled: Record<SectionId, boolean> = {
    context: hasText(card.context), problem: hasText(card.problem), approach: hasText(card.approach), checks: card.checks.length > 0, details: hasText(card.details),
  }
  // Closing only clears its own section: a click on "+ Problem" must survive the blur of the editor it replaces.
  const toggle = (id: SectionId, on: boolean) => setEditing((cur) => (on ? id : cur === id ? null : cur))
  const shown = (id: SectionId) => filled[id] || editing === id
  const empty = (['context', 'problem', 'approach', 'checks', 'details'] as SectionId[]).filter((id) => !shown(id))
  const text = (id: 'context' | 'problem' | 'approach' | 'details') => shown(id) && (
    <TextSection
      key={id}
      id={id}
      value={card[id] ?? ''}
      onSave={(v) => { void patchCard(card.id, { [id]: v }) }}
      editing={editing === id}
      setEditing={(e) => toggle(id, e)}
    />
  )
  return (
    <div className="space-y-5" data-brief>
      {text('context')}
      {text('problem')}
      {text('approach')}
      {shown('checks') && <DoneWhen card={card} editing={editing === 'checks'} setEditing={(e) => toggle('checks', e)} />}
      {text('details')}
      {empty.length > 0 && (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]" data-empty-line>
          {empty.map((id) => (
            <button key={id} type="button" data-add={id} onClick={() => setEditing(id)} className={cn('rounded text-zinc-400 transition-colors hover:text-zinc-700', focusRing)}>+ {ADD_LABEL[id]}</button>
          ))}
        </p>
      )}
    </div>
  )
}
