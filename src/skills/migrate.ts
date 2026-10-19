import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync,
  rmdirSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ensureLibrary } from './git';
import { folderHash } from './hash';
import { readManifest, writeManifest } from './manifest';
import { apply as applyLinks, plan as planLinks } from './link';
import { assertLibrarySafe, assertWritable, realOrPlanned, rootAliasWarnings, skillPaths } from './paths';
import { validSkillName } from './frontmatter';
import { scanSkills } from './scan';
import type { Harness, LinkAction, SkillPaths } from './types';

export type MigrationRoot = Harness | 'desktop' | 'agents' | 'claude-synced';

/**
 * Which harnesses read a folder today. A migrated skill keeps this visibility as its toggles in skills.json, so on day one
 * a user's own sessions see the same skills as before. OpenCode reads ~/.claude/skills and ~/.agents/skills too; Codex
 * reads ~/.agents/skills; ~/Desktop/Skills is read by nobody.
 */
const VISIBLE_TO: Record<MigrationRoot, Harness[]> = {
  claude: ['claude', 'opencode'],
  codex: ['codex'],
  opencode: ['opencode'],
  agents: ['codex', 'opencode'],
  desktop: [],
  'claude-synced': ['claude'],
};
/** Source folders migration (and its rollback) may write to besides the normal fence. */
const MIGRATION_ROOTS = (paths: SkillPaths): string[] => [paths.roots.agents];
const HARNESS_ORDER: Harness[] = ['claude', 'codex', 'opencode'];
const LINKED_BACK: MigrationRoot[] = ['claude', 'codex', 'opencode', 'desktop'];

export interface MigrationVariant {
  name: string;
  root: MigrationRoot;
  path: string;
  resolvedPath: string;
  hash: string;
  mtime: number;
  files: number;
  /** `link`: the entry is a symlink; its content (resolvedPath) is copied and the link replaced. */
  kind: 'dir' | 'link';
  /** The raw link target, kept in the backup manifest. */
  linkTarget: string | null;
  /** Harnesses that read this entry today (its folder, and any folder that is the same folder): the toggles it earns. */
  harnesses: Harness[];
}

export type SkipCode = 'invalid-name' | 'sparrow' | 'container' | 'dangling' | 'in-library' | 'alias' | 'synced' | 'builtin';

export interface MigrationSkip {
  path: string;
  reason: string;
  code?: SkipCode;
}

export interface MigrationDecision {
  name: string;
  variants: MigrationVariant[];
  /**
   * Copies with differing bytes need the user's explicit choice: `needsChoice` is true and Sparrow never names a winner
   * (`defaultPath`/`defaultHash` are null, the name is absent from `defaultChoices`). Otherwise every variant has the
   * same bytes and `defaultPath` is just the first one, the copy the library is filled from.
   */
  needsChoice: boolean;
  defaultPath: string | null;
  defaultHash: string | null;
  /** The toggles the skill gets in skills.json: where it is visible today (see VISIBLE_TO). */
  harnesses: Harness[];
}

export interface MigrationPlan {
  home: string;
  library: string;
  candidates: MigrationVariant[];
  skipped: MigrationSkip[];
  protectedVariants: MigrationVariant[];
  decisions: MigrationDecision[];
  defaultChoices: Record<string, string>;
  warnings: string[];
}

export interface MovedEntry {
  path: string;
  root: MigrationRoot;
  name: string;
  kind: 'dir' | 'link';
  /** Raw link target of a moved link (a link outside HOME, into another folder, ...), noted for the record. */
  linkTarget: string | null;
  resolvedPath: string;
  hash: string;
  backupPath: string;
}

