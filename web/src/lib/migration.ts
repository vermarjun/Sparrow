// Migration wizard: API types + pure helpers (unit-tested in web/test/migration.test.ts).
export type MigRoot = 'claude' | 'codex' | 'opencode' | 'agents' | 'desktop' | 'claude-synced'

export type MigHarness = 'claude' | 'codex' | 'opencode'
export interface MigVariant {
  name: string; root: MigRoot; path: string; resolvedPath: string; hash: string; mtime: number; files: number
  /** `link`: a symlink (outside HOME, into another folder, into ~/.agents/skills): its content is copied, the link replaced. */
  kind: 'dir' | 'link'
  linkTarget: string | null
  harnesses: MigHarness[]
}
export interface MigDecision {
  name: string
  variants: MigVariant[]
  /** Differing copies: the user must choose; there is no default winner (`defaultPath` is null). */
  needsChoice: boolean
  defaultPath: string | null
  defaultHash: string | null
  /** The harness toggles the skill gets: where it is visible today. */
  harnesses: MigHarness[]
}
export interface MigPlan {
  home: string
  library: string
  candidates: MigVariant[]
  skipped: { path: string; reason: string; code?: string }[]
  protectedVariants: MigVariant[]
  decisions: MigDecision[]
  defaultChoices: Record<string, string>
  /** Aliased harness folders (one is a symlink to another) and similar notes. */
  warnings: string[]
  plan_id: string
  backup_root: string
  summary: { toLibrary: number; needsChoice: string[]; entries: number; linksFlattened: number; skipped: Record<string, number> }
}
export interface MigBackup { id: string; path: string; sha256: string; size: number }
export interface MigBackupInfo extends MigBackup { created: number; members: number; moved: number; library_existed: boolean; rolled_back_at: number | null }
export interface MigApplyResult {
  backup: MigBackup
  applied: string[]
  selected: Record<string, string>
  kept_as_conflict: { name: string; paths: string[] }[]
  skipped: { path: string; reason: string }[]
  conflicts_left: { name: string; root: string; path: string; conflict: 'identical' | 'diff' | null }[]
  /** Toggle links that could not be made (something else is already there). */
  link_conflicts: { root: string; name: string; path: string; reason?: string }[]
}
export interface MigRollbackResult {
  /** Put back and verified. */
  restored: string[]
  /** Everything that was not put back, with the reason. */
  notRestored: { path: string; reason: string }[]
  libraryRestored: boolean
  libraryNote: string | null
  addedSkills: string[]
  preservedAt: string | null
  removedLinks: string[]
  removedDirs: string[]
  backup_id: string
}

/** The explicit choice per name with differing copies: a copy's path, or KEEP_AS_CONFLICT (the default; nothing is picked for you). */
export const KEEP_AS_CONFLICT = 'conflict'
export type Selection = Record<string, string>

export const MIGRATE_WORD = 'migrate'
export const ROLLBACK_WORD = 'rollback'
export const typedOk = (typed: string, word: string) => typed.trim() === word

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

export const distinctHashes = (d: MigDecision) => new Set(d.variants.map((v) => v.hash)).size
export const needsChoice = (d: MigDecision) => d.needsChoice

/** Every variant already resolves into the library: an earlier migration or adopt linked it. */
export const alreadyManaged = (d: MigDecision, plan: Pick<MigPlan, 'library'>) =>
  d.variants.every((v) => inside(v.resolvedPath, plan.library))

/** Every skill with differing copies starts as "keep as conflict": no copy is preselected. */
export function initialSelection(plan: MigPlan): Selection {
  return Object.fromEntries(plan.decisions.filter(needsChoice).map((d) => [d.name, KEEP_AS_CONFLICT]))
}

export const isKept = (d: MigDecision, sel: Selection) => needsChoice(d) && (sel[d.name] ?? KEEP_AS_CONFLICT) === KEEP_AS_CONFLICT

/** The `choices` body: only names where the user picked a copy. Absent = kept as conflict, nothing touched. */
export function choicesFor(plan: MigPlan, sel: Selection): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of plan.decisions) {
    const pick = sel[d.name]
    if (needsChoice(d) && pick && pick !== KEEP_AS_CONFLICT && d.variants.some((v) => v.path === pick)) out[d.name] = pick
  }
  return out
}

export interface PlanRow {
  name: string
  decision: MigDecision
  /** The copy that goes into the library (null while a differing skill is kept as conflict). */
  chosen: MigVariant | null
  /** Entries that become links. */
  replaces: MigVariant[]
}
export interface PlanView {
  copy: PlanRow[]
  /** Differing copies the user did not pick from: left exactly where they are. */
  conflict: PlanRow[]
  skipped: { path: string; reason: string; code?: string }[]
  managed: number
  protectedCount: number
  total: number
}

export function viewPlan(plan: MigPlan, sel: Selection): PlanView {
  const view: PlanView = { copy: [], conflict: [], skipped: plan.skipped, managed: 0, protectedCount: plan.protectedVariants.length, total: 0 }
  for (const d of plan.decisions) {
    if (alreadyManaged(d, plan)) { view.managed++; continue }
    view.total++
    if (isKept(d, sel)) { view.conflict.push({ name: d.name, decision: d, chosen: null, replaces: [] }); continue }
    const chosen = d.variants.find((v) => v.path === (needsChoice(d) ? sel[d.name] : d.defaultPath)) ?? d.variants[0]!
    const row: PlanRow = { name: d.name, decision: d, chosen, replaces: d.variants }
    view.copy.push(row)
  }
  return view
}

/** The wizard is offered when something is unmanaged, in conflict, or the library holds no skills of its own yet. */
export function offerMigration(s: { unmanaged: unknown[]; conflicts: unknown[]; library: { locked: boolean }[] } | null): boolean {
  if (!s) return false
  return s.unmanaged.length > 0 || s.conflicts.length > 0 || s.library.every((x) => x.locked)
}

export function harnessList(harnesses: string[]): string {
  const name: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
  return harnesses.length ? harnesses.map((h) => name[h] ?? h).join(' · ') : 'no harness'
}
