import { describe, expect, test } from 'bun:test'
import type { CardLevel } from '@shared/types'
import { CATEGORY_PALETTE } from '../src/lib/boardStyle'
import { AVATAR_TONE, CATEGORY_DOTS, assigneeTip, categoryDot, initials, partialOf, payoffOf, payoffSentence, payoffTip, railOf, railTip } from '../src/lib/faceA'

const L: CardLevel[] = ['high', 'medium', 'low']
const E: CardLevel[] = ['low', 'medium', 'high']

describe('payoff matrix', () => {
  test('every impact x effort cell has its word', () => {
    const got = L.map((i) => E.map((e) => payoffOf({ impact: i, effort: e })?.label))
    expect(got).toEqual([
      ['Quick win', 'Worth it', 'Big bet'],
      ['Quick win', 'Steady', 'Heavy lift'],
      ['Filler', 'Low value', 'Money pit'],
    ])
  })
  test('unset return or effort gives no verdict', () => {
    expect(payoffOf({ impact: null, effort: null })).toBeNull()
    expect(payoffOf({ impact: 'high', effort: null })).toBeNull()
    expect(payoffOf({ impact: null, effort: 'low' })).toBeNull()
  })
  test('partial answers read as plain words', () => {
    expect(partialOf({ impact: 'high', effort: null })).toBe('High return')
    expect(partialOf({ impact: null, effort: 'medium' })).toBe('Medium effort')
    expect(partialOf({ impact: 'low', effort: 'low' })).toBeNull()
    expect(partialOf({ impact: null, effort: null })).toBeNull()
  })
  test('tooltip leaves out what is unset', () => {
    expect(payoffTip({ impact: 'high', effort: 'low', estimate_min: 120 })).toBe('Return high · Effort low · ~2h')
    expect(payoffTip({ impact: 'high', effort: null, estimate_min: null })).toBe('Return high')
    expect(payoffTip({ impact: null, effort: null, estimate_min: null })).toBe('')
  })
})

describe('face vocabulary', () => {
  test('only the words that change a decision show on the face', () => {
    const faceWords = (['high', 'medium', 'low'] as const).flatMap((i) => (['low', 'medium', 'high'] as const).map((e) => payoffOf({ impact: i, effort: e }))).filter((p) => p?.face).map((p) => p!.label)
    expect([...new Set(faceWords)].sort()).toEqual(['Big bet', 'Heavy lift', 'Money pit', 'Quick win', 'Worth it'])
    expect(payoffOf({ impact: 'medium', effort: 'medium' })?.face).toBe(false)
    expect(payoffOf({ impact: 'low', effort: 'low' })?.face).toBe(false)
  })
  test('peek sentence', () => {
    expect(payoffSentence({ impact: 'high', effort: 'low' })).toBe('Return high · Effort low → Quick win')
    expect(payoffSentence({ impact: 'high', effort: null })).toBe('Return high')
    expect(payoffSentence({ impact: null, effort: null })).toBe('')
  })
})

describe('rail', () => {
  const now = 10 * 86400000
  const base = { urgent: false, blocked_on: null, blocked_at: null, state: 'todo' as const }
  test('urgent, blocked, both, none', () => {
    expect(railOf(base)).toBeNull()
    expect(railOf({ ...base, urgent: true })).toBe('urgent')
    expect(railOf({ ...base, blocked_on: 'IT' })).toBe('blocked')
    expect(railOf({ ...base, urgent: true, blocked_on: 'IT' })).toBe('both')
  })
  test('done and dropped cards carry no rail', () => {
    expect(railOf({ ...base, urgent: true, state: 'done' })).toBeNull()
    expect(railOf({ ...base, blocked_on: 'IT', state: 'dropped' })).toBeNull()
  })
  test('tooltip names the blocker and how long', () => {
    expect(railTip({ ...base, blocked_on: 'IT: NetSuite access', blocked_at: now - 2 * 86400000 }, now)).toEqual(['Blocked on IT: NetSuite access · 2d'])
    expect(railTip({ ...base, urgent: true, blocked_on: 'IT' }, now)).toEqual(['Urgent', 'Blocked on IT'])
    expect(railTip(base, now)).toEqual([])
  })
})

describe('people and categories', () => {
  test('initials', () => {
    expect(initials('james')).toBe('JA')
    expect(initials('ux-lead')).toBe('UL')
    expect(initials('a')).toBe('A')
    expect(initials('--')).toBe('?')
  })
  test('avatars are one neutral tone', () => {
    expect(AVATAR_TONE).toMatch(/zinc/)
  })
  test('category dots line up with the chip palette', () => {
    expect(CATEGORY_DOTS.length).toBe(CATEGORY_PALETTE.length)
    CATEGORY_DOTS.forEach((d, i) => expect(CATEGORY_PALETTE[i].split(' ')[0].replace('-100', '').replace('-200', '')).toBe(d.replace('-500', '')))
    expect(categoryDot('UI')).toBe(categoryDot(' ui '))
  })
  test('assignee tooltip', () => {
    expect(assigneeTip({ handle: 'james', kind: 'claude' as never, state: 'working' })).toBe('@james · working')
    expect(assigneeTip({ handle: 'me', kind: 'human', state: 'idle' })).toBe('@me (you)')
  })
})
