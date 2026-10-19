import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { validateFrontmatter } from './frontmatter';
import { ensureLibrary } from './git';
import { readManifest, writeManifest } from './manifest';
import { assertWritable, skillPaths } from './paths';
import { sync as syncLinks } from './link';
import { isReservedSkillName, SkillImportError, validateHarnesses } from './importer';
import type { Harness, SkillPaths } from './types';

export interface CreatedSkill {
  name: string;
  description: string;
  harnesses: Harness[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function existsIncludingDangling(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export function createSkill(
  nameValue: unknown, descriptionValue: unknown, harnessValue: unknown, paths: SkillPaths = skillPaths(),
): { skill: CreatedSkill; actions: unknown[]; conflicts: unknown[] } {
  if (typeof nameValue !== 'string') throw new SkillImportError('name must be a string.');
  const name = nameValue.trim();
  if (name.length < 1 || name.length > 64 || !NAME_RE.test(name)) {
    throw new SkillImportError('name must be 1–64 lowercase letters or digits separated by single hyphens.');
  }
  if (isReservedSkillName(name)) throw new SkillImportError('name is reserved for a built-in Sparrow skill.');
  if (typeof descriptionValue !== 'string') throw new SkillImportError('description must be a string.');
  const description = descriptionValue.trim();
  if (description.length < 1 || description.length > 1024) {
    throw new SkillImportError('description must be 1–1024 characters.');
  }
  const harnesses = validateHarnesses(harnessValue);
  const frontmatter = { name, description };
  const problems = validateFrontmatter(frontmatter, name);
  if (problems.length) throw new SkillImportError(problems.map((problem) => problem.message).join('; '));

  const manifest = readManifest(paths.library);
  const target = join(paths.library, name);
  if (existsIncludingDangling(target) || manifest.skills[name]) {
    throw new SkillImportError('Skill "' + name + '" already exists in the library.', 409);
  }
  ensureLibrary(paths);
  const currentManifest = readManifest(paths.library);
  if (existsIncludingDangling(target) || currentManifest.skills[name]) {
    throw new SkillImportError('Skill "' + name + '" already exists in the library.', 409);
  }

  const temp = assertWritable(join(paths.library, '.' + name + '.create-' + randomUUID()), paths);
  const skillMd = [
    '---',
    'name: ' + name,
    'description: ' + JSON.stringify(description),
    '---',
    '',
    '# ' + name,
    '',
    '<!-- Add focused instructions for this skill. -->',
    '',
  ].join('\n');
  try {
    mkdirSync(temp, { recursive: false });
    const skillMdPath = assertWritable(join(temp, 'SKILL.md'), paths);
    writeFileSync(skillMdPath, skillMd, { mode: 0o644, flag: 'wx' });
    renameSync(assertWritable(temp, paths), assertWritable(target, paths));
    currentManifest.skills[name] = { harnesses };
    writeManifest(currentManifest, paths.library, paths);
  } catch (error) {
    try {
      if (existsIncludingDangling(temp)) rmSync(assertWritable(temp, paths), { recursive: true, force: true });
      if (existsIncludingDangling(target) && !currentManifest.skills[name]) rmSync(assertWritable(target, paths), { recursive: true, force: true });
    } catch {}
    throw error;
  }
  const linked = syncLinks(paths);
  return { skill: { name, description, harnesses }, actions: linked.actions, conflicts: linked.conflicts };
}
