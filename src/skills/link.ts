import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertLibrarySafe, assertWritable, rootGroupOf, rootPrimary, skillPaths } from './paths';
import { invalidManifestNames, readManifest, writeManifest } from './manifest';
import { scanSkills } from './scan';
import { folderHash } from './hash';
import { validSkillName } from './frontmatter';
import type { Harness, LinkAction, SkillEntry, SkillPaths, SkillsManifest } from './types';

const ROOTS: Harness[] = ['claude', 'codex', 'opencode'];

function real(path: string): string | null {
  try { return realpathSync.native(path); } catch { return null; }
}

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function expectedLink(path: string, target: string): boolean {
  const resolved = real(path);
  return resolved !== null && resolve(resolved) === resolve(target);
}

function ownLink(path: string, paths: SkillPaths): boolean {
  try { if (!lstatSync(path).isSymbolicLink()) return false; } catch { return false; }
  const resolved = real(path);
  let library = resolve(paths.library);
  try { library = realpathSync.native(library); } catch {}
  if (resolved) return within(resolved, library);
  try {
    return within(resolve(dirname(path), readlinkSync(path)), library);
  } catch { return false; }
}

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

export function plan(
  desired: SkillsManifest = readManifest(skillPaths().library),
  actual: SkillEntry[] = scanSkills(skillPaths()),
  paths: SkillPaths = skillPaths(),
): LinkAction[] {
  assertLibrarySafe(paths);
  const actions: LinkAction[] = [];
  const byRootName = new Map(actual.map((entry) => [`${entry.root}\0${entry.name}`, entry]));
  const invalidNames = new Set(invalidManifestNames(desired));
  for (const [name, item] of Object.entries(desired.skills).sort(([a], [b]) => a.localeCompare(b))) {
    if (invalidNames.has(name)) {
      const roots = Array.isArray(item?.harnesses) ? item.harnesses.filter((root): root is Harness => ROOTS.includes(root)) : [];
      const reportRoots = roots.length ? [...new Set(roots)] : ['claude' as const];
      for (const root of reportRoots) actions.push({
        type: 'conflict', root, name, path: paths.library,
        reason: `invalid skill name "${name}"; skipped without touching any path`,
      });
      continue;
    }
    const target = join(paths.library, name);
    const harnesses = Array.isArray(item?.harnesses) ? item.harnesses : [];
    if (!isDirectory(target)) {
      for (const root of harnesses.filter((value): value is Harness => ROOTS.includes(value))) actions.push({ type: 'conflict', root, name, path: join(paths.roots[root], name), reason: `library folder is missing: ${target}` });
      continue;
    }
    for (const root of ROOTS) {
      // Harness folders that are the same folder (e.g. ~/.codex/skills -> ~/.claude/skills) are one root: the first harness
      // owns the link, and it stays while ANY harness of the group wants the skill.
      if (rootPrimary(root, paths) !== root) continue;
      const path = join(paths.roots[root], name);
      const wanted = rootGroupOf(root, paths).some((member) => harnesses.includes(member));
      const entry = byRootName.get(`${root}\0${name}`);
      if (wanted) {
        if (!existsSync(path) && !entry) {
          // existsSync does not detect dangling symlinks.
          try { lstatSync(path); actions.push({ type: 'conflict', root, name, path, reason: 'destination is an unowned dangling symlink' }); }
          catch { actions.push({ type: 'create', root, name, path, target }); }
        } else if (expectedLink(path, target)) continue;
        else if (ownLink(path, paths)) actions.push({ type: 'repair', root, name, path, target });
        else {
          const identical = entry?.folderHash === (() => { try { return folderHash(target); } catch { return null; } })();
          const diff = entry?.resolvedTarget ? diffFolders(target, entry.resolvedTarget) : undefined;
          actions.push({ type: 'conflict', root, name, path, reason: identical ? 'existing folder is identical to the library skill' : 'destination is a real folder or a link Sparrow does not own', ...(diff ? { diff } : {}) });
        }
      } else if (entry && ownLink(path, paths)) actions.push({ type: 'remove-own-link', root, name, path });
      else if (ownLink(path, paths)) actions.push({ type: 'remove-own-link', root, name, path });
    }
  }
  for (const entry of actual) {
    if (!ROOTS.includes(entry.root as Harness) || entry.status !== 'managed' || desired.skills[entry.name]) continue;
    if (rootPrimary(entry.root as Harness, paths) !== entry.root) continue;
    actions.push({ type: 'remove-own-link', root: entry.root as Harness, name: entry.name, path: entry.path });
  }
  return actions;
}

