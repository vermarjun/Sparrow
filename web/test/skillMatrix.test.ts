import { describe, expect, test } from 'bun:test'
import { changeNote, missingSkills, skillChoices, toggleSkill, warningRows, type SkillMatrix } from '../src/lib/skillMatrix'

describe('skill matrix helpers', () => {
  test('toggleSkill adds at the end and removes in place', () => {
    expect(toggleSkill(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleSkill(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(toggleSkill([], 'a')).toEqual(['a'])
  })
  test('missingSkills: not in the library and not locked', () => {
    expect(missingSkills(['alpha', 'ghost', 'sparrow-worker', '../x'], ['alpha'], ['sparrow-worker', 'sparrow-captain'])).toEqual(['ghost', '../x'])
  })
  test('warningRows: union across resumes, first seen first', () => {
    const m: SkillMatrix = {
      skills: ['alpha'], locked: ['sparrow-worker'],
      resumes: [
        { slug: 'a', title: 'A', harness: 'claude', skills: ['alpha', 'ghost'], hired: 0, stale: 0 },
        { slug: 'b', title: 'B', harness: 'codex', skills: ['zzz', 'ghost'], hired: 0, stale: 0 },
      ],
    }
    expect(warningRows(m)).toEqual(['ghost', 'zzz'])
  })
  test('changeNote mentions Apply only when agents are hired', () => {
    expect(changeNote('Builder', 'alpha', true, 0)).toBe('alpha added to Builder: takes effect at the next hire.')
    expect(changeNote('Builder', 'alpha', false, 1)).toBe('alpha removed from Builder: takes effect at the next hire; 1 hired agent keeps their current skills until Apply.')
    expect(changeNote('Builder', 'alpha', true, 3)).toContain('3 hired agents keep their current skills until Apply.')
  })
  test('skillChoices', () => {
    expect(skillChoices(['alpha', 'ghost'], ['alpha', 'beta'], ['sparrow-worker'])).toEqual({ locked: ['sparrow-worker'], available: ['alpha', 'beta'], missing: ['ghost'] })
  })
})
