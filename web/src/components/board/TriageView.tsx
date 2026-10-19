// Triage mode: the split view for clearing a Proposed backlog. Left, the queue (oldest first); right, the focused ticket as a
// fixed pane. One key decides a card, it animates out of the list and the focus moves on. Pure rules: @/lib/triageMode.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Moon, X } from 'lucide-react'
import type { Agent, Card } from '@shared/types'
import { cardKey } from '@shared/cards'
import { useNow } from '@/components/sparrow/bits'
import { railOf } from '@/lib/faceA'
import { ago, fullDate } from '@/lib/format'
import { stepFocus } from '@/lib/triage'
import { type TriageCommand, type TriageOrder, type TriagePass, departed, focusAfterDeparture, headerText, laterQueue, parseOrder, progressOf, queueOf, triageCommand, withGhosts } from '@/lib/triageMode'
import { cn } from '@/lib/utils'
import { PayoffLabel, Segmented, Tip } from './markers'
import { Swatch } from './swatch'
import { TicketSheet } from './TicketSheet'
import * as act from './triage/actions'
import { BlockedPrompt, Hints } from './triage/parts'

const EXIT_MS = 180
const ORDER_KEY = 'sparrow.triage.order'

const readOrder = (): TriageOrder => {
  try { return parseOrder(localStorage.getItem(ORDER_KEY)) } catch { return parseOrder(null) }
}
const writeOrder = (o: TriageOrder) => {
  try { localStorage.setItem(ORDER_KEY, o) } catch { /* storage blocked: the choice just lasts this visit */ }
}

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
}

