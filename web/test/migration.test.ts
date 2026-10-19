import { describe, expect, test } from 'bun:test'
import {
  KEEP_AS_CONFLICT, alreadyManaged, choicesFor, harnessList, initialSelection, isKept, offerMigration, typedOk, viewPlan,
  type MigDecision, type MigPlan, type MigVariant,
} from '../src/lib/migration'

const v = (name: string, root: MigVariant['root'], hash: string, mtime = 1, resolved?: string): MigVariant => ({
  name, root, path: `/h/.${root}/skills/${name}`, resolvedPath: resolved ?? `/h/.${root}/skills/${name}`, hash, mtime, files: 2,
  kind: 'dir', linkTarget: null, harnesses: ['claude'],
})
/** Same-bytes decision: `defaultPath` is just the first copy. */
const dec = (name: string, variants: MigVariant[], over: Partial<MigDecision> = {}): MigDecision => ({
  name, variants, needsChoice: false, defaultPath: variants[0]!.path, defaultHash: variants[0]!.hash,
  harnesses: ['claude'], ...over,
})
/** Differing copies, as the server reports them: no default winner. */
const differing = (name: string, variants: MigVariant[]): MigDecision => dec(name, variants, { needsChoice: true, defaultPath: null, defaultHash: null })
const plan = (decisions: MigDecision[], over: Partial<MigPlan> = {}): MigPlan => ({
  home: '/h', library: '/h/Skills', candidates: decisions.flatMap((d) => d.variants), skipped: [], protectedVariants: [], decisions,
  defaultChoices: {}, warnings: [], plan_id: 'x', backup_root: '/h/.sparrow/skills-backup',
  summary: { toLibrary: decisions.length, needsChoice: [], entries: 0, linksFlattened: 0, skipped: {} }, ...over,
})

const plain = dec('plain', [v('plain', 'claude', 'a')])
const variant = differing('variant', [v('variant', 'claude', 'old', 1), v('variant', 'codex', 'new', 2)])
const ext = dec('aws', [v('aws', 'claude', 'e'), v('aws', 'agents', 'e')], { harnesses: ['claude', 'codex', 'opencode'] })
const managed = dec('done', [v('done', 'claude', 'm', 1, '/h/Skills/done')])

describe('explicit choice, default keep-as-conflict', () => {
  test('every skill with differing copies starts as "keep as conflict"; nothing is preselected as a winner', () => {
    const p = plan([plain, variant, ext])
    expect(initialSelection(p)).toEqual({ variant: KEEP_AS_CONFLICT })
    expect(isKept(variant, initialSelection(p))).toBe(true)
    expect(isKept(plain, initialSelection(p))).toBe(false)
    // the default sends no choice at all, so the server keeps every copy where it is
    expect(choicesFor(p, initialSelection(p))).toEqual({})
  })
  test('picking a copy sends that path; picking keep-as-conflict again removes it; stale or foreign picks are ignored', () => {
    const p = plan([plain, variant])
    const [a, b] = variant.variants
    expect(choicesFor(p, { variant: a!.path })).toEqual({ variant: a!.path })
    expect(choicesFor(p, { variant: b!.path })).toEqual({ variant: b!.path })
    expect(choicesFor(p, { variant: KEEP_AS_CONFLICT })).toEqual({})
    expect(choicesFor(p, { variant: '/etc' })).toEqual({})
    expect(choicesFor(p, { plain: plain.variants[0]!.path })).toEqual({})
  })
})

describe('viewPlan', () => {
  test('groups by action; a kept skill is in the conflict group, not in the copy group', () => {
    const p = plan([plain, variant, ext, managed], { skipped: [{ path: '/h/.claude/skills/x', reason: 'dangling symlink; leave untouched' }] })
    const view = viewPlan(p, initialSelection(p))
    // the library is the single copy: a skill that also sits in ~/.agents/skills is copied like any other
    expect(view.copy.map((r) => r.name)).toEqual(['plain', 'aws'])
    expect(view.conflict.map((r) => r.name)).toEqual(['variant'])
    expect(view.conflict[0]!.chosen).toBeNull()
    expect(view.managed).toBe(1)
    expect(view.total).toBe(4 - 1)
    expect(view.skipped).toHaveLength(1)
    expect(alreadyManaged(managed, p)).toBe(true)
  })
  test('choosing a copy moves the skill to the copy group with that copy as the source of every link', () => {
    const p = plan([variant])
    const view = viewPlan(p, { variant: variant.variants[1]!.path })
    expect(view.conflict).toEqual([])
    expect(view.copy.map((r) => r.name)).toEqual(['variant'])
    expect(view.copy[0]!.chosen!.root).toBe('codex')
    expect(view.copy[0]!.replaces.map((x) => x.root)).toEqual(['claude', 'codex'])
  })
})

describe('misc', () => {
  test('typed confirmation is exact (trimmed, case-sensitive)', () => {
    expect(typedOk(' migrate ', 'migrate')).toBe(true)
    expect(typedOk('Migrate', 'migrate')).toBe(false)
    expect(typedOk('', 'rollback')).toBe(false)
  })
  test('offerMigration: unmanaged, conflicts, or an empty library', () => {
    const lock = { locked: true }, own = { locked: false }
    expect(offerMigration(null)).toBe(false)
    expect(offerMigration({ unmanaged: [1], conflicts: [], library: [own] })).toBe(true)
    expect(offerMigration({ unmanaged: [], conflicts: [1], library: [own] })).toBe(true)
    expect(offerMigration({ unmanaged: [], conflicts: [], library: [lock, lock] })).toBe(true)
    expect(offerMigration({ unmanaged: [], conflicts: [], library: [lock, own] })).toBe(false)
  })
  test('harnessList', () => {
    expect(harnessList(['claude', 'opencode'])).toBe('Claude · OpenCode')
    expect(harnessList([])).toBe('no harness')
  })
})
