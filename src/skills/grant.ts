// Per-agent skill grants: a resume's `skills:` list → the skill folders one spawn may see.
// Computed at hire (and on "apply resume"), stored in <agentDir>/skills.json, read at every call start; the
// drivers then materialise <agentDir>/skills/ (symlinks) and point their harness at it.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { ASSETS } from '../shared/config';
import { codexAgentsRoots, libraryProblem, skillPaths } from './paths';
import { agentDir } from '../harness/env';
import { writeAtomic } from '../harness/launch';
import type { SkillGrant } from '../harness/index';
import { validSkillName } from './frontmatter';

import { SPARROW_SKILLS } from './frontmatter';
export { SPARROW_SKILLS };

/** The library folder (skillPaths() is the one resolver for every skill path). */
export const libraryDir = (): string => skillPaths().library;

export const agentsSkillsRoot = (): string => skillPaths().roots.agents;
/** Every `.agents/skills` root a spawned Codex reads: see codexAgentsRoots() in paths.ts. */
export const agentsSkillsRoots = (): string[] => codexAgentsRoots();

export const sparrowSkills = (): SkillGrant[] => SPARROW_SKILLS.map((name) => ({ name, path: join(ASSETS, 'skills', name) }));

/** Sparrow's two skills first (always on, locked), then the other grants; a grant named like a Sparrow skill is dropped. */
export function withSparrow(grants?: SkillGrant[]): SkillGrant[] {
  const locked = new Set<string>(SPARROW_SKILLS);
  const seen = new Set<string>();
  const rest = (grants ?? []).filter((g) => !locked.has(g.name) && !seen.has(g.name) && seen.add(g.name));
  return [...sparrowSkills(), ...rest];
}