export interface BackupManifest {
  home: string;
  library: string;
  libraryExisted: boolean;
  librarySkillsBefore: string[];
  librarySkillsAfterMigration: string[];
  dir: string;
  tarPath: string;
  manifestPath: string;
  members: string[];
  /** Paths actually moved by apply; kept empty until each rename succeeds. */
  movedPaths: string[];
  /** One record per moved path (kind, original link target, hash, where the original now is in this backup). */
  moved: MovedEntry[];
  /** The path whose move was started but not recorded yet (a crash can leave it either in place or already in the backup). */
  inFlight: MovedEntry | null;
  /** Folders apply created for new harness links (nothing was there before); rollback removes them again if empty. */
  createdDirs: string[];
  size: number;
  sha256: string;
}

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function isSkillFolder(path: string): boolean {
  try { return lstatSync(path).isDirectory() && lstatSync(join(path, 'SKILL.md')).isFile(); }
  catch { return false; }
}

function countFiles(dir: string): number {
  let count = 0;
  const visit = (path: string) => {
    let children;
    try { children = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      const full = join(path, child.name);
      if (child.isDirectory() && child.name !== '.git' && child.name !== 'node_modules') visit(full);
      else if (child.isFile()) count++;
    }
  };
  visit(dir);
  return count;
}

function observedVariants(root: MigrationRoot, path: string, paths: SkillPaths, name = basename(path), harnesses: Harness[] = []): MigrationVariant | null {
  let resolvedPath: string;
  try { resolvedPath = realpathSync.native(path); } catch { return null; }
  if (!isSkillFolder(resolvedPath)) return null;
  const info = statSync(resolvedPath);
  let isLink = false;
  let linkTarget: string | null = null;
  try {
    isLink = lstatSync(path).isSymbolicLink();
    if (isLink) linkTarget = readlinkSync(path);
  } catch { /* vanished: the stale check at apply time reports it */ }
  return {
    name, root, path, resolvedPath, hash: folderHash(resolvedPath), mtime: info.mtimeMs, files: countFiles(resolvedPath),
    kind: isLink ? 'link' : 'dir', linkTarget, harnesses,
  };
}

/**
 * Everything a harness (or ~/.agents/skills, ~/Desktop/Skills) holds that is not a harness default or Sparrow's own is a
 * candidate, whether it is a real folder or a link (into another folder, or outside HOME): its content is copied into the
 * library. Skipped, and reported: Sparrow's skills, containers rewritten by another tool (`synced/`, `.system/`), links
 * already pointing into the library, links into those containers, and dangling links.
 */
function rootCandidates(root: MigrationRoot, base: string, paths: SkillPaths, skipped: MigrationSkip[], harnesses: Harness[]): MigrationVariant[] {
  let names: string[];
  try { names = readdirSync(base).sort((a, b) => a.localeCompare(b)); }
  catch { return []; }
  const library = realOrPlanned(paths.library);
  const synced = realOrPlanned(paths.roots['claude-synced']);
  const system = realOrPlanned(join(paths.roots.codex, '.system'));
  const out: MigrationVariant[] = [];
  for (const name of names) {
    const path = join(base, name);
    if (name === '.DS_Store' || name === '.trash') continue;
    if (name === 'synced' || name === '.system') {
      skipped.push({ path, code: 'container', reason: 'externally managed harness container; leave untouched' });
      continue;
    }
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    let resolved = path;
    if (stat.isSymbolicLink()) {
      try { resolved = realpathSync.native(path); }
      catch { skipped.push({ path, code: 'dangling', reason: `dangling symlink (${readlinkSync(path)}); leave untouched` }); continue; }
      if (!isSkillFolder(resolved)) continue;
      if (resolved === library || inside(library, resolved)) {
        skipped.push({ path, code: 'in-library', reason: 'link to the library itself; leave untouched' }); continue;
      }
      if (inside(resolved, library)) {
        skipped.push({
          path, code: 'in-library',
          reason: resolved === join(library, name) ? 'already a link to the library copy; leave untouched' : `link into another library skill (${readlinkSync(path)}); leave untouched`,
        });
        continue;
      }
      if (inside(resolved, synced)) { skipped.push({ path, code: 'synced', reason: 'link into claude.ai synced skills (rewritten by claude.ai; External, read-only); leave untouched' }); continue; }
      if (inside(resolved, system)) { skipped.push({ path, code: 'builtin', reason: 'link into Codex built-in skills; leave untouched' }); continue; }
    } else if (!stat.isDirectory() || !isSkillFolder(path)) continue;
    if (!validSkillName(name)) { skipped.push({ path, code: 'invalid-name', reason: `invalid skill name "${name}"; leave untouched` }); continue; }
    if (name.startsWith('sparrow-')) { skipped.push({ path, code: 'sparrow', reason: 'Sparrow-owned skill; leave untouched' }); continue; }
    const candidate = observedVariants(root, path, paths, name, harnesses);
    if (candidate) out.push(candidate);
  }
  return out;
}

