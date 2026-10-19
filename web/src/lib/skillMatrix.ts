// Agent matrix + the resume editor's Skills field: pure helpers (unit-tested in web/test/skillMatrix.test.ts).
import type { HarnessName } from '@shared/types'

export interface MatrixResume { slug: string; title: string; harness: HarnessName; skills: string[]; hired: number; stale: number }
/** GET /api/skills/matrix */
export interface SkillMatrix { resumes: MatrixResume[]; skills: string[]; locked: string[] }

/** Add `name` to a resume's skills, or remove it when present. Order of the others is kept. */
export const toggleSkill = (skills: string[], name: string): string[] =>
  skills.includes(name) ? skills.filter((s) => s !== name) : [...skills, name]

/** Names in a resume's list that are neither in the library nor a locked Sparrow skill (typos, deleted skills, bad names). */
export const missingSkills = (skills: string[], library: string[], locked: string[]): string[] =>
  skills.filter((s) => !library.includes(s) && !locked.includes(s))

/** Every missing name across all resumes, first-seen order: the warning rows of the matrix. */
export function warningRows(m: SkillMatrix): string[] {
  const out: string[] = []
  for (const r of m.resumes) for (const n of missingSkills(r.skills, m.skills, m.locked)) if (!out.includes(n)) out.push(n)
  return out
}

/** The note shown after a toggle. Existing agents keep their snapshot until the resume is applied. */
export function changeNote(resumeTitle: string, skill: string, added: boolean, hired: number): string {
  const head = `${skill} ${added ? 'added to' : 'removed from'} ${resumeTitle}: takes effect at the next hire`
  return hired > 0
    ? `${head}; ${hired} hired agent${hired === 1 ? '' : 's'} keep${hired === 1 ? 's' : ''} their current skills until Apply.`
    : `${head}.`
}

export interface SkillChoices { locked: string[]; available: string[]; missing: string[] }
/** Chips for the editor's Skills field: fixed locked ones, library skills to pick, selected names the library lacks. */
export function skillChoices(selected: string[], library: string[], locked: string[]): SkillChoices {
  return { locked, available: library, missing: missingSkills(selected, library, locked) }
}
