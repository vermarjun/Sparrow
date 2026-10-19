// Skills page: API types (mirror of ../src/skills/types.ts) + pure helpers (unit-tested in web/test/skills.test.ts).
export type Harness = 'claude' | 'codex' | 'opencode'
export type SkillRoot = 'library' | Harness | 'agents' | 'claude-synced' | 'sparrow'
export type SkillStatus = 'managed' | 'sparrow' | 'external' | 'unmanaged' | 'conflict' | 'broken'
export type LinkState = 'linked' | 'missing' | 'conflict' | 'broken' | 'off' | 'locked'

export interface SkillProblem { code: string; message: string }
export interface SkillFrontmatter { name?: string; description?: string; values: Record<string, unknown> }

export interface SkillEntry {
  root: SkillRoot
  name: string
  path: string
  kind: 'dir' | 'link'
  linkTarget: string | null
  resolvedTarget: string | null
  folderHash: string | null
  frontmatter: SkillFrontmatter | null
  problems: SkillProblem[]
  readers: Harness[]
  status: SkillStatus
  conflict: 'identical' | 'diff' | null
}

export interface HarnessLink {
  harness: Harness
  wanted: boolean
  state: LinkState
  path: string
  alsoReadBy: Harness[]
  viaRoot: Harness | null
}

export interface LibrarySkill {
  name: string
  description: string | null
  path: string
  locked: boolean
  source: 'local' | 'github' | 'sparrow'
  sourceUrl: string | null
  inManifest: boolean
  harnesses: Harness[]
  links: HarnessLink[]
  problems: SkillProblem[]
}

export interface GitState {
  available: boolean
  branch: string | null
  dirty: string[]
  ahead: number | null
  behind: number | null
  remote: string | null
  error?: string
}

export interface SkillsState {
  library_missing: boolean
  /** Why the configured library location is refused (it overlaps a harness folder or a migration source), or null. */
  library_problem: string | null
  library: LibrarySkill[]
  unmanaged: SkillEntry[]
  external: SkillEntry[]
  conflicts: SkillEntry[]
  broken: SkillEntry[]
  git: GitState
  paths: { library: string; home: string; backup: string; roots: Record<SkillRoot, string>; sandbox: boolean }
  warnings: string[]
}

export interface FileNode { name: string; path: string; type: 'file' | 'dir' | 'link'; size?: number; children?: FileNode[] }
export interface GitCommit { hash: string; shortHash: string; author: string; date: string; subject: string }
export interface LinkAction { type: 'create' | 'repair' | 'remove-own-link' | 'conflict'; root: Harness; name: string; path: string; reason?: string }

export interface SkillDetail {
  skill: LibrarySkill
  skill_md: string
  files: FileNode[]
  log: GitCommit[]
  entries: SkillEntry[]
}

export interface MigrationPlanLite { decisions: { name: string }[]; candidates: unknown[]; skipped: { path: string; reason: string }[] }

export interface StagedSkill {
  name: string
  description: string
  problems: SkillProblem[]
  /** Importable but worth a look (e.g. the folder name differs from the skill name). */
  warnings?: string[]
  files: { path: string; size: number }[]
  scripts: string[]
  scriptDetails: { path: string; executable: boolean; shebang: string | null; scriptsDirectory: boolean }[]
}

export function executionWarning(skill: Pick<StagedSkill, 'scriptDetails'>) {
  const files = skill.scriptDetails.map((script) => ({
    path: script.path,
    reasons: [
      ...(script.executable ? ['executable'] : []),
      ...(script.scriptsDirectory ? ['under scripts/'] : []),
      ...(script.shebang ? [`shebang ${script.shebang}`] : []),
    ],
  }))
  if (!files.length) return null
  const noun = files.length === 1 ? 'file' : 'files'
  return {
    files,
    message: `${files.length} ${noun} can run code on your machine when an agent uses this skill. Sparrow never runs them; read them before importing.`,
  }
}

/** What the Add dialog holds before anything is typed or staged. A staged import is consumed by importing, so none survives a close/open. */
export function freshAddState() {
  return {
    mode: 'create' as 'create' | 'upload' | 'link',
    name: '',
    description: '',
    source: '',
    harnesses: [...HARNESS_ORDER] as Harness[],
    staged: null as StagedImport | null,
    selected: [] as string[],
    error: null as string | null,
  }
}