export function apply(actions: LinkAction[], paths: SkillPaths = skillPaths()): LinkAction[] {
  assertLibrarySafe(paths);
  const conflicts: LinkAction[] = [];
  for (const action of actions) {
    if (!validSkillName(action.name)) {
      conflicts.push({ type: 'conflict', root: action.root, name: action.name, path: action.path, reason: `invalid skill name "${action.name}"; skipped without touching any path` });
      continue;
    }
    if (action.type === 'conflict') { conflicts.push(action); continue; }
    const path = assertWritable(action.path, paths);
    if (action.type === 'create') {
      try { lstatSync(path); conflicts.push({ type: 'conflict', root: action.root, name: action.name, path, reason: 'destination appeared after planning; left untouched' }); continue; }
      catch {}
      mkdirSync(dirname(path), { recursive: true });
      if (!isDirectory(action.target)) { conflicts.push({ type: 'conflict', root: action.root, name: action.name, path, reason: 'library target is missing; left untouched' }); continue; }
      symlinkSync(action.target, path, 'dir');
    } else {
      if (!ownLink(path, paths)) {
        conflicts.push({ type: 'conflict', root: action.root, name: action.name, path, reason: 'link is no longer owned by Sparrow; left untouched' });
        continue;
      }
      if (action.type === 'repair') {
        if (!isDirectory(action.target)) { conflicts.push({ type: 'conflict', root: action.root, name: action.name, path, reason: 'library target is missing; left untouched' }); continue; }
        unlinkSync(path);
        symlinkSync(action.target, path, 'dir');
      } else unlinkSync(path);
    }
  }
  return conflicts;
}

function spawnText(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

export function diff(libraryDir: string, otherDir: string): string {
  const result = spawnText(['git', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--', libraryDir, otherDir]);
  if (result.code === 0 || result.code === 1) return result.stdout;
  throw new Error(result.stderr.trim() || `git diff exited ${result.code}`);
}

function diffFolders(a: string, b: string): string {
  try { return diff(a, b); } catch { return ''; }
}

/** Replace Sparrow-owned links with byte-verified local copies. */
export function unmanage(name: string, paths: SkillPaths = skillPaths()): string[] {
  if (!validSkillName(name)) throw new Error(`Invalid skill name "${name}"; expected lowercase letters, digits, and single hyphens (1–64 characters)`);
  const source = join(paths.library, name);
  if (!isDirectory(source)) throw new Error(`Library skill does not exist: ${name}`);
  const expected = folderHash(source);
  const copied: string[] = [];
  for (const root of ROOTS) {
    const path = join(paths.roots[root], name);
    if (!ownLink(path, paths)) continue;
    const temp = assertWritable(join(dirname(path), `.${name}.${process.pid}.unmanage-tmp`), paths);
    const writable = assertWritable(path, paths);
    mkdirSync(dirname(writable), { recursive: true });
    cpSync(source, temp, { recursive: true, dereference: false, errorOnExist: true, force: false });
    if (folderHash(temp) !== expected) {
      // The temporary copy is ours and is inside the fence.
      throw new Error(`Copy verification failed while unmanaging ${name}`);
    }
    unlinkSync(writable);
    renameSync(temp, writable);
    copied.push(writable);
  }
  if (copied.length) {
    const manifest = readManifest(paths.library);
    const item = manifest.skills[name];
    if (item) {
      item.harnesses = item.harnesses.filter((root) => !copied.includes(join(paths.roots[root], name)));
      writeManifest(manifest, paths.library, paths);
    }
  }
  return copied;
}

export function sync(paths: SkillPaths = skillPaths()): { actions: LinkAction[]; conflicts: LinkAction[] } {
  const actions = plan(readManifest(paths.library), scanSkills(paths), paths);
  return { actions, conflicts: apply(actions, paths) };
}
