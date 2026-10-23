import { describe, expect, test } from 'bun:test'
import {
  alsoReadNote, chipFor, diffStat, executionWarning, filterSkills, fileSize, flattenTree, freshAddState, gitActions, gitSummary, originLabel, parseDiff,
  skillsHref, splitFrontmatter, stagedGone, tilde, toggled, viewCounts,
  type GitState, type HarnessLink, type LibrarySkill, type SkillsState,
} from '../src/lib/skills'

const link = (over: Partial<HarnessLink> = {}): HarnessLink => ({ harness: 'claude', wanted: true, state: 'linked', path: '/h/.claude/skills/x', alsoReadBy: [], viaRoot: null, ...over })
const skill = (name: string, description: string | null = null): LibrarySkill => ({
  name, description, path: `/lib/${name}`, locked: false, source: 'local', sourceUrl: null, inManifest: true, harnesses: [], links: [], problems: [],
})
const git = (over: Partial<GitState> = {}): GitState => ({ available: true, branch: 'main', dirty: [], ahead: 0, behind: 0, remote: '/r.git', ...over })

describe('chips', () => {
  test('one chip per state, with tone', () => {
    expect(chipFor(link())).toMatchObject({ label: 'linked', tone: 'ok' })
    expect(chipFor(link({ state: 'missing' }))).toMatchObject({ label: 'missing link', tone: 'warn' })
    expect(chipFor(link({ state: 'conflict' }))).toMatchObject({ label: 'conflict', tone: 'bad' })
    expect(chipFor(link({ state: 'broken' }))).toMatchObject({ label: 'broken', tone: 'bad' })
    expect(chipFor(link({ state: 'locked' }))).toMatchObject({ label: 'locked', tone: 'none' })
    expect(chipFor(link({ state: 'linked', wanted: false }))).toMatchObject({ label: 'stale link', tone: 'warn' })
  })
  test('off shows nothing, unless OpenCode sees the skill through the Claude folder', () => {
    expect(chipFor(link({ harness: 'codex', state: 'off', wanted: false }))).toBeNull()
    expect(chipFor(link({ harness: 'opencode', state: 'off', wanted: false, viaRoot: 'claude' }))).toMatchObject({ label: 'via Claude' })
  })
  test('claude cell notes that OpenCode reads the folder too', () => {
    expect(alsoReadNote(link({ alsoReadBy: ['opencode'] }))).toBe('also read by OpenCode via ~/.claude/skills')
    expect(alsoReadNote(link())).toBeNull()
  })
})

describe('toggled', () => {
  test('flips one harness and keeps canonical order', () => {
    expect(toggled(['codex'], 'claude')).toEqual(['claude', 'codex'])
    expect(toggled(['claude', 'opencode'], 'claude')).toEqual(['opencode'])
    expect(toggled([], 'opencode')).toEqual(['opencode'])
  })
})

describe('gitActions', () => {
  test('no remote disables both with a reason', () => {
    const a = gitActions(git({ remote: null, dirty: ['a/'] }))
    expect(a.commit.disabled).toBe(true)
    expect(a.commit.reason).toContain('No origin remote')
    expect(a.pull.disabled).toBe(true)
  })
  test('dirty blocks pull, enables commit; clean+unpushed enables commit; clean+synced disables it', () => {
    expect(gitActions(git({ dirty: ['a/'] }))).toMatchObject({ pull: { disabled: true }, commit: { disabled: false } })
    expect(gitActions(git({ ahead: 2 }))).toMatchObject({ pull: { disabled: false }, commit: { disabled: false } })
    expect(gitActions(git())).toMatchObject({ pull: { disabled: false }, commit: { disabled: true, reason: 'Nothing to commit or push' } })
  })
  test('unavailable repository', () => {
    expect(gitActions(git({ available: false, error: 'library missing' })).commit).toEqual({ disabled: true, reason: 'library missing' })
    expect(gitActions(null).pull.disabled).toBe(true)
  })
  test('summary', () => {
    expect(gitSummary(git({ dirty: ['a', 'b'], ahead: 1 }))).toEqual(['main', '2 changed', '1 unpushed'])
    expect(gitSummary(git({ remote: null, behind: 3 }))).toEqual(['main', 'clean', '3 behind', 'no remote'])
  })
})

describe('lists', () => {
  test('filterSkills matches name and description, case-insensitively', () => {
    const list = [skill('react-best-practices', 'Vercel React rules'), skill('release-notes', 'Release orchestrator')]
    expect(filterSkills(list, 'REACT').map((s) => s.name)).toEqual(['react-best-practices'])
    expect(filterSkills(list, 'orchestr').map((s) => s.name)).toEqual(['release-notes'])
    expect(filterSkills(list, '  ')).toBe(list)
  })
  test('viewCounts folds broken links into Conflicts and tolerates no state', () => {
    expect(viewCounts(null)).toEqual({ unmanaged: 0, external: 0, conflicts: 0 })
    const s = { unmanaged: [1, 2], external: [1], conflicts: [1], broken: [1, 2] } as unknown as SkillsState
    expect(viewCounts(s)).toEqual({ unmanaged: 2, external: 1, conflicts: 3 })
  })
  test('routes and labels', () => {
    expect(skillsHref()).toBe('#/skills')
    expect(skillsHref('a b')).toBe('#/skills/a%20b')
    expect(originLabel({ root: 'agents', kind: 'dir', linkTarget: null })).toContain('npx skills')
    expect(originLabel({ root: 'claude-synced', kind: 'dir', linkTarget: null })).toContain('claude.ai')
    expect(originLabel({ root: 'claude', kind: 'link', linkTarget: '/opt/homebrew/x' })).toBe('Link to /opt/homebrew/x')
    expect(tilde('/home/demo/Skills/a', '/home/demo')).toBe('~/Skills/a')
    expect(tilde('/home/demox/a', '/home/demo')).toBe('/home/demox/a')
    expect(tilde('/home/demo', '/home/demo')).toBe('~')
  })
})