function collectProtectedVariants(root: MigrationRoot, base: string, paths: SkillPaths): MigrationVariant[] {
  const out: MigrationVariant[] = [];
  let names: string[];
  try { names = readdirSync(base); } catch { return out; }
  const visit = (parent: string, depth: number) => {
    if (depth > 1) return;
    for (const name of names) {
      const path = join(parent, name);
      const variant = observedVariants(root, path, paths, name);
      if (variant) out.push(variant);
      else {
        let st;
        try { st = lstatSync(path); } catch { continue; }
        if (st.isDirectory()) {
          let children: string[];
          try { children = readdirSync(path); } catch { continue; }
          for (const child of children) {
            const nested = join(path, child);
            const skill = observedVariants(root, nested, paths, child);
            if (skill) out.push(skill);
          }
        }
      }
    }
  };
  visit(base, 0);
  return out;
}

export function planMigration(paths: SkillPaths = skillPaths()): MigrationPlan {
  assertLibrarySafe(paths);
  const skipped: MigrationSkip[] = [];
  // One folder is migrated once: a source that is the same folder as an earlier one (e.g. ~/.codex/skills ->
  // ~/.claude/skills) is skipped, and its harness toggles are folded into the first.
  const sources: [MigrationRoot, string][] = [
    ['claude', paths.roots.claude], ['codex', paths.roots.codex], ['opencode', paths.roots.opencode],
    ['agents', paths.roots.agents], ['desktop', paths.desktopSkills],
  ];
  const seen = new Map<string, MigrationRoot>();
  const aliases = new Map<MigrationRoot, MigrationRoot[]>();
  const candidates: MigrationVariant[] = [];
  const pendingRoots: [MigrationRoot, string][] = [];
  for (const [root, base] of sources) {
    if (!existsSync(base)) continue;
    const real = realOrPlanned(base);
    const first = seen.get(real);
    if (first) {
      aliases.set(first, [...(aliases.get(first) ?? []), root]);
      skipped.push({ path: base, code: 'alias', reason: `same folder as the ${first} source; migrated once there` });
      continue;
    }
    seen.set(real, root);
    pendingRoots.push([root, base]);
  }
  // Aliases are only known once every source was looked at, so the toggles are folded in afterwards.
  const visibleTo = (root: MigrationRoot): Harness[] => {
    const set = new Set([root, ...(aliases.get(root) ?? [])].flatMap((r) => VISIBLE_TO[r]));
    return HARNESS_ORDER.filter((h) => set.has(h));
  };
  for (const [root, base] of pendingRoots) candidates.push(...rootCandidates(root, base, paths, skipped, visibleTo(root)));
  const byName = new Map<string, MigrationVariant[]>();
  for (const variant of candidates) byName.set(variant.name, [...(byName.get(variant.name) ?? []), variant]);
  const decisions: MigrationDecision[] = [];
  for (const [name, variants] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    // A neutral, stable order (never newest-first: nothing here ranks one copy above another).
    const ordered = [...variants].sort((a, b) => a.path.localeCompare(b.path));
    const first = ordered[0]!;
    const hasDifferingVariants = new Set(variants.map((variant) => variant.hash)).size > 1;
    const visible = new Set(variants.flatMap((v) => v.harnesses));
    decisions.push({
      name, variants: ordered, needsChoice: hasDifferingVariants,
      defaultPath: hasDifferingVariants ? null : first.path, defaultHash: hasDifferingVariants ? null : first.hash,
      harnesses: HARNESS_ORDER.filter((h) => visible.has(h)),
    });
  }
  const protectedVariants = [
    ...collectProtectedVariants('claude-synced', paths.roots['claude-synced'], paths),
    ...collectProtectedVariants('codex', join(paths.roots.codex, '.system'), paths),
  ];
  return {
    home: paths.home, library: paths.library, candidates, skipped, protectedVariants, decisions,
    defaultChoices: Object.fromEntries(decisions.filter((decision) => !decision.needsChoice).map((decision) => [decision.name, decision.defaultPath!])),
    warnings: rootAliasWarnings(paths),
  };
}

