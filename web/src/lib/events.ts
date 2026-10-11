// useEvents(project): EventSource on /api/events?project=… with reconnect + backoff.
// Every (re)connect reloads the project so events missed while offline are not lost.
import { useEffect } from 'react'
import type { ServerEvent } from '@shared/types'
import { useStore } from './store'

export function useEvents(project: string | null) {
  useEffect(() => {
    if (!project) return
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let closed = false
    let backoff = 1000
    const { setConn, apply, loadProject } = useStore.getState()

    const connect = () => {
      if (closed) return
      setConn('connecting')
      es = new EventSource(`/api/events?project=${encodeURIComponent(project)}`)
      es.onopen = () => {
        backoff = 1000
        setConn('live')
        void loadProject()
      }
      es.onmessage = (e) => {
        try { apply(JSON.parse(e.data) as ServerEvent) } catch { /* ignore malformed */ }
      }
      es.onerror = () => {
        setConn('down')
        es?.close()
        es = null
        if (closed) return
        timer = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 15000)
      }
    }
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      es?.close()
    }
  }, [project])
}
