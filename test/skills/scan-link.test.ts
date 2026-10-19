import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { apply, diff, plan, sync, unmanage } from '../../src/skills/link';
import { readManifest, writeManifest } from '../../src/skills/manifest';
import { scanSkills } from '../../src/skills/scan';
import { folderHash } from '../../src/skills/hash';
import type { SkillsManifest } from '../../src/skills/types';
import { makeSkill, makeSymlink, sandbox } from './helpers';

test('scan classifies library, Sparrow, external, unmanaged, conflict, and broken entries', () => {
  const { root, paths } = sandbox();
  const library = makeSkill(join(paths.library, 'managed'), 'managed');
  const cl = paths.roots.claude;
  const codex = paths.roots.codex;
  const agents = paths.roots.agents;
  const synced = paths.roots['claude-synced'];
  writeManifest({ version: 1, skills: { managed: { harnesses: ['claude'] }, conflict: { harnesses: ['codex'] } } }, paths.library, paths);
  makeSymlink(library, join(cl, 'managed'));
  makeSkill(join(cl, 'unmanaged'), 'unmanaged');
  makeSkill(join(paths.library, 'conflict'), 'conflict', 'Canonical.\n');
  makeSkill(join(codex, 'conflict'), 'conflict', 'Different.\n');
  makeSymlink(join(root, 'missing-target'), join(cl, 'broken'));
  makeSkill(join(agents, 'external-skill'), 'external-skill');
  makeSkill(join(synced, 'bucket-a', 'synced-skill'), 'synced-skill');
  makeSkill(join(paths.roots.opencode, 'opencode-skill'), 'opencode-skill');
  const outside = makeSkill(join(root, 'external-target'), 'brew-skill');
  makeSymlink(outside, join(cl, 'brew-skill'));
  const toolOwned = makeSkill(join(paths.home, '.local', 'share', 'terminal-browser', 'app', 'skills', 'codex', 'terminal-browser'), 'terminal-browser');
  makeSymlink(toolOwned, join(codex, 'terminal-browser'));

  const entries = scanSkills(paths);
  const find = (name: string, rootName: string) => entries.find((e) => e.name === name && e.root === rootName)!;
  expect(find('managed', 'library').status).toBe('managed');
  expect(find('managed', 'claude').status).toBe('managed');
  expect(find('unmanaged', 'claude').status).toBe('unmanaged');
  expect(find('conflict', 'codex').status).toBe('conflict');
  expect(find('conflict', 'codex').conflict).toBe('diff');
  expect(find('broken', 'claude').status).toBe('broken');
  expect(find('external-skill', 'agents').status).toBe('external');
  expect(find('synced-skill', 'claude-synced').status).toBe('external');
  expect(find('brew-skill', 'claude').status).toBe('external');
  expect(find('terminal-browser', 'codex').status).toBe('external');
  expect(entries.some((e) => e.root === 'sparrow' && e.status === 'sparrow')).toBe(true);
});

test('sync creates a missing library link and never overwrites a real folder or foreign link', () => {
  const { root, paths } = sandbox();
  makeSkill(join(paths.library, 'safe-skill'), 'safe-skill', 'Library copy.\n');
  writeManifest({ version: 1, skills: { 'safe-skill': { harnesses: ['claude', 'codex', 'opencode'] } } }, paths.library, paths);
  makeSkill(join(paths.roots.claude, 'safe-skill'), 'safe-skill', 'User folder.\n');
  const foreign = makeSkill(join(root, 'foreign'), 'safe-skill', 'Foreign link.\n');
  makeSymlink(foreign, join(paths.roots.codex, 'safe-skill'));

  const actions = plan(readManifest(paths.library), scanSkills(paths), paths);
  const beforeReal = readFileSync(join(paths.roots.claude, 'safe-skill', 'SKILL.md'), 'utf8');
  const beforeLink = readlinkSync(join(paths.roots.codex, 'safe-skill'));
  const conflicts = apply(actions, paths);
  expect(conflicts.map((action) => action.type)).toEqual(['conflict', 'conflict']);
  expect(readFileSync(join(paths.roots.claude, 'safe-skill', 'SKILL.md'), 'utf8')).toBe(beforeReal);
  expect(readlinkSync(join(paths.roots.codex, 'safe-skill'))).toBe(beforeLink);
  expect(readlinkSync(join(paths.roots.opencode, 'safe-skill'))).toBe(join(paths.library, 'safe-skill'));

  const result = sync(paths);
  expect(result.actions.some((action) => action.type === 'create')).toBe(false);
  expect(result.conflicts).toHaveLength(2);
});