export interface MigrationSummary {
  /** Skills that would be copied into the library (no choice needed). */
  toLibrary: number;
  needsChoice: string[];
  /** Entries that would be moved to the backup (and replaced by a library link, except ~/.agents/skills ones). */
  entries: number;
  linksFlattened: number;
  skipped: Record<string, number>;
}

export function summarizePlan(plan: MigrationPlan): MigrationSummary {
  const skippedByCode: Record<string, number> = {};
  for (const item of plan.skipped) skippedByCode[item.code ?? 'other'] = (skippedByCode[item.code ?? 'other'] ?? 0) + 1;
  return {
    toLibrary: plan.decisions.filter((d) => !d.needsChoice).length,
    needsChoice: plan.decisions.filter((d) => d.needsChoice).map((d) => d.name),
    entries: plan.candidates.length,
    linksFlattened: plan.candidates.filter((c) => c.kind === 'link').length,
    skipped: skippedByCode,
  };
}

function membersFor(plan: MigrationPlan, paths: SkillPaths): string[] {
  const pathsToSave = new Set<string>(plan.candidates.map((item) => item.path));
  if (existsSync(paths.library)) pathsToSave.add(paths.library);
  const members = [...pathsToSave].map((path) => {
    if (!inside(path, paths.home)) throw new Error(`Cannot safely back up path outside sandbox HOME: ${path}`);
    return relative(paths.home, path) || '.';
  });
  return [...new Set(members)].sort((a, b) => a.localeCompare(b));
}

