import { useCallback, useState } from 'react'
import { loadPrefs, savePrefs, type BoardPrefs } from '@/lib/boardPrefs'

/** Board preferences of the current project; every change is saved (best effort) and a project switch reloads them. */
export function useBoardPrefs(project: string | null): [BoardPrefs, (fn: (p: BoardPrefs) => BoardPrefs) => void] {
  const [state, setState] = useState(() => ({ project, prefs: loadPrefs(project) }))
  let cur = state
  if (state.project !== project) {
    cur = { project, prefs: loadPrefs(project) }
    setState(cur)
  }
  const update = useCallback((fn: (p: BoardPrefs) => BoardPrefs) => {
    setState((s) => {
      const prefs = fn(s.prefs)
      savePrefs(s.project, prefs)
      return { ...s, prefs }
    })
  }, [])
  return [cur.prefs, update]
}