const hasSkillMd = (dir: string) => {
  try {
    return statSync(join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
};

/** Grants whose folder still holds a SKILL.md (a library skill deleted after hire is skipped, not linked broken). */
export const usableGrants = (grants: SkillGrant[]) => grants.filter((g) => hasSkillMd(g.path));

/**
 * What a spawn may link: Sparrow's own two skills, and anything else only while its REAL path is still inside the
 * REAL library (re-tested at every call start: the snapshot's path may have been swapped for an outside symlink, or
 * the library moved, since hire/apply), and its folder still holds a SKILL.md.
 */
export function launchGrants(grants: SkillGrant[]): SkillGrant[] {
  const locked = new Map(sparrowSkills().map((g) => [g.name, g.path]));
  const libReal = realOf(libraryDir());
  const unsafe = libraryProblem() !== null;
  return usableGrants(grants).filter((g) => {
    if (locked.get(g.name) === g.path) return true;
    if (unsafe) return false; // a refused library location grants nothing (Sparrow's own skills still launch)
    const real = realOf(g.path);
    return !!libReal && !!real && (real === libReal || real.startsWith(libReal + sep));
  });
}

export interface GrantResult {
  grants: SkillGrant[];   // Sparrow's two + each resolvable library skill
  warnings: string[];     // one line per skill that could not be granted
  requested?: string[];   // the resume's skills: at hire/apply (lets a call pick up a skill imported after hire)
}

const realOf = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

/** resume `skills:` names → grants. Invalid or unknown names never resolve to a path; they become warnings. */
export function resolveGrants(names: string[] | undefined): GrantResult {
  const lib = libraryDir();
  const libReal = realOf(lib);
  const grants: SkillGrant[] = [];
  const warnings: string[] = [];
  const unsafe = libraryProblem();
  for (const name of names ?? []) {
    if (unsafe && !(SPARROW_SKILLS as readonly string[]).includes(name) && validSkillName(name)) {
      warnings.push(`skill "${name}" not granted: ${unsafe}`);
      continue;
    }
    if (!validSkillName(name)) {
      warnings.push(`skill "${name}" is not a valid skill name (lowercase letters, digits, single hyphens); not granted`);
      continue;
    }
    if ((SPARROW_SKILLS as readonly string[]).includes(name)) continue; // always on
    const path = join(lib, name);
    if (!hasSkillMd(path)) {
      warnings.push(`skill "${name}" is not in the library (${lib}); not granted`);
      continue;
    }
    // The boundary is the REAL path: a library entry that is a symlink out of the library is not granted.
    const real = realOf(path);
    if (!libReal || !real || !(real === libReal || real.startsWith(libReal + sep))) {
      warnings.push(`skill "${name}" resolves outside the library (${real ?? path}); not granted`);
      continue;
    }
    grants.push({ name, path });
  }
  return { grants: withSparrow(grants), warnings, requested: [...(names ?? [])] };
}

// ---- snapshot: <agentDir>/skills.json
export const snapshotPath = (agentId: string) => join(agentDir(agentId), 'skills.json');

export function writeSnapshot(agentId: string, res: GrantResult): void {
  writeAtomic(snapshotPath(agentId), JSON.stringify({ grants: res.grants, warnings: res.warnings, requested: res.requested ?? [] }, null, 2) + '\n');
}

export function readSnapshot(agentId: string): GrantResult | null {
  try {
    const d = JSON.parse(readFileSync(snapshotPath(agentId), 'utf8'));
    if (!Array.isArray(d?.grants)) return null;
    const grants = d.grants.filter((g: any) => g && typeof g.name === 'string' && typeof g.path === 'string' && isAbsolute(g.path));
    const requested = Array.isArray(d.requested) ? d.requested.filter((n: unknown) => typeof n === 'string') : undefined;
    return { grants, warnings: Array.isArray(d.warnings) ? d.warnings.map(String) : [], ...(requested ? { requested } : {}) };
  } catch {
    return null;
  }
}

/**
 * What a call start grants: the stored snapshot, else computed from the current resume (agents hired before this
 * feature). Names the resume asked for at hire/apply that were not in the library then are resolved again, so a skill
 * imported after the hire is picked up; resume EDITS still wait for Apply (the requested list is the snapshot's).
 */
export function grantsFor(agentId: string, resumeSkills: string[] | undefined): SkillGrant[] {
  const snap = readSnapshot(agentId);
  if (!snap) return resolveGrants(resumeSkills).grants;
  const have = new Set(snap.grants.map((g) => g.name));
  const late = (snap.requested ?? []).filter((n) => !have.has(n));
  return late.length ? [...snap.grants, ...resolveGrants(late).grants.filter((g) => !have.has(g.name))] : snap.grants;
}

// ---- materialisation
/**
 * Make `dir` hold exactly `<grant.name>` → `<grant.path>` symlinks. Only symlinks are ever removed (a real file or
 * folder in there, e.g. Codex's `.system`, is left alone). A grant whose name is taken by a real entry is skipped.
 * Returns the names linked.
 */
export function materializeLinks(dir: string, grants: SkillGrant[]): string[] {
  mkdirSync(dir, { recursive: true });
  const want = new Map(usableGrants(grants).map((g) => [g.name, g.path]));
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    if (want.get(entry) === readlinkSync(p)) continue;
    unlinkSync(p);
  }
  const linked: string[] = [];
  for (const [name, target] of want) {
    const p = join(dir, name);
    if (existsSync(p) || isLink(p)) {
      if (isLink(p) && readlinkSync(p) === target) linked.push(name);
      continue;
    }
    symlinkSync(target, p, 'dir');
    linked.push(name);
  }
  return linked;
}
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The `name:` of a SKILL.md frontmatter (what OpenCode keys skills by); the folder name when unreadable. */
export function frontmatterName(skillDir: string, fallback: string): string {
  try {
    const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    const Y = (globalThis as any).Bun?.YAML;
    if (Y?.parse) {
      try {
        const n = Y.parse(fm)?.name;
        if (typeof n === 'string' && n.trim()) return n.trim();
      } catch {}
    }
    const m = fm.match(/^name:\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch {}
  return fallback;
}
