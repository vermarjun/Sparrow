// Captain actions shared by the sidebar, project home, captain page and ⌘K: resume (§3.3), copy lines, archive.
// Every action reports through a toast; nothing here renders.
import { toast } from 'sonner'
import type { CaptainSummary } from '@shared/types'
import { HttpError } from './api'
import { captainName } from './captains'
import { useStore } from './store'

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  toast.success(what, { description: text.length > 90 ? `${text.slice(0, 90)}…` : text, duration: 2500 })
}

/** A terminal captain seen < 2 min ago may still be open there; resuming would run two processes on one session (§3.3). */
export function mayBeOpenInTerminal(s: Pick<CaptainSummary, 'agent'>, now = Date.now()): boolean {
  return s.agent.captain?.origin === 'terminal' && s.agent.last_seen_at != null && now - s.agent.last_seen_at < 2 * 60_000
}

/** What the primary Resume button does right now. */
export function resumeMode(s: Pick<CaptainSummary, 'resume'>): 'attach' | 'resume' | 'manual' | 'none' {
  if (s.resume.attach) return 'attach'
  if (!s.resume.session_id) return 'none'
  return s.resume.harness === 'claude' ? 'resume' : 'manual'
}

export const RESUME_LABEL = { attach: 'Open in tmux', resume: 'Resume', manual: 'Copy resume command', none: 'No session yet' } as const

/**
 * The primary action: copies the attach line when its window is open, else asks Sparrow to reopen it in tmux and copies
 * the attach line; non-Claude captains get their manual command copied. `force` skips the "still open in a terminal" check.
 */
export async function resumeCaptain(s: CaptainSummary, force = false): Promise<void> {
  const mode = resumeMode(s)
  if (mode === 'attach') return copyText(s.resume.attach!, 'tmux attach line copied')
  if (mode === 'manual') return copyText(s.resume.command!, `Run this to reopen @${s.agent.handle}`)
  if (mode === 'none') { toast.message(`@${s.agent.handle} has no session id yet`, { description: 'It gets one the first time it runs a sparrow command.' }); return }
  if (!force && mayBeOpenInTerminal(s)) {
    toast.warning(`@${s.agent.handle} was active under a minute or two ago`, {
      description: 'It may still be open in a terminal. Resuming starts a second process on the same session.',
      action: { label: 'Resume anyway', onClick: () => void resumeCaptain(s, true) },
      duration: 8000,
    })
    return
  }
  try {
    const res = await useStore.getState().resumeCaptain(s.agent.id)
    await copyText(res.attach, `Resumed ${captainName(s.agent)} in tmux · attach line copied`)
  } catch (e) {
    const msg = (e as Error).message
    const line = msg.match(/(tmux attach .*|cd .* && .*)$/)?.[1]
    if (e instanceof HttpError && line) await copyText(line, e.status === 409 ? 'Already open · attach line copied' : 'Copied the command to run')
    else toast.error(`Could not resume @${s.agent.handle}`, { description: msg })
  }
}

export async function setArchived(s: CaptainSummary, archived: boolean): Promise<void> {
  try {
    await useStore.getState().patchCaptain(s.agent.id, { archived })
    if (archived) toast(`Archived ${captainName(s.agent)}`, { action: { label: 'Undo', onClick: () => void setArchived(s, false) } })
    else toast(`Unarchived ${captainName(s.agent)}`)
  } catch (e) {
    toast.error(archived ? 'Could not archive' : 'Could not unarchive', { description: (e as Error).message })
  }
}

/** Rename (handle) or retitle; returns the error message for inline display, or null on success. */
export async function patchCaptainField(id: string, patch: { title?: string | null; name?: string }): Promise<string | null> {
  try {
    await useStore.getState().patchCaptain(id, patch)
    return null
  } catch (e) {
    return (e as Error).message
  }
}
