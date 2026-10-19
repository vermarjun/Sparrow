import { useEffect } from 'react'
import type { Route } from '@/lib/route'
import { useShell } from '@/lib/shellUi'

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
}
const desktop = () => typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches

/** ⌘K palette, ⌘B sidebar, `/` search (the Board owns `/` on its own page). */
export function useShellKeys(route: Route) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const ui = useShell.getState()
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); ui.setPalette(!ui.paletteOpen); return }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        if (desktop()) ui.toggleCollapsed(); else ui.setMobileOpen(!ui.mobileOpen)
        return
      }
      if (e.key === '/' && !mod && !e.altKey && !e.defaultPrevented && !typing(e.target) && route.page !== 'board' && desktop() && !document.querySelector('[role=dialog]')) {
        e.preventDefault()
        ui.focusSearch()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [route.page])
}