function librarySkillNames(library: string): string[] {
  try {
    return readdirSync(library).filter((name) => isSkillFolder(join(library, name))).sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

function run(args: string[], env?: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function backup(plan: MigrationPlan, paths: SkillPaths = skillPaths()): BackupManifest {
  assertLibrarySafe(paths);
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const dir = assertWritable(join(paths.backup, id), paths);
  mkdirSync(dir, { recursive: true });
  const tarPath = assertWritable(join(dir, 'backup.tar'), paths);
  const manifestPath = assertWritable(join(dir, 'backup-manifest.json'), paths);
  const members = membersFor(plan, paths);
  if (members.length) {
    const archive = run(['tar', '-cf', tarPath, '-C', paths.home, '--', ...members]);
    if (archive.code !== 0) throw new Error(archive.stderr.trim() || `tar failed with exit ${archive.code}`);
  } else {
    // An empty migration still records a valid empty tar archive.
    const archive = run(['tar', '-cf', tarPath, '-C', paths.home, '--files-from', '/dev/null']);
    if (archive.code !== 0) throw new Error(archive.stderr.trim() || `tar failed with exit ${archive.code}`);
  }
  const bytes = awaitlessRead(tarPath);
  const info: BackupManifest = {
    home: paths.home, library: paths.library, libraryExisted: existsSync(paths.library),
    librarySkillsBefore: librarySkillNames(paths.library), librarySkillsAfterMigration: librarySkillNames(paths.library), dir, tarPath, manifestPath,
    members, movedPaths: [], moved: [], inFlight: null, createdDirs: [], size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  writeFileSync(manifestPath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  return info;
}

function awaitlessRead(path: string): Buffer {
  return readFileSync(path);
}

/** One variant per name to migrate. A name with differing copies and no explicit choice is absent: it is kept as a conflict. */
function resolveChoices(plan: MigrationPlan, choices: Record<string, string>): Map<string, MigrationVariant> {
  const result = new Map<string, MigrationVariant>();
  for (const decision of plan.decisions) {
    const selected = choices[decision.name];
    if (decision.needsChoice && selected === undefined) continue;
    const path = selected ?? decision.defaultPath;
    const variant = decision.variants.find((item) => item.path === path || item.hash === path);
    if (!variant) throw new Error(`Invalid migration choice for ${decision.name}: ${path}`);
    result.set(decision.name, variant);
  }
  return result;
}

/** Nonexistent ancestors of `dir` up to (not including) HOME: what creating `dir` would add. */
function missingChain(dir: string, home: string): string[] {
  const chain: string[] = [];
  let current = resolve(dir);
  while (inside(current, home) && current !== resolve(home) && !existsSync(current)) {
    chain.push(current);
    current = dirname(current);
  }
  return chain;
}

export function applyMigration(
  plan: MigrationPlan,
  choices: Record<string, string> = {},
  paths: SkillPaths = skillPaths(),
  saved?: BackupManifest,
): {
  backup: BackupManifest; selected: Record<string, string>; replaced: string[]; skipped: MigrationSkip[];
  linkConflicts: LinkAction[];
} {
  assertLibrarySafe(paths);
  const backupManifest = saved ?? backup(plan, paths);
  if (backupManifest.home !== paths.home) throw new Error('Backup HOME does not match migration HOME');
  const save = () => writeFileSync(backupManifest.manifestPath, `${JSON.stringify(backupManifest, null, 2)}\n`, { mode: 0o600 });
  const selected = resolveChoices(plan, choices);
  const manifest = readManifest(paths.library);
  ensureLibrary(paths);
  const targets = new Map<string, string>();
  const skipped: MigrationSkip[] = [];
  const stalePaths = new Set<string>();
  const materialized = new Set<string>();
  const candidateMatchesPlan = (candidate: MigrationVariant): boolean => {
    try {
      const currentResolved = realpathSync.native(candidate.path);
      return currentResolved === candidate.resolvedPath && folderHash(currentResolved) === candidate.hash;
    } catch { return false; }
  };
  const markChanged = (candidate: MigrationVariant) => {
    stalePaths.add(candidate.path);
    if (!skipped.some((item) => item.path === candidate.path && item.reason === 'changed since plan')) {
      skipped.push({ path: candidate.path, reason: 'changed since plan' });
    }
  };
  for (const candidate of plan.candidates) if (!candidateMatchesPlan(candidate)) markChanged(candidate);

  // Copy and hash-verify all canonical library variants before moving any source entry.
  for (const decision of plan.decisions) {
    if (!validSkillName(decision.name)) throw new Error(`Invalid migration skill name: ${decision.name}`);
    const variant = selected.get(decision.name);
    if (!variant) continue; // differing copies without an explicit choice: nothing is copied, every copy stays as it is
    const target = join(paths.library, decision.name);
    let targetStat;
    try { targetStat = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (targetStat) {
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error(`Library entry is not a real skill folder: ${target}`);
      if (folderHash(target) !== variant.hash) throw new Error(`Library already has a different ${decision.name}; no migration files were moved`);
    } else {
      const sourceVariant = decision.variants.find((candidate) => candidate.hash === variant.hash && candidateMatchesPlan(candidate));
      if (!sourceVariant) {
        const planned = decision.variants.find((candidate) => candidate.path === variant.path)!;
        if (!stalePaths.has(planned.path)) markChanged(planned);
        continue;
      }
      const temp = assertWritable(join(paths.library, `.${decision.name}.${randomUUID()}.migration-tmp`), paths);
      cpSync(sourceVariant.resolvedPath, temp, { recursive: true, dereference: false, preserveTimestamps: true });
      if (folderHash(temp) !== variant.hash) throw new Error(`Hash verification failed while copying ${decision.name}`);
      renameSync(temp, assertWritable(target, paths));
    }
    targets.set(decision.name, target);
    materialized.add(decision.name);
  }

  const replaced: string[] = [];
  const movedNames = new Set<string>();
  const movedHarnesses = new Map<string, Set<Harness>>();
  for (const candidate of plan.candidates) {
    if (!selected.has(candidate.name)) continue;
    const target = targets.get(candidate.name);
    if (!target) continue;
    if (stalePaths.has(candidate.path) || !candidateMatchesPlan(candidate)) { markChanged(candidate); continue; }
    const backupPath = assertWritable(join(backupManifest.dir, candidate.root, candidate.name), paths);
    mkdirSync(dirname(backupPath), { recursive: true });
    assertWritable(candidate.path, paths, MIGRATION_ROOTS(paths));
    const entry: MovedEntry = {
      path: candidate.path, root: candidate.root, name: candidate.name, kind: candidate.kind, linkTarget: candidate.linkTarget,
      resolvedPath: candidate.resolvedPath, hash: candidate.hash, backupPath,
    };
    // Intent first: a crash between the rename and the record below is recoverable by rollback.
    backupManifest.inFlight = entry;
    save();
    renameSync(candidate.path, backupPath);
    backupManifest.movedPaths.push(candidate.path);
    backupManifest.moved.push(entry);
    backupManifest.inFlight = null;
    save();
    movedNames.add(candidate.name);
    movedHarnesses.set(candidate.name, new Set([...(movedHarnesses.get(candidate.name) ?? []), ...candidate.harnesses]));
    // Harness folders and Desktop/Skills get a library link where the original was. ~/.agents/skills is another tool's
    // folder: its originals only move out, and the harness folders get their links from the toggles below.
    if (LINKED_BACK.includes(candidate.root)) {
      const destination = assertWritable(candidate.path, paths, MIGRATION_ROOTS(paths));
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(target, destination, 'dir');
    }
    replaced.push(candidate.path);
  }
  for (const decision of plan.decisions) {
    if (!materialized.has(decision.name) || !movedNames.has(decision.name)) continue;
    const existing = manifest.skills[decision.name]?.harnesses ?? [];
    manifest.skills[decision.name] = {
      ...(manifest.skills[decision.name] ?? {}),
      harnesses: HARNESS_ORDER.filter((h) => existing.includes(h) || movedHarnesses.get(decision.name)?.has(h)),
    };
  }
  // Harness toggles beyond the folders the originals sat in (e.g. an ~/.agents/skills skill that Codex and OpenCode read)
  // become links now. Folders that do not exist yet are recorded so rollback can remove them again.
  backupManifest.createdDirs = [...new Set(HARNESS_ORDER.flatMap((h) => missingChain(paths.roots[h], paths.home)))];
  save();
  writeManifest(manifest, paths.library, paths);
  const names = new Set(movedNames);
  const linkActions = planLinks(manifest, scanSkills(paths), paths).filter((action) => names.has(action.name));
  const linkConflicts = applyLinks(linkActions, paths);
  backupManifest.librarySkillsAfterMigration = librarySkillNames(paths.library);
  save();
  return {
    backup: backupManifest, selected: Object.fromEntries([...selected].map(([name, v]) => [name, v.path])), replaced, skipped, linkConflicts,
  };
}

export function apply(
  plan: MigrationPlan,
  choices: Record<string, string> = {},
  paths: SkillPaths = skillPaths(),
  saved?: BackupManifest,
) {
  return applyMigration(plan, choices, paths, saved);
}

export interface RollbackResult {
  /** Paths put back from the backup and verified (kind, link target / content hash) afterwards. */
  restored: string[];
  /** Everything that was NOT put back, with the reason. Never overlaps `restored`. */
  notRestored: { path: string; reason: string }[];
  libraryRestored: boolean;
  /** Why the library was not restored (or what happened to it). */
  libraryNote: string | null;
  addedSkills: string[];
  preservedAt: string | null;
  /** Library links in the harness folders that were not part of the migration (new toggles) and were moved aside. */
  removedLinks: string[];
  /** Harness folders apply had created that are empty again and were removed. */
  removedDirs: string[];
}

function archiveMembers(tarPath: string): Set<string> {
  const listing = run(['tar', '-tf', tarPath]);
  if (listing.code !== 0) throw new Error(listing.stderr.trim() || 'tar listing failed');
  return new Set(listing.stdout.split('\n').filter(Boolean).map((line) => line.replace(/^\.\//, '').replace(/\/+$/, '')));
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Does the restored `entry` look like what was backed up? Returns a reason when it does not. */
function verifyRestored(entry: MovedEntry | { path: string; kind?: undefined }): string | null {
  let st;
  try { st = lstatSync(entry.path); } catch { return 'missing after restore'; }
  if (!('hash' in entry) || !entry.kind) return null;
  if (entry.kind === 'link') {
    if (!st.isSymbolicLink()) return 'restored, but it is not a link as recorded';
    if (readlinkSync(entry.path) !== entry.linkTarget) return `restored link points to ${readlinkSync(entry.path)}, recorded ${entry.linkTarget}`;
    return null;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return 'restored, but it is not a folder as recorded';
  try { if (folderHash(entry.path) !== entry.hash) return 'restored folder content differs from the recorded hash'; }
  catch (error) { return `could not verify: ${(error as Error).message}`; }
  return null;
}

/**
 * Put the backup back. A moved entry that is gone now (its link was removed later, or apply crashed after the rename) is
 * restored too; a present one is moved aside first (kept under `preservedAt`). The result lists what really came back
 * (verified) and what did not, with reasons.
 */
export function rollback(backupInput: BackupManifest | string, paths: SkillPaths = skillPaths()): RollbackResult {
  assertLibrarySafe(paths);
  const saved = typeof backupInput === 'string'
    ? JSON.parse(awaitlessRead(backupInput).toString('utf8')) as BackupManifest
    : backupInput;
  if (resolve(saved.home) !== resolve(paths.home)) throw new Error('Backup HOME does not match rollback HOME');
  const currentSkills = librarySkillNames(paths.library);
  const knownSkills = saved.librarySkillsAfterMigration ?? saved.librarySkillsBefore ?? [];
  const addedSkills = currentSkills.filter((name) => !knownSkills.includes(name));
  const preservedAt = join(saved.dir, `rollback-current-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  const inArchive = archiveMembers(saved.tarPath);
  const notRestored: RollbackResult['notRestored'] = [];

  // What apply moved (older backups only know the paths), plus the move that was under way if apply crashed.
  const byPath = new Map<string, MovedEntry | { path: string; kind?: undefined }>();
  for (const path of saved.movedPaths ?? []) byPath.set(path, { path });
  for (const entry of saved.moved ?? []) byPath.set(entry.path, entry);
  const wanted: (MovedEntry | { path: string; kind?: undefined })[] = [];
  for (const entry of [...byPath.values()].sort((a, b) => b.path.length - a.path.length)) {
    if (!inside(entry.path, paths.home)) { notRestored.push({ path: entry.path, reason: 'outside HOME: not touched' }); continue; }
    const rel = relative(paths.home, entry.path);
    if (!inArchive.has(rel)) { notRestored.push({ path: entry.path, reason: 'not in the backup archive' }); continue; }
    wanted.push(entry);
  }
  const pending = saved.inFlight;
  if (pending && !byPath.has(pending.path)) {
    const rel = relative(paths.home, pending.path);
    if (!present(pending.backupPath)) {
      notRestored.push({ path: pending.path, reason: 'its move had not happened when apply stopped: still in place, nothing to restore' });
    } else if (!inside(pending.path, paths.home) || !inArchive.has(rel)) {
      notRestored.push({ path: pending.path, reason: 'not in the backup archive' });
    } else wanted.push(pending);
  }

  const members: string[] = [];
  let usedAside = false;
  for (const entry of wanted) {
    const rel = relative(paths.home, entry.path);
    if (present(entry.path)) {
      usedAside = true;
      const aside = assertWritable(join(preservedAt, 'entries', rel), paths);
      mkdirSync(dirname(aside), { recursive: true });
      renameSync(assertWritable(entry.path, paths, MIGRATION_ROOTS(paths)), aside);
    } else mkdirSync(dirname(assertWritable(entry.path, paths, MIGRATION_ROOTS(paths))), { recursive: true });
    members.push(rel);
  }
  let libraryPresent = false;
  try { lstatSync(paths.library); libraryPresent = true; } catch {}
  const removedLinks: string[] = [];
  if (libraryPresent) {
    // Links into the library that the migration did not move (new harness toggles) would dangle once the library is gone.
    const libraryReal = realOrPlanned(paths.library);
    for (const harness of HARNESS_ORDER) {
      const root = paths.roots[harness];
      let names: string[] = [];
      try { names = readdirSync(root); } catch { continue; }
      for (const name of names) {
        const path = join(root, name);
        let target: string;
        try {
          if (!lstatSync(path).isSymbolicLink()) continue;
          target = resolve(dirname(path), readlinkSync(path));
        } catch { continue; }
        if (!inside(target, paths.library) && !inside(target, libraryReal)) continue;
        if (removedLinks.includes(path)) continue;
        const aside = assertWritable(join(preservedAt, 'links', relative(paths.home, path)), paths);
        mkdirSync(dirname(aside), { recursive: true });
        renameSync(assertWritable(path, paths), aside);
        removedLinks.push(path);
        usedAside = true;
      }
    }
    usedAside = true;
    const aside = assertWritable(join(preservedAt, 'library'), paths);
    mkdirSync(dirname(aside), { recursive: true });
    renameSync(assertWritable(paths.library, paths), aside);
  }
  const libraryRel = relative(paths.home, paths.library);
  const libraryInArchive = saved.libraryExisted && inArchive.has(libraryRel);
  if (libraryInArchive) members.push(libraryRel);
  const toExtract = [...new Set(members)].sort((a, b) => a.localeCompare(b));
  if (toExtract.length) {
    const extracted = run(['tar', '-xf', saved.tarPath, '-C', paths.home, '--', ...toExtract]);
    if (extracted.code !== 0) {
      throw new Error(`${extracted.stderr.trim() || 'tar restore failed'} (what was in the way is kept under ${preservedAt})`);
    }
  }

  const restored: string[] = [];
  for (const entry of wanted) {
    const problem = verifyRestored(entry);
    if (problem) notRestored.push({ path: entry.path, reason: problem });
    else restored.push(entry.path);
  }
  let libraryRestored = false;
  let libraryNote: string | null = null;
  if (!saved.libraryExisted) libraryNote = libraryPresent ? 'there was no library before the migration; the current one was moved aside' : 'there was no library before the migration';
  else if (!libraryInArchive) libraryNote = 'the library is not in the backup archive';
  else if (!present(paths.library)) libraryNote = 'the library is missing after restore';
  else libraryRestored = true;

  const removedDirs: string[] = [];
  for (const dir of [...(saved.createdDirs ?? [])].sort((a, b) => b.length - a.length)) {
    if (!inside(dir, paths.home) || resolve(dir) === resolve(paths.home)) continue;
    try { rmdirSync(dir); removedDirs.push(dir); } catch { /* not empty (the user added something) or already gone: leave it */ }
  }
  return {
    restored, notRestored, libraryRestored, libraryNote, addedSkills,
    preservedAt: usedAside ? preservedAt : null,
    removedLinks, removedDirs,
  };
}

export interface TreeSnapshot {
  path: string;
  kind: 'file' | 'dir' | 'link';
  hash?: string;
  target?: string;
}

export function snapshotTree(root: string): TreeSnapshot[] {
  const result: TreeSnapshot[] = [];
  const visit = (path: string) => {
    let stat;
    try { stat = lstatSync(path); } catch { return; }
    if (stat.isSymbolicLink()) {
      result.push({ path: relative(root, path), kind: 'link', target: readlinkSync(path) });
    } else if (stat.isDirectory()) {
      result.push({ path: relative(root, path), kind: 'dir' });
      for (const name of readdirSync(path).sort((a, b) => a.localeCompare(b))) visit(join(path, name));
    } else if (stat.isFile()) {
      result.push({ path: relative(root, path), kind: 'file', hash: createHash('sha256').update(awaitlessRead(path)).digest('hex') });
    }
  };
  visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

