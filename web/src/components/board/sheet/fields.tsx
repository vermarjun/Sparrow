// Inline text editors of the ticket sheet (title, blocked-on, checks, brief sections). Rule everywhere: click to edit, Enter / blur saves,
// Esc cancels (and never closes the sheet), Cmd+Enter saves multi-line text.
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/sparrow/Markdown'
import { cn } from '@/lib/utils'
import { focusRing } from './pickers'

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
        className={cn('block w-full resize-none rounded-md bg-background px-1.5 py-0.5 -mx-1.5 ring-2 ring-sky-400/60 outline-none', className, inputClassName)}
      />
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      aria-label={`Edit ${label}`}
      className={cn('group/inline relative -mx-1.5 block w-[calc(100%+0.75rem)] cursor-text rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-foreground/[0.045]', focusRing, className)}
    >
      {value || <span className="text-muted-foreground/70">{placeholder}</span>}
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
        className="block min-h-[5.5rem] w-full resize-none rounded-lg border border-sky-300 dark:border-sky-500/30 bg-background px-3 py-2 text-[14px] leading-relaxed text-foreground shadow-[0_0_0_3px_rgba(14,165,233,0.12)] outline-none placeholder:text-muted-foreground/70"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>Markdown works. <kbd className="rounded border border-border bg-background px-1 font-sans">⌘ Enter</kbd> saves, <kbd className="rounded border border-border bg-background px-1 font-sans">Esc</kbd> cancels.</span>
        <span className="flex gap-1">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(false)} className={cn('rounded-md px-2 py-0.5 font-medium text-muted-foreground hover:bg-muted-foreground/15', focusRing)}>Cancel</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(true)} className={cn('rounded-md bg-foreground px-2.5 py-0.5 font-medium text-background hover:bg-foreground/75', focusRing)}>Save</button>
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
      className={cn('-mx-2 cursor-text rounded-lg px-2 py-1 transition-colors hover:bg-foreground/[0.035]', focusRing)}
    >
      <Markdown text={value} className="text-[14px] leading-[1.65] text-foreground" />
    </div>
  )
}
