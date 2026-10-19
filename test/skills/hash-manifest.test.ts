import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { cachedFolderHash, folderHash, hashCacheStats } from '../../src/skills/hash';
import { scanSkills } from '../../src/skills/scan';
import { readManifest, writeManifest } from '../../src/skills/manifest';
import { makeSkill, sandbox } from './helpers';

test('folderHash matches Vercel computeSkillFolderHash for the checked reference fixture', () => {
  const { root } = sandbox();
  const folder = join(root, 'hash-reference');
  mkdirSync(join(folder, 'sub'), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: hash-reference\ndescription: Hash compatibility fixture.\n---\nBody\n');
  writeFileSync(join(folder, 'metadata.json'), '{"key":"value"}\n');
  writeFileSync(join(folder, 'ref.txt'), 'refs\n');
  writeFileSync(join(folder, 'sub', 'SKILL.md'), 'Nested skill.\n');
  expect(folderHash(folder)).toBe('0873be87e76ee1f8329aeeeaf94cb7c4d282e4008baf035691eb8bb6d0cc18c7');
});

test('folderHash skips nested symlinks and excludes .git and node_modules like Vercel', () => {
  const { root } = sandbox();
  const folder = join(root, 'hash-symlinks');
  const outside = join(root, 'outside');
  mkdirSync(join(folder, '.git'), { recursive: true });
  mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(folder, 'a.txt'), 'a');
  writeFileSync(join(folder, '.git', 'hidden'), 'git');
  writeFileSync(join(folder, 'node_modules', 'x', 'hidden'), 'module');
  writeFileSync(join(outside, 'outside.txt'), 'outside');
  const expected = folderHash(folder);
  symlinkSync(join(outside, 'outside.txt'), join(folder, 'link.txt'));
  symlinkSync(outside, join(folder, 'link-dir'), 'dir');
  expect(folderHash(folder)).toBe(expected);
});

test('manifest preserves unknown fields and writes keys in stable order atomically', () => {
  const { paths } = sandbox();
  mkdirSync(paths.library, { recursive: true });
  writeFileSync(join(paths.library, 'skills.json'), JSON.stringify({
    unknown: { z: 1, a: 2 }, skills: { zed: { unknownEntry: true, harnesses: ['claude'], source: { updatedAt: 'now', source: 'example' } }, alpha: { harnesses: [] } }, version: 1,
  }));
  const manifest = readManifest(paths.library);
  writeManifest(manifest, paths.library, paths);
  const first = readFileSync(join(paths.library, 'skills.json'), 'utf8');
  expect(first.indexOf('"version"')).toBeLessThan(first.indexOf('"skills"'));
  expect(first.indexOf('"alpha"')).toBeLessThan(first.indexOf('"zed"'));
  expect(readManifest(paths.library).unknown).toEqual({ a: 2, z: 1 });
  writeManifest(readManifest(paths.library), paths.library, paths);
  expect(readFileSync(join(paths.library, 'skills.json'), 'utf8')).toBe(first);
});

test('cachedFolderHash equals folderHash, reads a folder once, and never serves a stale hash', () => {
  const { root } = sandbox();
  const folder = join(root, 'cached');
  mkdirSync(join(folder, 'sub'), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), 'aaaa');
  writeFileSync(join(folder, 'sub', 'x.txt'), 'x');
  const start = { ...hashCacheStats };
  const first = cachedFolderHash(folder);
  expect(first).toBe(folderHash(folder));
  expect(cachedFolderHash(folder)).toBe(first);
  expect(hashCacheStats.misses - start.misses).toBe(1);
  expect(hashCacheStats.hits - start.hits).toBe(1);

  // same size, same mtime: only the ctime/inode can tell (utimes sets mtime back by hand)
  const mtime = new Date(Bun.file(join(folder, 'SKILL.md')).lastModified);
  writeFileSync(join(folder, 'SKILL.md'), 'bbbb');
  utimesSync(join(folder, 'SKILL.md'), mtime, mtime);
  expect(cachedFolderHash(folder)).toBe(folderHash(folder));
  expect(cachedFolderHash(folder)).not.toBe(first);

  const edited = cachedFolderHash(folder);
  writeFileSync(join(folder, 'sub', 'y.txt'), 'new file');            // added
  const added = cachedFolderHash(folder);
  expect(added).not.toBe(edited);
  renameSync(join(folder, 'sub', 'y.txt'), join(folder, 'sub', 'z.txt')); // renamed
  const renamed = cachedFolderHash(folder);
  expect(renamed).not.toBe(added);
  rmSync(join(folder, 'sub', 'z.txt'));                                // removed
  expect(cachedFolderHash(folder)).toBe(edited);
  chmodSync(join(folder, 'SKILL.md'), 0o755);                         // mode only: hash (paths + bytes) is unchanged
  expect(cachedFolderHash(folder)).toBe(edited);
});

test('scanSkills reads each skill folder once across requests and sees a SKILL.md edit on the next scan', () => {
  const { paths } = sandbox();
  for (const name of ['alpha', 'beta', 'gamma']) makeSkill(join(paths.library, name), name, `${name} body\n`);
  const hashes = () => Object.fromEntries(scanSkills(paths).filter((e) => e.root === 'library').map((e) => [e.name, e.folderHash]));
  const m0 = hashCacheStats.misses;
  const first = hashes();
  expect(hashCacheStats.misses - m0).toBeGreaterThanOrEqual(3);        // the 3 new library skills (Sparrow's 2 may be warm from another test)
  const m1 = hashCacheStats.misses;
  expect(hashes()).toEqual(first);
  expect(hashCacheStats.misses - m1).toBe(0);                          // second request: nothing re-read
  writeFileSync(join(paths.library, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: A test skill description.\n---\nchanged\n');
  const after = hashes();
  expect(after.beta).not.toBe(first.beta);
  expect(after.alpha).toBe(first.alpha);
  expect(after.beta).toBe(folderHash(join(paths.library, 'beta')));
});