describe('SKILL.md and files', () => {
  test('splitFrontmatter separates the YAML block from the body', () => {
    expect(splitFrontmatter('---\nname: a\ndescription: b\n---\n\n# Title\ntext')).toEqual({ front: 'name: a\ndescription: b', body: '# Title\ntext' })
    expect(splitFrontmatter('# no front matter')).toEqual({ front: null, body: '# no front matter' })
    expect(splitFrontmatter('---\nname: a\n---').body).toBe('')
  })
  test('flattenTree is depth-first with depth; fileSize formats', () => {
    const tree = [{ name: 's', path: 's', type: 'dir' as const, children: [{ name: 'r.sh', path: 's/r.sh', type: 'file' as const, size: 10 }] }, { name: 'SKILL.md', path: 'SKILL.md', type: 'file' as const }]
    expect(flattenTree(tree).map((x) => `${x.depth}:${x.node.path}`)).toEqual(['0:s', '1:s/r.sh', '0:SKILL.md'])
    expect(fileSize(10)).toBe('10 B')
    expect(fileSize(2048)).toBe('2.0 KB')
    expect(fileSize(20480)).toBe('20 KB')
    expect(fileSize(undefined)).toBe('')
  })
})

describe('import preview execution warning', () => {
  test('names every executable, scripts-directory, and shebang file with a prominent warning', () => {
    const warning = executionWarning({ scriptDetails: [
      { path: 'scripts/run.sh', executable: true, shebang: '#!/bin/sh', scriptsDirectory: true },
      { path: 'scripts/helper.js', executable: false, shebang: null, scriptsDirectory: true },
      { path: 'tools/deploy', executable: true, shebang: null, scriptsDirectory: false },
    ] });
    expect(warning?.message).toBe('3 files can run code on your machine when an agent uses this skill. Sparrow never runs them; read them before importing.');
    expect(warning?.files).toEqual([
      { path: 'scripts/run.sh', reasons: ['executable', 'under scripts/', 'shebang #!/bin/sh'] },
      { path: 'scripts/helper.js', reasons: ['under scripts/'] },
      { path: 'tools/deploy', reasons: ['executable'] },
    ]);
    expect(executionWarning({ scriptDetails: [] })).toBeNull();
  });
});

describe('parseDiff', () => {
  const text = [
    'diff --git a/home/demo/Skills/beta/SKILL.md b/home/demo/.codex/skills/beta/SKILL.md',
    'index 111..222 100644',
    '--- a/home/demo/Skills/beta/SKILL.md',
    '+++ b/home/demo/.codex/skills/beta/SKILL.md',
    '@@ -1,3 +1,3 @@',
    ' ---',
    '-name: beta',
    '+name: beta2',
    ' ---',
    'diff --git a/home/demo/Skills/beta/extra.md b/home/demo/.codex/skills/beta/extra.md',
    'new file mode 100644',
    'index 000..333',
    '--- /dev/null',
    '+++ b/home/demo/.codex/skills/beta/extra.md',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n')
  test('splits files, trims the folder prefix, classifies lines', () => {
    const files = parseDiff(text, 'beta')
    expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'extra.md'])
    expect(files[1].note).toBe('only in this copy')
    expect(files[0].lines.map((l) => l.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx'])
    expect(files[0].lines[2].text).toBe('name: beta')
    expect(files[1].lines.map((l) => l.kind)).toEqual(['hunk', 'add'])
    expect(diffStat(files)).toEqual({ files: 2, added: 2, removed: 1 })
  })
  test('empty or binary diffs', () => {
    expect(parseDiff('', 'beta')).toEqual([])
    const bin = parseDiff('diff --git a/x/beta/i.png b/y/beta/i.png\nBinary files a/x/beta/i.png and b/y/beta/i.png differ\n', 'beta')
    expect(bin[0].lines[0].text).toContain('Binary files')
  })
})

describe('Add dialog state', () => {
  test('a fresh state holds no staged import, so reopening after an import cannot reuse a consumed id', () => {
    const f = freshAddState()
    expect(f).toMatchObject({ mode: 'create', name: '', description: '', source: '', staged: null, selected: [], error: null })
    expect(f.harnesses).toEqual(['claude', 'codex', 'opencode'])
    f.harnesses.pop()
    expect(freshAddState().harnesses).toHaveLength(3) // every call is its own copy
  })
  test('stagedGone recognises the server answer for a consumed or expired staged import', () => {
    expect(stagedGone('Staged import has expired or does not exist: 2c31ebad-8b0a-4de1-91ea-b07cdb81f9d1')).toBe(true)
    expect(stagedGone('Skill "x" already exists in the library.')).toBe(false)
  })
})
