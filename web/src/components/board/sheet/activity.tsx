// Activity: comments as readable blocks, server events as compact grey lines, a composer at the bottom.
import { type ReactNode, useState } from 'react'
import { ArrowRightLeft, Ban, CheckSquare, ChevronRight, Flame, History, Megaphone, Moon, PenLine, Send, UserRound } from 'lucide-react'
import type { Card, CardNote } from '@shared/types'
import { patchCard } from '@/lib/cardActions'
import { type EventIcon, commentCount, eventIcon, noteKind, timeline } from '@/lib/activity'
import { whoName } from '@/lib/cardText'
import { type TimelineItem, foldEvents, prettyEvent } from '@/lib/sheetLogic'
import { agoLabel, fullDate } from '@/lib/format'
import { Markdown } from '@/components/sparrow/Markdown'
import { Tip } from '@/components/board/markers'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const ICON: Record<EventIcon, ReactNode> = {
  move: <ArrowRightLeft />, assign: <UserRound />, urgent: <Flame />, blocked: <Ban />, later: <Moon />,
  edit: <PenLine />, check: <CheckSquare />, report: <Megaphone />, other: <History />,
}

function Comment({ note, now, name }: { note: CardNote; now: number; name: string }) {
  const mine = note.by === 'user'
  return (
    <li data-note="comment" className="flex gap-2.5">
      <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold uppercase', mine ? 'bg-zinc-800 text-white' : 'bg-zinc-200 text-zinc-700')} aria-hidden>
        {name.replace(/^@/, '').slice(0, 1) || '?'}
      </span>
      <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm border border-zinc-200/90 bg-white px-3 py-2 shadow-[0_1px_2px_rgba(24,24,27,0.04)]">
        <div className="mb-0.5 flex items-baseline gap-2 text-[12px]">
          <span className="font-semibold text-zinc-800">{mine ? 'You' : name}</span>
          <Tip label={fullDate(note.at)}><span className="text-zinc-400">{agoLabel(note.at, now)}</span></Tip>
        </div>
        <Markdown text={note.text} className="text-[13.5px] leading-[1.6] text-zinc-800" />
      </div>
    </li>
  )
}

function EventLine({ note, now }: { note: CardNote; now: number }) {
  return (
    <li data-note="event" className="flex items-center gap-2.5 pl-1 text-[12px] text-zinc-500">
      <span className="flex size-4 shrink-0 items-center justify-center text-zinc-400 [&_svg]:size-3.5" aria-hidden>{ICON[eventIcon(note.text)]}</span>
      <span className="min-w-0 truncate" title={note.text}>{prettyEvent(note.text)}</span>
      <Tip label={fullDate(note.at)}><span className="shrink-0 text-zinc-400">{agoLabel(note.at, now)}</span></Tip>
    </li>
  )
}

function Folded({ notes, now }: { notes: CardNote[]; now: number }) {
  const [open, setOpen] = useState(false)
  return (
    <li data-note="folded">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md py-0.5 pr-2 pl-1 text-[12px] font-medium text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        {open ? 'Hide' : 'Show'} {notes.length} earlier events
      </button>
      {open && <ol className="mt-1 space-y-2.5">{notes.map((n, i) => <EventLine key={i} note={n} now={now} />)}</ol>}
    </li>
  )
}

function Composer({ card }: { card: Card }) {
  const [text, setText] = useState('')
  const send = async () => {
    const t = text.trim()
    if (!t) return
    setText('')
    const saved = await patchCard(card.id, { note: t })
    if (!saved) setText(t)
  }
  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-2 shadow-[0_1px_2px_rgba(24,24,27,0.04)] focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-200/70">
      <textarea
        value={text}
        rows={2}
        aria-label="Add a comment"
        placeholder="Leave a comment for whoever picks this up"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur() }
        }}
        className="block w-full resize-none bg-transparent px-1.5 py-1 text-[13.5px] leading-relaxed outline-none placeholder:text-zinc-400"
      />
      <div className="flex items-center justify-between px-1.5 pt-1">
        <span className="text-[11px] text-zinc-400"><kbd className="rounded border border-zinc-300 bg-zinc-50 px-1 font-sans">⌘ Enter</kbd> to send</span>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={() => void send()}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 text-[12.5px] font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:bg-zinc-200 disabled:text-zinc-400"
        >
          <Send className="size-3.5" aria-hidden />Comment
        </button>
      </div>
    </div>
  )
}

export function Activity({ card, now }: { card: Card; now: number }) {
  const agents = useStore((s) => s.agents)
  const who = whoName(agents)
  const [commentsOnly, setCommentsOnly] = useState(false)
  const all = timeline(card, false)
  const shown = commentsOnly ? timeline(card, true) : all
  const items: TimelineItem[] = commentsOnly ? shown.map((note) => ({ kind: 'note', note })) : foldEvents(shown)
  const comments = commentCount(card)
  return (
    <section data-section="activity">
      <header className="mb-3 flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-zinc-100 text-zinc-600"><History className="size-3.5" /></span>
        <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-zinc-600 uppercase">Activity</h3>
        <span className="text-[12px] text-zinc-400 tabular-nums">{comments} {comments === 1 ? 'comment' : 'comments'}</span>
        {all.length > comments && (
          <button
            type="button"
            aria-pressed={commentsOnly}
            onClick={() => setCommentsOnly((v) => !v)}
            className={cn('ml-auto rounded-md px-2 py-0.5 text-[12px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', commentsOnly ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800')}
          >
            Comments only
          </button>
        )}
      </header>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-4 text-center text-[12.5px] text-zinc-500">
          {all.length ? 'No comments yet.' : 'Nothing has happened on this ticket yet. Agents report here with sparrow update --card, and every move shows up as a line.'}
        </p>
      ) : (
        <ol className="space-y-2.5">
          {items.map((it, i) => it.kind === 'folded'
            ? <Folded key={`f${it.id}`} notes={it.notes} now={now} />
            : noteKind(it.note) === 'comment' ? <Comment key={i} note={it.note} now={now} name={who(it.note.by)} /> : <EventLine key={i} note={it.note} now={now} />)}
        </ol>
      )}
      <Composer card={card} />
    </section>
  )
}