/** The server forgot a staged import (consumed by an import, or older than its 30 min): preview again. */
export const stagedGone = (message: string) => /staged import has expired|does not exist/i.test(message)

export interface StagedImport {
  id: string
  skills: StagedSkill[]
  source?: { source: string; sourceType: 'github' | 'gitlab' | 'git' | 'local'; sourceUrl: string; ref?: string; subpath?: string; skillFilter?: string }
  problems?: SkillProblem[]
  notices?: string[]
}

export interface SkillUpdate { name: string; current: string | null; latest: string | null; available: boolean; error?: string }

// ---------------------------------------------------------------- routes

export type SkillsView = 'library' | 'matrix' | 'unmanaged' | 'external' | 'conflicts'

export const skillsHref = (name?: string | null) => (name ? `#/skills/${encodeURIComponent(name)}` : '#/skills')

// ---------------------------------------------------------------- labels

export const HARNESS_ORDER: Harness[] = ['claude', 'codex', 'opencode']
export const HARNESS_NAME: Record<Harness, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }

export const ROOT_LABEL: Record<SkillRoot, string> = {
  library: 'library',
  claude: '~/.claude/skills',
  codex: '~/.codex/skills',
  opencode: '~/.config/opencode/skills',
  agents: '~/.agents/skills',
  'claude-synced': '~/.claude/skills/synced',
  sparrow: 'built into Sparrow',
}

/** Where an entry comes from, in words (External rows). */
export function originLabel(e: Pick<SkillEntry, 'root' | 'kind' | 'linkTarget'>): string {
  if (e.root === 'agents') return 'Installed by npx skills / other tools'
  if (e.root === 'claude-synced') return 'Synced from claude.ai'
  if (e.kind === 'link') return `Link to ${e.linkTarget ?? 'another tool'}`
  return `Folder in ${ROOT_LABEL[e.root]}`
}

/** `/Users/me/x` → `~/x` when the path is inside `home`. */
export function tilde(path: string, home: string): string {
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// ---------------------------------------------------------------- chips (light + dark tones; no hard-coded light-only colors)

export const TONE = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  bad: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  none: 'border-border bg-muted text-muted-foreground',
} as const
export type Tone = keyof typeof TONE

export interface Chip { label: string; tone: Tone; title: string }

/** The status chip for one harness cell; `null` = nothing to say (off and not wanted). */
export function chipFor(link: HarnessLink): Chip | null {
  const h = HARNESS_NAME[link.harness]
  switch (link.state) {
    case 'linked':
      return link.wanted
        ? { label: 'linked', tone: 'ok', title: `${h} reads this skill through a link to the library` }
        : { label: 'stale link', tone: 'warn', title: `Linked in ${h}'s folder but switched off: sync removes the link` }
    case 'missing':
      return { label: 'missing link', tone: 'warn', title: `Switched on for ${h} but there is no link yet: use Sync links` }
    case 'conflict':
      return { label: 'conflict', tone: 'bad', title: `A real folder or someone else's link is in the way in ${h}'s skills folder` }
    case 'broken':
      return { label: 'broken', tone: 'bad', title: `The link in ${h}'s skills folder points nowhere` }
    case 'locked':
      return { label: 'locked', tone: 'none', title: 'Built into Sparrow: always on for every agent' }
    default:
      return link.viaRoot
        ? { label: `via ${HARNESS_NAME[link.viaRoot]}`, tone: 'none', title: `${h} also reads ~/.claude/skills, so it sees this skill through the Claude link` }
        : null
  }
}

/** Caption for the Claude cell: OpenCode reads the Claude folder too. */
export function alsoReadNote(link: HarnessLink): string | null {
  if (!link.alsoReadBy.length) return null
  const who = link.alsoReadBy.map((h) => HARNESS_NAME[h]).join(', ')
  return `also read by ${who} via ${ROOT_LABEL[link.harness]}`
}

/** The harness set after clicking one toggle. */
export function toggled(wanted: Harness[], harness: Harness): Harness[] {
  return HARNESS_ORDER.filter((h) => (h === harness ? !wanted.includes(h) : wanted.includes(h)))
}

// ---------------------------------------------------------------- git bar

export interface GitAction { disabled: boolean; reason: string | null }

