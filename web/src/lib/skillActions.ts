// Toggle a skill for one harness: PUT, surface conflicts, refresh the page state.
import { toast } from 'sonner'
import { api } from './api'
import { HARNESS_NAME, toggled, type Harness, type LibrarySkill } from './skills'
import { useStore } from './store'

export async function setHarness(skill: LibrarySkill, harness: Harness): Promise<boolean> {
  try {
    const r = await api.setSkillHarnesses(skill.name, toggled(skill.harnesses, harness))
    const conflict = r.conflicts[0]
    if (conflict) toast.warning(`${HARNESS_NAME[harness]}: ${conflict.reason ?? 'conflict'}. The existing folder was left untouched: see Conflicts.`)
    await useStore.getState().loadSkills()
    return true
  } catch (e) {
    toast.error(`Could not change ${skill.name}: ${(e as Error).message}`)
    void useStore.getState().loadSkills()
    return false
  }
}
