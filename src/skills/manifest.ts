import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validSkillName } from './frontmatter';
import { assertWritable, skillPaths } from './paths';
import type { SkillPaths, SkillsManifest } from './types';

export function emptyManifest(): SkillsManifest {
  return { version: 1, skills: {} };
}

export function readManifest(libraryDir = skillPaths().library): SkillsManifest {
  const file = join(libraryDir, 'skills.json');
  if (!existsSync(file)) return emptyManifest();
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const skills = parsed.skills && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)
    ? parsed.skills as SkillsManifest['skills'] : {};
  return { ...parsed, version: typeof parsed.version === 'number' ? parsed.version : 1, skills };
}

/** Invalid manifest keys are retained for round-tripping, but callers can surface and skip them safely. */
export function invalidManifestNames(manifest: SkillsManifest): string[] {
  return Object.keys(manifest.skills).filter((name) => !validSkillName(name));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort((a, b) => a.localeCompare(b));
  if ('version' in object && 'skills' in object) {
    const preferred = ['version', 'skills'];
    keys.sort((a, b) => {
      const ai = preferred.indexOf(a), bi = preferred.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      return a.localeCompare(b);
    });
  }
  return Object.fromEntries(keys.map((key) => [key, stable(object[key])]));
}

export function writeManifest(manifest: SkillsManifest, libraryDir = skillPaths().library, paths: SkillPaths = skillPaths()): string {
  const dir = assertWritable(libraryDir, paths);
  mkdirSync(dir, { recursive: true });
  const file = assertWritable(join(dir, 'skills.json'), paths);
  try {
    const existing = lstatSync(file);
    if (existing.isSymbolicLink()) throw new Error(`Refusing symlinked skills manifest: ${file}`);
    if (!existing.isFile()) throw new Error(`Skills manifest is not a regular file: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = assertWritable(join(dir, `.skills.json.${process.pid}.${randomUUID()}.tmp`), paths);
  try {
    writeFileSync(temp, `${JSON.stringify(stable(manifest), null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    try { if (existsSync(temp)) { assertWritable(temp, paths); unlinkSync(temp); } } catch {}
    throw error;
  }
  return file;
}