export function gitActions(git: GitState | null | undefined): { pull: GitAction; commit: GitAction } {
  if (!git || !git.available) {
    const reason = git?.error ?? 'The library is not a git repository'
    return { pull: { disabled: true, reason }, commit: { disabled: true, reason } }
  }
  const pull: GitAction = !git.remote
    ? { disabled: true, reason: 'No origin remote: add one with git remote add origin <url> in the library' }
    : git.dirty.length
      ? { disabled: true, reason: 'Commit or discard local changes before pulling' }
      : { disabled: false, reason: null }
  const commit: GitAction = !git.remote
    ? { disabled: true, reason: 'No origin remote to push to: add one with git remote add origin <url> in the library' }
    : !git.dirty.length && !(git.ahead ?? 0)
      ? { disabled: true, reason: 'Nothing to commit or push' }
      : { disabled: false, reason: null }
  return { pull, commit }
}

export function gitSummary(git: GitState): string[] {
  const out: string[] = []
  if (git.branch) out.push(git.branch)
  out.push(git.dirty.length ? `${git.dirty.length} changed` : 'clean')
  if (git.ahead) out.push(`${git.ahead} unpushed`)
  if (git.behind) out.push(`${git.behind} behind`)
  if (!git.remote) out.push('no remote')
  return out
}

// ---------------------------------------------------------------- library list

export function filterSkills(skills: LibrarySkill[], query: string): LibrarySkill[] {
  const q = query.trim().toLowerCase()
  if (!q) return skills
  return skills.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
}

export function viewCounts(s: SkillsState | null): { unmanaged: number; external: number; conflicts: number } {
  return {
    unmanaged: s?.unmanaged.length ?? 0,
    external: s?.external.length ?? 0,
    // Broken links share the Conflicts tab ("needs attention").
    conflicts: (s?.conflicts.length ?? 0) + (s?.broken.length ?? 0),
  }
}

// ---------------------------------------------------------------- SKILL.md

/** Splits the YAML frontmatter off a SKILL.md so only the body is rendered. */
export function splitFrontmatter(text: string): { front: string | null; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return { front: null, body: text }
  return { front: m[1], body: text.slice(m[0].length).replace(/^\s*\n/, '') }
}

export function flattenTree(nodes: FileNode[], depth = 0): { node: FileNode; depth: number }[] {
  return nodes.flatMap((n) => [{ node: n, depth }, ...(n.children ? flattenTree(n.children, depth + 1) : [])])
}

export function fileSize(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------- unified diff

export interface DiffLine { kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string }
export interface DiffFile { path: string; note: string | null; lines: DiffLine[] }

/** Parses `git diff --no-index` output; `name` trims the absolute folder prefix off each path. */
export function parseDiff(text: string, name: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let inHunk = false
  const rel = (p: string) => {
    const bare = p.replace(/^[ab]\//, '')
    const i = bare.lastIndexOf(`/${name}/`)
    return i >= 0 ? bare.slice(i + name.length + 2) : bare
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (\S+) (\S+)$/)
      cur = { path: m ? rel(m[2]) : line.slice(11), note: null, lines: [] }
      files.push(cur)
      inHunk = false
    } else if (!cur) continue
    else if (line.startsWith('Binary files ')) cur.lines.push({ kind: 'ctx', text: line })
    else if (!inHunk && line.startsWith('new file mode')) cur.note = 'only in this copy'
    else if (!inHunk && line.startsWith('deleted file mode')) cur.note = 'only in the library'
    else if (!inHunk && (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity'))) continue
    else if (line.startsWith('@@')) { inHunk = true; cur.lines.push({ kind: 'hunk', text: line }) }
    else if (inHunk && line.startsWith('+')) cur.lines.push({ kind: 'add', text: line.slice(1) })
    else if (inHunk && line.startsWith('-')) cur.lines.push({ kind: 'del', text: line.slice(1) })
    else if (inHunk && (line.startsWith(' ') || line === '')) cur.lines.push({ kind: 'ctx', text: line.slice(1) })
  }
  for (const f of files) while (f.lines.length && f.lines[f.lines.length - 1].kind === 'ctx' && f.lines[f.lines.length - 1].text === '') f.lines.pop()
  return files
}

export function diffStat(files: DiffFile[]): { files: number; added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const f of files) for (const l of f.lines) { if (l.kind === 'add') added++; else if (l.kind === 'del') removed++ }
  return { files: files.length, added, removed }
}
