// Small hooks of the captain page: row keyboard navigation, measured clamping, open-call timing, live screen.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type Screen } from '@/lib/api'
import { openCallStart } from '@/lib/captainPage'
import { useStore } from '@/lib/store'

/** j/k and ↑/↓ move focus between `[data-row]` elements inside a container (Enter activates a focused button natively). */
export function useRowNav() {
  return useCallback((e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
    const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir) return
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')]
    if (!rows.length) return
    const i = rows.indexOf(t.closest<HTMLElement>('[data-row]') as HTMLElement)
    const next = rows[i === -1 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + dir))]
    e.preventDefault()
    next.focus()
    next.scrollIntoView({ block: 'nearest' })
  }, [])
}

/** True when the element's content is taller than its clamped box (so "Show more" is worth showing). Re-measures on resize. */
export function useOverflow<T extends HTMLElement>(deps: unknown[]): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 2)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return [ref, over]
}

/** Start time of each working agent's open call: one fetch per working agent, refreshed when a call event arrives. */
export function useOpenCalls(workingIds: string[]): Record<string, number> {
  const lastCall = useStore((s) => s.lastCall)
  const [starts, setStarts] = useState<Record<string, number>>({})
  const key = workingIds.slice().sort().join(',')
  const bump = lastCall?.at ?? 0
  useEffect(() => {
    let live = true
    const ids = key ? key.split(',') : []
    void Promise.all(ids.map((id) => api.agent(id).then((d) => [id, openCallStart(d.calls)] as const).catch(() => [id, null] as const))).then((rows) => {
      if (!live) return
      const next: Record<string, number> = {}
      for (const [id, at] of rows) if (at != null) next[id] = at
      setStarts(next)
    })
    return () => { live = false }
  }, [key, bump])
  return starts
}

/** The agent's screen: polled every 2 s while `live` (working), fetched once otherwise. Unchanged text does not re-render. */
export function useScreen(agentId: string, live: boolean): { screen: Screen | null; error: string | null } {
  const [screen, setScreen] = useState<Screen | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    setScreen(null); setError(null)
    const tick = async () => {
      try {
        const s = await api.screen(agentId, 200)
        if (!alive) return
        setScreen((prev) => (prev && prev.text === s.text && prev.live === s.live ? prev : s))
        setError(null)
      } catch (e) {
        if (alive) setError((e as Error).message)
      }
      if (alive && live) timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [agentId, live])
  return { screen, error }
}
