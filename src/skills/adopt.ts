import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { folderHash } from './hash';
import { readManifest, writeManifest } from './manifest';
import { assertWritable, skillPaths } from './paths';
import { scanSkills } from './scan';
import { isReservedSkillName, validSkillName } from './frontmatter';
import { apply, plan } from './link';
import type { Harness, SkillEntry, SkillPaths, SkillRoot } from './types';

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function rootOf(path: string, paths: SkillPaths): SkillEntry['root'] | 'adopted' {
  const roots: SkillRoot[] = ['library', 'claude', 'codex', 'opencode', 'agents', 'claude-synced', 'sparrow'];
  roots.sort((a, b) => paths.roots[b].length - paths.roots[a].length);
  for (const root of roots) {
    if (inside(path, paths.roots[root])) return root;
  }
  return 'adopted';
}

export interface AdoptResult {
  skill: SkillEntry;
  backup: string | null;
  copiedOnly: boolean;
}

export function adopt(entryPath: string, harnesses?: Harness[], paths: SkillPaths = skillPaths()): AdoptResult {
  const entry = scanSkills(paths).find((item) => resolve(item.path) === resolve(entryPath));
  if (!entry) throw new Error(`Adopt source is not a scanned skill entry: ${entryPath}`);
  if (entry.status !== 'unmanaged' && entry.status !== 'external') throw new Error(`Cannot adopt ${entry.name} while it is ${entry.status}`);
  const name = entry.name;
  if (isReservedSkillName(name)) throw new Error(`${name} is a built-in Sparrow skill (installed by sparrow install); it cannot be adopted`);
  if (!validSkillName(name)) throw new Error(`Invalid skill name "${name}"; expected lowercase letters, digits, and single hyphens (1–64 characters)`);
  const source = entry.resolvedTarget;
  if (!source || !existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`Skill folder is missing: ${entryPath}`);
  const skillMd = join(source, 'SKILL.md');
  let skillStat;
  try { skillStat = lstatSync(skillMd); } catch { throw new Error(`Skill is missing a regular SKILL.md: ${entryPath}`); }
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) throw new Error(`Skill is missing a regular SKILL.md: ${entryPath}`);
  const external = entry.status === 'external';
  // The harness entry is the mutation target for normal adoption. External entries are read-only sources.
  if (!external) assertWritable(entry.path, paths);
  const sourceHash = folderHash(source);
  const destination = join(paths.library, name);
  try { lstatSync(destination); throw new Error(`Library already contains a skill named ${name}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const sourceRoot = rootOf(entry.path, paths);
  const chosenHarnesses = external && harnesses === undefined
    ? [] : harnesses ?? (sourceRoot === 'claude' || sourceRoot === 'codex' || sourceRoot === 'opencode' ? [sourceRoot] : []);
  const temp = assertWritable(join(paths.library, `.${name}.${randomUUID()}.adopt-tmp`), paths);
  const target = assertWritable(destination, paths);
  const backupPath = external ? null : assertWritable(join(paths.backup, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`, sourceRoot, name), paths);
  const manifestFile = join(paths.library, 'skills.json');
  let previousManifest: Buffer | null = null;
  try {
    const manifestStat = lstatSync(manifestFile);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error(`Skills manifest is not a regular file: ${manifestFile}`);
    previousManifest = readFileSync(manifestFile);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const actionSnapshots: { path: string; target: string | null }[] = [];
  let moved = false;
  let linked = false;
  let copied = false;
  let manifestChanged = false;
  let actionPaths: string[] = [];
  try {
    mkdirSync(assertWritable(paths.library, paths), { recursive: true });
    cpSync(source, temp, { recursive: true, dereference: false, errorOnExist: true, force: false });
    if (folderHash(temp) !== sourceHash) throw new Error(`Hash verification failed while adopting ${name}`);
    renameSync(temp, target);
    copied = true;

    if (!external) {
      const original = assertWritable(entry.path, paths);
      const backup = backupPath!;
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(original, backup);
      moved = true;
      symlinkSync(target, original, 'dir');
      linked = true;
    }
    const manifest = readManifest(paths.library);
    manifest.skills[name] = { ...(manifest.skills[name] ?? {}), harnesses: chosenHarnesses };
    manifestChanged = true;
    writeManifest(manifest, paths.library, paths);
    if (chosenHarnesses.length) {
      const actions = plan(manifest, scanSkills(paths), paths);
      actionPaths = actions.filter((action) => action.name === name && action.type !== 'conflict').map((action) => action.path);
      for (const path of actionPaths) {
        try {
          const stat = lstatSync(path);
          actionSnapshots.push({ path, target: stat.isSymbolicLink() ? readlinkSync(path) : null });
        } catch { actionSnapshots.push({ path, target: null }); }
      }
      apply(actions, paths);
    }
    const adopted = scanSkills(paths).find((item) => item.root === 'library' && item.name === name);
    if (!adopted) throw new Error(`Adopted skill is missing from the library scan: ${name}`);
    return { skill: adopted, backup: backupPath, copiedOnly: external };
  } catch (error) {
    const rollbackErrors: string[] = [];
    const undo = (label: string, operation: () => void) => {
      try { operation(); } catch (rollbackError) { rollbackErrors.push(`${label}: ${(rollbackError as Error).message}`); }
    };
    for (const item of actionSnapshots.reverse()) {
      undo(`restore harness link ${item.path}`, () => {
        let current: ReturnType<typeof lstatSync> | undefined;
        try { current = lstatSync(item.path); } catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
        if (current?.isSymbolicLink()) unlinkSync(assertWritable(item.path, paths));
        else if (current) throw new Error('link path was replaced by a real entry');
        if (item.target !== null) symlinkSync(item.target, assertWritable(item.path, paths), 'dir');
      });
    }
    if (linked) {
      undo(`remove adopted link ${entry.path}`, () => {
        const stat = lstatSync(entry.path);
        if (!stat.isSymbolicLink() || readlinkSync(entry.path) !== target) throw new Error('adopted link was replaced by another entry');
        unlinkSync(assertWritable(entry.path, paths));
      });
    }
    if (moved) {
      undo(`restore original ${entry.path}`, () => {
        try { lstatSync(entry.path); throw new Error('original path is occupied'); }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
        renameSync(assertWritable(backupPath!, paths), assertWritable(entry.path, paths));
        let directory = dirname(backupPath!);
        while (directory !== paths.backup && inside(directory, paths.backup)) {
          try { rmdirSync(directory); directory = dirname(directory); } catch { break; }
        }
      });
    }
    if (copied) {
      undo(`remove copied library folder ${target}`, () => {
        if (folderHash(target) !== sourceHash) throw new Error('library copy changed after creation; left in place');
        rmSync(assertWritable(target, paths), { recursive: true, force: true });
      });
    }
    undo(`remove temporary copy ${temp}`, () => rmSync(assertWritable(temp, paths), { recursive: true, force: true }));
    if (manifestChanged) {
      undo(`restore manifest ${manifestFile}`, () => {
        if (previousManifest === null) {
          try {
            const stat = lstatSync(manifestFile);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('manifest path was replaced by a non-file');
            unlinkSync(assertWritable(manifestFile, paths));
          } catch (manifestError) { if ((manifestError as NodeJS.ErrnoException).code !== 'ENOENT') throw manifestError; }
        } else {
          const restore = assertWritable(join(paths.library, `.skills.json.${randomUUID()}.rollback-tmp`), paths);
          try {
            writeFileSync(restore, previousManifest, { mode: 0o600, flag: 'wx' });
            renameSync(restore, assertWritable(manifestFile, paths));
          } catch (restoreError) {
            try { unlinkSync(restore); } catch {}
            throw restoreError;
          }
        }
      });
    }
    if (rollbackErrors.length) throw new Error(`Adopt failed: ${(error as Error).message}; rollback incomplete: ${rollbackErrors.join('; ')}`);
    throw error;
  }
}
