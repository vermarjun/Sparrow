// Sticky footer: the next move for the ticket's state.
import { ArrowRight, Ban, Check, CheckCircle2, CircleAlert, Moon, Play, RotateCcw, Send, Undo2, X } from 'lucide-react'
import type { Card } from '@shared/types'
import { STATE_LABEL } from '@shared/cards'
import { patchCard } from '@/lib/cardActions'
import { COLUMN_BY_STATE } from '@/lib/boardStyle'
import { type SheetAction, actionTarget, checkProgress, nextActions } from '@/lib/sheetLogic'
import { cn } from '@/lib/utils'

const ICON: Record<SheetAction['icon'], typeof Check> = {
  accept: Check, later: Moon, drop: X, start: Play, review: Send, approve: CheckCircle2, back: Undo2, reopen: RotateCcw, restore: RotateCcw,
}

const TONE: Record<SheetAction['tone'], string> = {
  primary: 'bg-zinc-900 text-white hover:bg-zinc-700 border-transparent shadow-sm',
  approve: 'bg-emerald-600 text-white hover:bg-emerald-700 border-transparent shadow-sm',
  quiet: 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50',
  danger: 'bg-white text-red-700 border-red-200 hover:bg-red-50',
}

function Hint({ card }: { card: Card }) {
  const p = checkProgress(card.checks)
  const open = p.total - p.done
  if (card.state === 'review') {
    return open > 0
      ? <span className="inline-flex items-center gap-1.5 text-amber-800"><CircleAlert className="size-3.5" aria-hidden />{open} of {p.total} done-when {open === 1 ? 'check is' : 'checks are'} still open</span>
      : <span className="text-zinc-500">{p.total ? 'Every done-when check is ticked. ' : ''}Approve when it is what you asked for.</span>
  }
  if (card.blocked_on && card.state !== 'done' && card.state !== 'dropped') return <span className="inline-flex items-center gap-1.5 text-orange-700"><Ban className="size-3.5" aria-hidden />Blocked: unblock it before work continues</span>
  if (card.state === 'proposed') return <span className="text-zinc-500">Accept it to queue it, or park or drop it.</span>
  if (card.state === 'todo') return <span className="text-zinc-500">Hand it to an agent: copy the brief or the key.</span>
  if (card.state === 'in_progress') return <span className="text-zinc-500">{card.assignee_id ? 'Being worked on.' : 'Nobody is assigned yet.'}</span>
  if (card.state === 'done') return <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="size-3.5" aria-hidden />Done</span>
  return null
}

export function SheetFooter({ card }: { card: Card }) {
  const actions = nextActions(card)
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-zinc-200 bg-white/95 px-6 py-3 backdrop-blur" data-footer>
      <div className="min-w-0 flex-1 truncate text-[12.5px]"><Hint card={card} /></div>
      <div className="flex items-center gap-2">
        {[...actions].reverse().map((a) => {
          const Icon = ICON[a.icon]
          const to = actionTarget(a)
          return (
            <button
              key={a.id}
              type="button"
              data-action={a.id}
              onClick={() => patchCard(card.id, a.patch)}
              className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3.5 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', TONE[a.tone])}
            >
              <Icon className="size-4" aria-hidden />
              {a.label}
              {to && a.tone !== 'quiet' && a.tone !== 'danger' && (
                <>
                  <ArrowRight className="size-3.5 opacity-60" aria-hidden />
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-1.5 text-[11.5px] font-medium">
                    <span className={cn('size-1.5 rounded-full ring-1 ring-white/70', COLUMN_BY_STATE[to].dot)} aria-hidden />{STATE_LABEL[to]}
                  </span>
                </>
              )}
            </button>
          )
        })}
      </div>
    </footer>
  )
}
