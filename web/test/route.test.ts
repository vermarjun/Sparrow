import { describe, expect, test } from 'bun:test'
import { captainHref, href, parseRoute } from '../src/lib/route'

describe('routes (§7.1)', () => {
  test('empty hash and #/captains are the project home', () => {
    expect(parseRoute('')).toMatchObject({ page: 'captains', redirected: false, project: null })
    expect(parseRoute('#/captains?p=plutus')).toMatchObject({ page: 'captains', project: 'plutus' })
  })
  test('captain page with tab and agent', () => {
    expect(parseRoute('#/captain/ag_orion?tab=team&agent=ag_zoe&p=plutus')).toMatchObject({
      page: 'captain', captain: 'ag_orion', tab: 'team', agent: 'ag_zoe', project: 'plutus',
    })
    expect(parseRoute('#/captain/ag_orion?tab=bogus').tab).toBe('activity')
    expect(parseRoute('#/captain').page).toBe('captains')
  })
  test('old #/chat and #/agents redirect to captains, keeping ?p', () => {
    expect(parseRoute('#/chat?p=plutus')).toMatchObject({ page: 'captains', redirected: true, project: 'plutus' })
    expect(parseRoute('#/agents')).toMatchObject({ page: 'captains', redirected: true })
  })
  test('existing pages keep working', () => {
    expect(parseRoute('#/board?p=x').page).toBe('board')
    expect(parseRoute('#/resumes/builder')).toMatchObject({ page: 'resumes', slug: 'builder' })
    expect(parseRoute('#/skills/my%20skill').slug).toBe('my skill')
    expect(parseRoute('#/doctor').page).toBe('doctor')
    expect(parseRoute('#/settings').page).toBe('settings')
  })
  test('href round-trips', () => {
    expect(captainHref('ag_orion', 'plutus')).toBe('#/captain/ag_orion?p=plutus')
    expect(captainHref('ag_orion', 'plutus', { tab: 'team', agent: 'ag_zoe' })).toBe('#/captain/ag_orion?tab=team&agent=ag_zoe&p=plutus')
    expect(href({ page: 'board', project: 'plutus' })).toBe('#/board?p=plutus')
    expect(href({ page: 'resumes', slug: 'builder' })).toBe('#/resumes/builder')
    const r = parseRoute(captainHref('ag_x', 'p', { tab: 'cards' }))
    expect(r).toMatchObject({ page: 'captain', captain: 'ag_x', tab: 'cards', project: 'p' })
  })
})