export function TriageView({ cards, agents, onExit }: { cards: Card[]; agents: Record<string, Agent>; onExit: () => void }) {
  const now = useNow(60_000)
  const [pass, setPass] = useState<TriagePass>('inbox')
  const [order, setOrder] = useState<TriageOrder>(readOrder)
  const [focusId, setFocusId] = useState<number | null>(null)
  const [ghosts, setGhosts] = useState<{ card: Card; index: number }[]>([])
  const [blocking, setBlocking] = useState<Card | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLDivElement>(null)

  const queue = useMemo(() => queueOf(cards, pass, order), [cards, pass, order])
  const laterCount = useMemo(() => laterQueue(cards).length, [cards])
  const inboxCount = useMemo(() => queueOf(cards, 'inbox').length, [cards])
  const current = queue.find((c) => c.id === focusId) ?? queue[0] ?? null

  // The pile at its fullest this pass: the progress bar is "how much of that is cleared".
  const [peak, setPeak] = useState({ pass, n: queue.length })
  if (peak.pass !== pass) setPeak({ pass, n: queue.length })
  else if (queue.length > peak.n) setPeak({ pass, n: queue.length })
  const progress = progressOf(queue.length, peak.pass === pass ? peak.n : queue.length)

  // What left the queue (by key, by the pane's buttons, from elsewhere) fades out and the focus moves on; an Undo that
  // brings an acted card back puts the focus on it again.
  const prev = useRef<{ pass: TriagePass; queue: Card[] }>({ pass, queue })
  const acted = useRef(new Set<number>())
  useLayoutEffect(() => {
    const before = prev.current
    prev.current = { pass, queue }
    if (before.pass !== pass) { setGhosts([]); setFocusId(null); return }
    const gone = departed(before.queue, queue)
    if (gone.length) setGhosts((g) => [...g.filter((x) => !gone.some((y) => y.card.id === x.card.id)), ...gone])
    const ids = new Set(before.queue.map((c) => c.id))
    const back = queue.find((c) => !ids.has(c.id) && acted.current.has(c.id))
    if (back) { acted.current.delete(back.id); setFocusId(back.id) }
    else if (focusId !== null && gone.some((g) => g.card.id === focusId)) setFocusId(focusAfterDeparture(before.queue, queue, focusId))
  }, [queue, pass, focusId])

  const rows = useMemo(() => withGhosts(queue, ghosts), [queue, ghosts])
  const dropGhost = (id: number) => setGhosts((g) => g.filter((x) => x.card.id !== id))

  useEffect(() => {
    if (current) list.current?.querySelector(`[data-card-id="${current.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  // Keys. One window listener that reads the latest state through a ref (as the board's does).
  const undos = useRef<act.Undo[]>([])
  const run = (card: Card | null, cmd: TriageCommand) => {
    if (cmd.kind === 'step') { setFocusId(stepFocus(queue, card?.id ?? null, cmd.dir)); return }
    if (cmd.kind === 'exit') {
      if (pane.current?.contains(document.activeElement)) list.current?.focus()
      else onExit()
      return
    }
    if (cmd.kind === 'pane') { pane.current?.focus(); return }
    if (cmd.kind === 'undo') { undos.current.pop()?.(); return }
    if (!card) return
    if (cmd.kind === 'block') { setBlocking(card); return }
    acted.current.add(card.id)
    const p =
      cmd.kind === 'accept' ? act.accept(card)
        : cmd.kind === 'later' ? act.shelve(card)
          : cmd.kind === 'bringBack' ? act.bringBack(card)
            : cmd.kind === 'drop' ? act.drop(card)
              : cmd.kind === 'unblock' ? act.patch(card, { blocked_on: null })
                : cmd.kind === 'patch' ? act.patch(card, cmd.body)
                  : null
    void p?.then((undo) => { if (undo) undos.current.push(undo); else acted.current.delete(card.id) })
  }
  const live = useRef({ current, pass, run })
  useEffect(() => { live.current = { current, pass, run } })
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.defaultPrevented || typing(e.target) || document.querySelector('[role=dialog]')) return
      if (t?.closest('[role=listbox]:not([data-triage-list]),[role=menu]')) return // a select / menu is open (the queue itself is a listbox too)
      if (e.key === 'Enter' && t?.closest('button,a,[role=button]')) return // those handle Enter themselves
      const { current, pass, run } = live.current
      const cmd = triageCommand(e, current, pass)
      if (!cmd) return
      e.preventDefault()
      run(current, cmd)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const confirmBlock = (on: string) => {
    const card = blocking
    setBlocking(null)
    list.current?.focus()
    if (card && on.trim()) void act.patch(card, { blocked_on: on.trim() }).then((undo) => { if (undo) undos.current.push(undo) })
  }

  const switchPass = (p: TriagePass) => { undos.current = []; setPass(p) }
  const empty = rows.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-50" data-triage data-pass={pass}>
      <header className="relative flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4">
        <h2 className="text-sm font-semibold tracking-tight text-zinc-900 tabular-nums" data-triage-count>{headerText(pass, queue.length)}</h2>
        <Segmented
          label="Order"
          value={order}
          onChange={(o) => { setOrder(o); writeOrder(o); list.current?.focus() }}
          options={[{ id: 'newest', label: 'Newest' }, { id: 'oldest', label: 'Oldest' }]}
        />
        <div className="ml-auto flex items-center gap-1.5">
          {pass === 'inbox' && laterCount > 0 && <HeaderButton onClick={() => switchPass('later')} data-triage-switch="later"><Moon className="size-3.5" aria-hidden />Review Later ({laterCount})</HeaderButton>}
          {pass === 'later' && <HeaderButton onClick={() => switchPass('inbox')} data-triage-switch="inbox"><ArrowLeft className="size-3.5" aria-hidden />Triage{inboxCount > 0 && ` (${inboxCount})`}</HeaderButton>}
          <HeaderButton onClick={onExit} data-triage-exit>Exit<kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-sans text-[10px] text-zinc-500">Esc</kbd></HeaderButton>
        </div>
        <div className="absolute inset-x-0 -bottom-px h-[3px] bg-transparent" aria-hidden>
          <div
            className={cn('h-full origin-left transition-[width,background-color] duration-300 ease-out', empty ? 'bg-emerald-500' : 'bg-zinc-800')}
            style={{ width: `${Math.round(progress.done * 100)}%` }}
            data-triage-progress={Math.round(progress.done * 100)}
          />
        </div>
      </header>

      {empty ? (
        <Done pass={pass} laterCount={laterCount} onLater={() => switchPass('later')} onBack={() => switchPass('inbox')} onExit={onExit} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <section className="relative flex w-[27rem] shrink-0 flex-col border-r border-zinc-200 bg-white xl:w-[30rem]" aria-label="Queue">
            <div ref={list} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none" data-triage-list role="listbox" aria-label={pass === 'inbox' ? 'Proposed tickets' : 'Tickets under Later'}>
              {rows.map(({ card, ghost }) => ghost
                ? <Ghost key={card.id} card={card} agents={agents} now={now} pass={pass} onGone={() => dropGhost(card.id)} />
                : <Row key={card.id} card={card} agents={agents} now={now} pass={pass} focused={card.id === current?.id} onFocus={() => { setFocusId(card.id); list.current?.focus() }} />)}
            </div>
            {blocking ? <BlockedPrompt card={blocking} onSubmit={confirmBlock} onCancel={() => { setBlocking(null); list.current?.focus() }} /> : <Hints pass={pass} />}
          </section>
          <div ref={pane} tabIndex={-1} className="min-w-0 flex-1 outline-none" data-triage-pane>
            {current && <TicketSheet cardId={current.id} onClose={onExit} mode="pane" />}
          </div>
        </div>
      )}
    </div>
  )
}

function HeaderButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', className)} {...props} />
}

function Row({ card, agents, now, pass, focused, onFocus }: { card: Card; agents: Record<string, Agent>; now: number; pass: TriagePass; focused: boolean; onFocus: () => void }) {
  const rail = railOf(card)
  const by = card.created_by === 'user' ? 'you' : agents[card.created_by] ? `@${agents[card.created_by].handle}` : card.created_by
  const at = pass === 'later' ? card.later_at : card.created_at
  return (
    <div
      role="option"
      aria-selected={focused}
      data-card-id={card.id}
      data-focused={focused || undefined}
      data-triage-row
      onClick={onFocus}
      className={cn('flex h-10 cursor-default items-center gap-2.5 border-b border-zinc-100 pr-3.5 pl-2 text-[13px] transition-colors', focused ? 'bg-violet-50 shadow-[inset_0_0_0_1px_rgb(221_214_254)]' : 'hover:bg-zinc-50')}
    >
      <span className="flex w-1.5 shrink-0 gap-px" data-rail={rail ?? 'none'}>
        {(rail === 'urgent' || rail === 'both') && <Swatch kind="urgent" className="h-6 w-1.5" />}
        {(rail === 'blocked' || rail === 'both') && <Tip label={`Blocked on ${card.blocked_on}`}><Swatch kind="blocked" className="h-6 w-1.5" /></Tip>}
      </span>
      <span className="w-14 shrink-0 font-mono text-[11px] text-zinc-400 tabular-nums">{cardKey(card)}</span>
      <span className={cn('min-w-0 flex-1 truncate font-medium', focused ? 'text-zinc-950' : 'text-zinc-800')}>{card.title}</span>
      <PayoffLabel card={card} />
      <Tip label={`${pass === 'later' ? 'Shelved' : 'Proposed'} ${fullDate(at ?? card.created_at)}${pass === 'inbox' ? ` by ${by}` : ''}`}>
        <span className="w-8 shrink-0 text-right font-mono text-[11px] text-zinc-400 tabular-nums">{ago(at ?? card.created_at, now)}</span>
      </Tip>
    </div>
  )
}

/** A row on its way out: collapses and fades in EXIT_MS, then asks to be removed. */
function Ghost({ card, agents, now, pass, onGone }: { card: Card; agents: Record<string, Agent>; now: number; pass: TriagePass; onGone: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  const gone = useRef(onGone)
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const h = node.offsetHeight
    const a = node.animate([{ height: `${h}px`, opacity: 1, transform: 'translateX(0)' }, { height: '0px', opacity: 0, transform: 'translateX(12px)' }], { duration: reduce ? 0 : EXIT_MS, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' })
    a.finished.then(() => gone.current(), () => {})
    return () => a.cancel()
  }, [])
  return (
    <div ref={el} className="overflow-hidden" data-triage-ghost aria-hidden>
      <Row card={card} agents={agents} now={now} pass={pass} focused={false} onFocus={() => {}} />
    </div>
  )
}

function Done({ pass, laterCount, onLater, onBack, onExit }: { pass: TriagePass; laterCount: number; onLater: () => void; onBack: () => void; onExit: () => void }) {
  const inbox = pass === 'inbox'
  return (
    <div className="flex flex-1 items-center justify-center" data-triage-done={pass}>
      <div className="flex max-w-sm animate-in flex-col items-center gap-3 text-center duration-500 fade-in-0 zoom-in-95">
        <div className="flex size-12 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200"><Check className="size-6 text-emerald-600" strokeWidth={2.5} aria-hidden /></div>
        <h2 className="text-lg font-semibold tracking-tight text-zinc-900">{inbox ? 'Triage done' : 'Later is clear'}</h2>
        <p className="text-sm text-zinc-500">{inbox ? 'Nothing left to decide. Captains’ new proposals will land here.' : 'Nothing is parked under Later.'}</p>
        <div className="mt-2 flex items-center gap-2">
          {inbox && laterCount > 0 && (
            <button type="button" onClick={onLater} data-triage-review-later className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
              <Moon className="size-4" aria-hidden />Review Later ({laterCount})
            </button>
          )}
          {!inbox && (
            <button type="button" onClick={onBack} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3.5 text-[13px] font-semibold text-zinc-700 transition-colors hover:bg-zinc-50">
              <ArrowLeft className="size-4" aria-hidden />Back to Triage
            </button>
          )}
          <button type="button" onClick={onExit} data-triage-exit-done className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3.5 text-[13px] font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            <X className="size-4" aria-hidden />Back to board
          </button>
        </div>
      </div>
    </div>
  )
}
