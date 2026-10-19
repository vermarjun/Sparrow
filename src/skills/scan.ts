import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isReservedSkillName, parseSkillFrontmatter } from './frontmatter';
import { cachedFolderHash } from './hash';
import { readManifest } from './manifest';
import { HARNESS_READS, overlaps, realOrPlanned, skillPaths } from './paths';
import type { Harness, SkillEntry, SkillPaths, SkillRoot } from './types';

const LIBRARY_HARNESS_ROOTS: Harness[] = ['claude', 'codex', 'opencode'];
const OMIT = new Set(['.DS_Store', '.trash', '.system']);

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function listChildren(root: string): string[] {
  try { return readdirSync(root).sort((a, b) => a.localeCompare(b)).map((name) => join(root, name)); }
  catch { return []; }
}

function skillChildren(root: string, synced = false): string[] {
  if (!existsSync(root)) return [];
  if (!synced) return listChildren(root);
  const skills: string[] = [];
  for (const bucket of listChildren(root)) {
    try { if (!lstatSync(bucket).isDirectory()) continue; } catch { continue; }
    for (const child of listChildren(bucket)) skills.push(child);
  }
  return skills;
}

function collectLinkProblems(dir: string): { code: string; message: string }[] {
  const problems: { code: string; message: string }[] = [];
  const visit = (current: string) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          const raw = readlinkSync(full);
          target = realpathSync.native(resolve(dirname(full), raw));
        } catch {
          problems.push({ code: 'link-broken', message: `dangling symlink inside skill: ${relative(dir, full)}` });
          continue;
        }
        if (!inside(target, dir)) problems.push({ code: 'link-escapes', message: `symlink escapes skill folder: ${relative(dir, full)}` });
      } else if (entry.isDirectory()) visit(full);
    }
  };
  visit(dir);
  return problems;
}

/**
 * An entry that is the library itself, lives inside it (a harness folder that IS the library) or contains it
 * (a link to an ancestor of the library) is never listed: it would be hashed, adopted or resolved against itself.
 * A normal managed link (`<root>/x -> <library>/x`) is not self-referential: only its target is in the library.
 */
export function selfReferential(path: string, resolvedTarget: string | null, paths: SkillPaths): boolean {
  const library = realOrPlanned(paths.library);
  const inside_ = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (inside_(realOrPlanned(dirname(path)), library)) return true;
  if (resolvedTarget && (resolvedTarget === library || inside_(library, resolvedTarget))) return true;
  return false;
}

function makeEntry(root: SkillRoot, path: string, paths: SkillPaths, manifest: ReturnType<typeof readManifest>): SkillEntry | null {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (OMIT.has(name) || name === 'synced') return null;
  let stat;
  try { stat = lstatSync(path); } catch { return null; }
  if (root !== 'library') {
    let target: string | null = null;
    try { target = realpathSync.native(path); } catch {}
    if (selfReferential(path, target, paths)) return null;
  }
  const kind = stat.isSymbolicLink() ? 'link' : 'dir';
  const linkTarget = kind === 'link' ? readlinkSync(path) : null;
  let resolvedTarget: string | null = null;
  let broken = false;
  if (kind === 'link') {
    try { resolvedTarget = realpathSync.native(path); } catch { broken = true; }
  } else resolvedTarget = path;
  const problems: SkillEntry['problems'] = [];
  let hash: string | null = null;
  let frontmatter: SkillEntry['frontmatter'] = null;
  if (!broken && resolvedTarget) {
    try {
      const rootStat = lstatSync(resolvedTarget);
      if (!rootStat.isDirectory()) return null;
      const skillMd = join(resolvedTarget, 'SKILL.md');
      // Only skill folders are hashed (never the library's .git or another tool's non-skill folder).
      if (!existsSync(skillMd)) return null;
      hash = cachedFolderHash(resolvedTarget);
      problems.push(...collectLinkProblems(resolvedTarget));
      if (lstatSync(skillMd).isSymbolicLink()) problems.push({ code: 'link-escapes', message: 'SKILL.md is a symlink and was not read' });
      else {
        const parsed = parseSkillFrontmatter(readFileSync(skillMd, 'utf8'), name);
        frontmatter = parsed.frontmatter;
        problems.push(...parsed.problems);
      }
    } catch { return null; }
  }

  let status: SkillEntry['status'];
  let conflict: SkillEntry['conflict'] = null;
  if (broken) status = 'broken';
  else if (root === 'sparrow') status = 'sparrow';
  // `sparrow install` copies Sparrow's own skills into the harness roots: locked, never Unmanaged/Adopt.
  else if ((root === 'claude' || root === 'codex' || root === 'opencode') && isReservedSkillName(name)) status = 'sparrow';
  else if (root === 'agents' || root === 'claude-synced') status = 'external';
  else if (kind === 'link' && resolvedTarget && inside(resolvedTarget, paths.library)
    && resolve(resolvedTarget) === resolve(join(paths.library, name))) status = 'managed';
  else if (kind === 'link' && resolvedTarget
    && (inside(resolvedTarget, paths.roots.agents) || inside(resolvedTarget, paths.roots['claude-synced']))) status = 'external';
  else if (kind === 'link' && resolvedTarget && paths.externalTargets.some((target) => inside(resolvedTarget, target))) status = 'external';
  else if (kind === 'link' && resolvedTarget && !inside(resolvedTarget, paths.home) && !inside(resolvedTarget, paths.library)) status = 'external';
  else if (root === 'library') {
    status = 'managed';
    if (!manifest.skills[name]) problems.push({ code: 'not-in-manifest', message: 'library folder is not in skills.json' });
  } else if (existsSync(join(paths.library, name, 'SKILL.md'))) {
    status = 'conflict';
    try { conflict = hash === cachedFolderHash(join(paths.library, name)) ? 'identical' : 'diff'; }
    catch { conflict = 'diff'; }
  } else status = 'unmanaged';
  return {
    root, name, path, kind, linkTarget, resolvedTarget, folderHash: hash, frontmatter,
    problems, readers: [...HARNESS_READS[root]] as Harness[], status, conflict,
  };
}

export function scanSkills(paths: SkillPaths = skillPaths()): SkillEntry[] {
  const manifest = readManifest(paths.library);
  const entries: SkillEntry[] = [];
  const addRoot = (root: SkillRoot, synced = false) => {
    // A root that overlaps the library (the library location is refused, see libraryProblem) is not scanned as a harness root.
    if (root !== 'library' && overlaps(paths.roots[root], paths.library)) return;
    for (const path of skillChildren(paths.roots[root], synced)) {
      const entry = makeEntry(root, path, paths, manifest);
      if (entry) entries.push(entry);
    }
  };
  addRoot('library');
  addRoot('claude');
  addRoot('codex');
  addRoot('opencode');
  addRoot('agents');
  addRoot('claude-synced', true);
  addRoot('sparrow');
  return entries;
}

export const scan = scanSkills;
