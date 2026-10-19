// Activity: comments as readable blocks, server events as compact grey lines, a composer at the bottom.
import { type ReactNode, useState } from 'react'
import { ArrowRightLeft, Ban, CheckSquare, ChevronRight, Flame, History, Megaphone, Moon, PenLine, Send, UserRound } from 'lucide-react'
import type { Card, CardNote } from '@shared/types'
import { patchCard } from '@/lib/cardActions'
import { type EventIcon, commentCount, eventIcon, noteKind, timeline } from '@/lib/activity'
import { whoName } from '@/lib/cardText'
import { type TimelineItem, foldMoves, movesLabel, prettyEvent } from '@/lib/sheetLogic'
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
      <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm border border-zinc-200/80 bg-white px-3 py-2">
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

/** A run of moves as one line (`Moved To do → In progress → Review → Done · over 5d`); click for each step. */
function Moves({ item, now }: { item: Extract<TimelineItem, { kind: 'moves' }>; now: number }) {
  const [open, setOpen] = useState(false)
  return (
    <li data-note="moves">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-ml-0.5 flex max-w-full items-center gap-2.5 rounded-md py-0.5 pr-2 pl-1 text-left text-[12px] text-zinc-500 hover:bg-zinc-900/[0.04] hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-zinc-400 [&_svg]:size-3.5" aria-hidden><ArrowRightLeft /></span>
        <span className="min-w-0 truncate">{movesLabel(item.path, item.spanMs)}</span>
        <ChevronRight className={cn('size-3 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && <ol className="mt-1 space-y-1.5 border-l border-zinc-200 pl-3 ml-2.5">{item.notes.map((n, i) => <EventLine key={i} note={n} now={now} />)}</ol>}
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
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-2 focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-200/70">
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
  const items: TimelineItem[] = commentsOnly ? shown.map((note) => ({ kind: 'note', note })) : foldMoves(shown)
  const comments = commentCount(card)
  return (
    <section data-section="activity">
      <header className="mb-3 flex items-baseline gap-2.5">
        <h3 className="text-[11px] font-semibold tracking-[0.09em] text-zinc-400 uppercase">Activity</h3>
        <span className="text-[12px] text-zinc-400 tabular-nums">{comments} {comments === 1 ? 'comment' : 'comments'}</span>
        {all.length > comments && (
          <button
            type="button"
            aria-pressed={commentsOnly}
            onClick={() => setCommentsOnly((v) => !v)}
            className={cn('ml-auto rounded px-1 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', commentsOnly ? 'font-medium text-zinc-800 underline underline-offset-4' : 'text-zinc-400 hover:text-zinc-700')}
          >
            Comments only
          </button>
        )}
      </header>
      {shown.length === 0 ? (
        <p className="text-[13px] text-zinc-400">
          {all.length ? 'No comments yet.' : 'Nothing yet. Agents report here with sparrow update --card, and every move shows up as a line.'}
        </p>
      ) : (
        <ol className="space-y-2.5">
          {items.map((it, i) => it.kind === 'moves'
            ? <Moves key={`m${it.id}`} item={it} now={now} />
            : noteKind(it.note) === 'comment' ? <Comment key={i} note={it.note} now={now} name={who(it.note.by)} /> : <EventLine key={i} note={it.note} now={now} />)}
        </ol>
      )}
      <Composer card={card} />
    </section>
  )
}
