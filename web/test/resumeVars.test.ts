import { describe, expect, test } from 'bun:test'
import { renderResumeText } from '../src/lib/resumeVars'

// Same vectors as test/server/resume-vars.test.ts (the server renderer this mirrors).
describe('renderResumeText', () => {
  test('all variables', () => {
    expect(renderResumeText('{{harness}}|{{model}}|{{effort}}|{{runtime}}', { harness: 'claude', model: 'sonnet', effort: 'high' }))
      .toBe('claude|sonnet|high|claude · sonnet · effort high')
  })
  test('null model and effort fall back', () => {
    expect(renderResumeText('{{model}}/{{effort}} ({{runtime}})', { harness: 'codex', model: null, effort: null }))
      .toBe('harness default/default (codex · harness default · effort default)')
  })
  test('unknown variables are kept, whitespace inside braces allowed', () => {
    expect(renderResumeText('{{ harness }} {{nope}} {{constructor}}', { harness: 'opencode' })).toBe('opencode {{nope}} {{constructor}}')
  })
})
