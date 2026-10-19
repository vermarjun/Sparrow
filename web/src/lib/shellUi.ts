// Shell UI state that more than one component touches: sidebar collapse (remembered), the mobile drawer, the ⌘K palette,
// the New captain dialog and the sidebar search. Nothing here talks to the server.
import { create } from 'zustand'

const KEY = 'sparrow.sidebar'
const readCollapsed = () => { try { return localStorage.getItem(KEY) === 'collapsed' } catch { return false } }

interface ShellUi {
  collapsed: boolean
  mobileOpen: boolean
  paletteOpen: boolean
  newOpen: boolean
  /** Sidebar search text; `focusTick` bumps to ask the search input to take focus. */
  query: string
  focusTick: number
  setCollapsed: (v: boolean) => void
  toggleCollapsed: () => void
  setMobileOpen: (v: boolean) => void
  setPalette: (v: boolean) => void
  setNew: (v: boolean) => void
  setQuery: (q: string) => void
  focusSearch: () => void
}

export const useShell = create<ShellUi>((set, get) => ({
  collapsed: readCollapsed(),
  mobileOpen: false,
  paletteOpen: false,
  newOpen: false,
  query: '',
  focusTick: 0,
  setCollapsed(collapsed) {
    try { localStorage.setItem(KEY, collapsed ? 'collapsed' : 'open') } catch { /* private mode */ }
    set({ collapsed })
  },
  toggleCollapsed: () => get().setCollapsed(!get().collapsed),
  setMobileOpen: (mobileOpen) => set({ mobileOpen }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setNew: (newOpen) => set({ newOpen, ...(newOpen ? { paletteOpen: false, mobileOpen: false } : {}) }),
  setQuery: (query) => set({ query }),
  focusSearch() {
    if (get().collapsed) get().setCollapsed(false)
    set({ focusTick: get().focusTick + 1 })
  },
}))
