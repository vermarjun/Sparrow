// useEvents(project): EventSource on /api/events[?project=…] with reconnect + backoff.
// The stream is open even with no project: global events (catalog, doctor, resumes) reach every subscriber.
// Every (re)connect reloads the project and the globals so events missed while offline are not lost.
import { useEffect } from 'react'
import type { ServerEvent } from '@shared/types'
import { useStore } from './store'

export function useEvents(project: string | null) {
  useEffect(() => {
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let closed = false
    let backoff = 1000
    const { setConn, apply, loadProject, loadGlobals } = useStore.getState()

    const connect = () => {
      if (closed) return
      setConn('connecting')
      es = new EventSource(project ? `/api/events?project=${encodeURIComponent(project)}` : '/api/events')
      es.onopen = () => {
        backoff = 1000
        setConn('live')
        void loadProject()
        void loadGlobals()
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
