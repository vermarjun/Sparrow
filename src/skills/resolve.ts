import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { folderHash } from './hash';
import { readManifest, writeManifest } from './manifest';
import { assertLibrarySafe, assertWritable, realOrPlanned, skillPaths } from './paths';
import { scanSkills } from './scan';
import { validSkillName } from './frontmatter';
import type { Harness, SkillEntry, SkillPaths } from './types';

export interface ResolveResult {
  skill: SkillEntry;
  backup: string;
}

const HARNESSES: Harness[] = ['claude', 'codex', 'opencode'];

/**
 * Settle a `conflict` entry (a harness folder that shares its name with a library skill).
 * keep 'library': the entry is moved to the backup area and replaced by a link to the library copy.
 * keep 'entry':   the library copy is moved to the backup area, the entry's bytes become the library copy
 *                 (hash-verified) and the entry becomes a link. Nothing is ever deleted.
 */
export function resolveConflict(entryPath: string, keep: 'library' | 'entry', paths: SkillPaths = skillPaths()): ResolveResult {
  assertLibrarySafe(paths);
  const entry = scanSkills(paths).find((item) => resolve(item.path) === resolve(entryPath));
  if (!entry || entry.status !== 'conflict') throw new Error(`Not a conflicting skill entry: ${entryPath}`);
  // An entry that already is (or lives in) the library is not a second copy: there is nothing to resolve.
  const libraryReal = realOrPlanned(paths.library);
  const entryReal = entry.resolvedTarget ? realOrPlanned(entry.resolvedTarget) : null;
  if (entryReal && (entryReal === libraryReal || entryReal.startsWith(`${libraryReal}/`)) && keep === 'entry') {
    throw new Error(`Cannot resolve ${entryPath}: it points into the library itself, so it is not a separate copy`);
  }
  const root = entry.root as Harness;
  if (!HARNESSES.includes(root)) throw new Error(`Conflicts can only be resolved in a harness root: ${entryPath}`);
  const name = entry.name;
  if (!validSkillName(name)) throw new Error(`Invalid skill name "${name}"; cannot resolve this entry`);
  const libraryCopy = join(paths.library, name);
  if (!existsSync(libraryCopy)) throw new Error(`Library skill is missing: ${name}`);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupDir = join(paths.backup, stamp);
  const entryBackup = assertWritable(join(backupDir, root, name), paths);
  const libraryBackup = assertWritable(join(backupDir, 'library', name), paths);
  const original = assertWritable(entryPath, paths);
  let libraryMoved = false;
  let entryMoved = false;
  let linked = false;
  let temp: string | null = null;
  try {
    if (keep === 'entry') {
      const source = entry.resolvedTarget;
      if (!source || !lstatSync(source).isDirectory()) throw new Error(`Entry folder is missing: ${entryPath}`);
      const expected = folderHash(source);
      temp = assertWritable(join(paths.library, `.${name}.${process.pid}.resolve-tmp`), paths);
      cpSync(source, temp, { recursive: true, dereference: false, errorOnExist: true, force: false });
      if (folderHash(temp) !== expected) throw new Error(`Hash verification failed while resolving ${name}`);
      mkdirSync(dirname(libraryBackup), { recursive: true });
      renameSync(assertWritable(libraryCopy, paths), libraryBackup);
      libraryMoved = true;
      renameSync(temp, libraryCopy);
      temp = null;
    }
    mkdirSync(dirname(entryBackup), { recursive: true });
    renameSync(original, entryBackup);
    entryMoved = true;
    symlinkSync(libraryCopy, original, 'dir');
    linked = true;
    const manifest = readManifest(paths.library);
    const item = manifest.skills[name] ?? { harnesses: [] };
    item.harnesses = [...new Set([...item.harnesses, root])];
    manifest.skills[name] = item;
    writeManifest(manifest, paths.library, paths);
  } catch (error) {
    if (linked) unlinkSync(original);
    if (entryMoved) renameSync(entryBackup, original);
    if (libraryMoved) {
      try { lstatSync(libraryCopy); renameSync(libraryCopy, join(paths.library, `.${name}.${process.pid}.failed-tmp`)); } catch {}
      renameSync(libraryBackup, libraryCopy);
    }
    throw error;
  }
  const skill = scanSkills(paths).find((item) => item.root === 'library' && item.name === name);
  if (!skill) throw new Error(`Resolved skill is missing from the library scan: ${name}`);
  return { skill, backup: backupDir };
}