test('sync reports invalid manifest names and continues linking later valid skills', () => {
  const { root, paths } = sandbox();
  makeSkill(join(paths.library, 'good-a'), 'good-a');
  makeSkill(join(paths.library, 'zzz-good'), 'zzz-good');
  writeManifest({
    version: 1,
    skills: {
      'good-a': { harnesses: ['claude'] },
      '../../escape': { harnesses: ['claude'] },
      'zzz-good': { harnesses: ['codex'] },
    },
  }, paths.library, paths);
  const result = sync(paths);
  expect(result.conflicts).toHaveLength(1);
  const invalid = result.conflicts[0];
  expect(invalid?.type).toBe('conflict');
  if (invalid?.type === 'conflict') expect(invalid.reason).toContain('invalid skill name');
  expect(readlinkSync(join(paths.roots.claude, 'good-a'))).toBe(join(paths.library, 'good-a'));
  expect(readlinkSync(join(paths.roots.codex, 'zzz-good'))).toBe(join(paths.library, 'zzz-good'));
  expect(existsSync(join(root, 'escape'))).toBe(false);
});

test('link diff returns unified text and unmanage turns only owned links into verified copies', () => {
  const { paths } = sandbox();
  const source = makeSkill(join(paths.library, 'diff-skill'), 'diff-skill', 'Library line.\n');
  const other = makeSkill(join(paths.roots.claude, 'diff-skill'), 'diff-skill', 'Other line.\n');
  const patch = diff(source, other);
  expect(patch).toContain('Library line.');
  expect(patch).toContain('Other line.');

  writeManifest({ version: 1, skills: { 'diff-skill': { harnesses: ['claude'] } } }, paths.library, paths);
  const owned = join(paths.roots.claude, 'owned');
  makeSkill(join(paths.library, 'owned'), 'owned');
  writeManifest({ version: 1, skills: { 'diff-skill': { harnesses: [] }, owned: { harnesses: ['claude'] } } }, paths.library, paths);
  makeSymlink(join(paths.library, 'owned'), owned);
  expect(unmanage('owned', paths)).toEqual([owned]);
  expect(existsSync(owned)).toBe(true);
  expect(lstatSync(owned).isSymbolicLink()).toBe(false);
  expect(folderHash(owned)).toBe(folderHash(join(paths.library, 'owned')));
  expect(readManifest(paths.library).skills.owned?.harnesses).toEqual([]);
});

test('Sparrow skill copies in harness roots are locked (status sparrow), not Unmanaged, and cannot be adopted', async () => {
  const { adopt } = await import('../../src/skills/adopt');
  const { paths } = sandbox();
  const copy = makeSkill(join(paths.roots.claude, 'sparrow-worker'), 'sparrow-worker');
  makeSkill(join(paths.roots.codex, 'sparrow-captain'), 'sparrow-captain');
  const entries = scanSkills(paths).filter((e) => e.root === 'claude' || e.root === 'codex');
  expect(entries.map((e) => [e.name, e.status]).sort()).toEqual([['sparrow-captain', 'sparrow'], ['sparrow-worker', 'sparrow']]);
  expect(() => adopt(copy, ['claude'], paths)).toThrow();
  expect(existsSync(join(paths.library, 'sparrow-worker'))).toBe(false);
  expect(lstatSync(copy).isSymbolicLink()).toBe(false);
});

test('scan lists only SKILL.md folders: the library .git and non-skill folders are skipped', () => {
  const { paths } = sandbox();
  makeSkill(join(paths.library, 'alpha'), 'alpha');
  Bun.spawnSync(['git', 'init', '-q', paths.library]);
  makeSkill(join(paths.roots.agents, 'not-a-skill', 'nested'), 'nested'); // no SKILL.md at the entry itself
  const names = scanSkills(paths).map((e) => `${e.root}:${e.name}`);
  expect(names).toContain('library:alpha');
  expect(names.some((n) => n.endsWith(':.git') || n.endsWith(':not-a-skill'))).toBe(false);
});
