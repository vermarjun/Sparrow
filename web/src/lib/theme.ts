// Theme: 'system' (default) follows the OS; the choice is remembered. The `dark` class on <html> drives shadcn tokens.
import { useEffect, useSyncExternalStore } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
const KEY = 'sparrow.theme'
const listeners = new Set<() => void>()

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}

const systemDark = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches

export function applyTheme(pref = themePref()) {
  const dark = pref === 'dark' || (pref === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export function setThemePref(pref: ThemePref) {
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref) } catch { /* private mode */ }
  applyTheme(pref)
  for (const l of listeners) l()
}

/** Resolved theme (what is on screen) + the stored preference. */
export function useTheme(): { pref: ThemePref; dark: boolean; set: (p: ThemePref) => void; toggle: () => void } {
  const pref = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, themePref, () => 'system' as ThemePref)
  useEffect(() => {
    if (pref !== 'system') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => { applyTheme('system'); for (const l of listeners) l() }
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [pref])
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  return { pref, dark, set: setThemePref, toggle: () => setThemePref(dark ? 'light' : 'dark') }
}
