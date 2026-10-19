import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { adopt } from '../../src/skills/adopt';
import { folderHash } from '../../src/skills/hash';
import { readManifest } from '../../src/skills/manifest';
import { makeSkill, sandbox } from './helpers';

test('adopt copies, verifies, backs up, and links an unmanaged harness skill', () => {
  const { paths } = sandbox();
  const source = makeSkill(join(paths.roots.claude, 'adopt-me'), 'adopt-me', 'Keep all bytes.\n');
  const beforeHash = folderHash(source);
  const result = adopt(source, undefined, paths);
  expect(result.skill.root).toBe('library');
  expect(result.skill.folderHash).toBe(beforeHash);
  expect(result.backup).not.toBeNull();
  expect(lstatSync(source).isSymbolicLink()).toBe(true);
  expect(readlinkSync(source)).toBe(join(paths.library, 'adopt-me'));
  expect(folderHash(join(paths.library, 'adopt-me'))).toBe(beforeHash);
  expect(existsSync(join(result.backup!, 'SKILL.md'))).toBe(true);
  expect(readManifest(paths.library).skills['adopt-me']?.harnesses).toEqual(['claude']);
});

test('adopting an External skill copies only and defaults to no managed harness links', () => {
  const { paths } = sandbox();
  const source = makeSkill(join(paths.roots.agents, 'external-one'), 'external-one', 'External stays put.\n');
  const beforeHash = folderHash(source);
  const result = adopt(source, undefined, paths);
  expect(result.copiedOnly).toBe(true);
  expect(result.backup).toBeNull();
  expect(lstatSync(source).isDirectory()).toBe(true);
  expect(folderHash(source)).toBe(beforeHash);
  expect(folderHash(join(paths.library, 'external-one'))).toBe(beforeHash);
  expect(readManifest(paths.library).skills['external-one']?.harnesses).toEqual([]);
});

test('adopt rejects unscanned and non-skill folders before copying into the library', () => {
  const { root, paths } = sandbox();
  const outside = makeSkill(join(root, 'outside'), 'outside');
  expect(() => adopt(outside, undefined, paths)).toThrow('not a scanned skill entry');
  const noSkill = join(paths.roots.claude, 'not-a-skill');
  mkdirSync(noSkill, { recursive: true });
  writeFileSync(join(noSkill, 'notes.txt'), 'not a skill');
  expect(() => adopt(noSkill, undefined, paths)).toThrow('not a scanned skill entry');
  expect(existsSync(join(paths.library, 'outside'))).toBe(false);
  expect(existsSync(join(paths.library, 'not-a-skill'))).toBe(false);
});

test('adopt restores the original folder and manifest bytes when validation fails after moving it', () => {
  const { paths } = sandbox();
  const source = makeSkill(join(paths.roots.claude, 'adopt-failure'), 'adopt-failure', 'Preserve me.\n');
  const sourceBytes = readFileSync(join(source, 'SKILL.md'));
  const manifestBytes = Buffer.from('{ invalid manifest\n');
  mkdirSync(paths.library, { recursive: true });
  writeFileSync(join(paths.library, 'skills.json'), manifestBytes);

  expect(() => adopt(source, undefined, paths)).toThrow();
  expect(lstatSync(source).isDirectory()).toBe(true);
  expect(readFileSync(join(source, 'SKILL.md'))).toEqual(sourceBytes);
  expect(existsSync(join(paths.library, 'adopt-failure'))).toBe(false);
  expect(readFileSync(join(paths.library, 'skills.json'))).toEqual(manifestBytes);
});

