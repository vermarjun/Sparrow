import { describe, expect, test } from 'bun:test'
import type { ResumeView } from '@shared/types'
import { fieldError } from '@/lib/settings'
import { blank, fromView } from '@/lib/resumeForm'

describe('settings page field check', () => {
  const f = { min: 1, max: 10, unit: 'levels' }
  test('whole numbers inside the range pass', () => {
    expect(fieldError(f, '3')).toBeNull()
    expect(fieldError(f, ' 10 ')).toBeNull()
  })
  test('out of range, decimals and text fail with the reason', () => {
    expect(fieldError(f, '0')).toBe('between 1 and 10')
    expect(fieldError(f, '11')).toBe('between 1 and 10')
    expect(fieldError(f, '2.5')).toBe('a whole number (levels)')
    expect(fieldError(f, 'abc')).toBe('a whole number (levels)')
    expect(fieldError(f, '')).toBe('a whole number (levels)')
  })
})

describe('resume form carries helper / one_shot', () => {
  test('blank = off; fromView keeps the flags so a save never drops them', () => {
    expect([blank().helper, blank().one_shot]).toEqual([false, false])
    const v = { slug: 'deckhand', title: 'Deckhand', description: '', harness: 'claude', model: 'haiku', effort: 'medium', can_hire: [], limits: { quiet_minutes: 5, max_call_minutes: 15 }, body: 'b', path: '', skills: [], helper: true, one_shot: true } as unknown as ResumeView
    expect([fromView(v).helper, fromView(v).one_shot]).toEqual([true, true])
    const plain = { ...v, helper: undefined, one_shot: undefined } as unknown as ResumeView
    expect([fromView(plain).helper, fromView(plain).one_shot]).toEqual([false, false])
  })
})
