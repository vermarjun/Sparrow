// Compiled-mode asset materialisation: atomic, idempotent, version/build aware, safe for concurrent starts.
import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureShim, MARKER, materialize } from '../../src/shared/app';
import { tempDir } from '../cli/helpers';

function source(files: Record<string, string>): Record<string, string> {
  const dir = tempDir('app-src-');
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel.replace(/\//g, '_'));
    writeFileSync(p, text);
    out[rel] = p;
  }
  return out;
}
const list = (dir: string) => readdirSync(dir).sort();

describe('materialize', () => {
  test('writes every file under dest with a marker, creating parents', async () => {
    const dest = join(tempDir('app-'), 'app', '1.0.0');
    const wrote = await materialize(source({ 'assets/a.md': 'A', 'assets/sub/b.md': 'B', 'web/index.html': '<html>' }), dest, 'build1');
    expect(wrote).toBe(true);
    expect(readFileSync(join(dest, 'assets/a.md'), 'utf8')).toBe('A');
    expect(readFileSync(join(dest, 'assets/sub/b.md'), 'utf8')).toBe('B');
    expect(readFileSync(join(dest, 'web/index.html'), 'utf8')).toBe('<html>');
    expect(readFileSync(join(dest, MARKER), 'utf8')).toBe('build1');
    expect(list(join(dest, '..'))).toEqual(['1.0.0']);   // no temp dir left behind
  });

  test('is idempotent: a second call with the same build touches nothing', async () => {
    const dest = join(tempDir('app-'), '1.0.0');
    const files = source({ 'assets/a.md': 'A' });
    await materialize(files, dest, 'b');
    const m1 = statSync(join(dest, 'assets/a.md')).mtimeMs;
    await Bun.sleep(15);
    expect(await materialize(files, dest, 'b')).toBe(false);
    expect(statSync(join(dest, 'assets/a.md')).mtimeMs).toBe(m1);
  });

  test('a new version lands in its own dir and leaves the old one alone', async () => {
    const root = tempDir('app-');
    await materialize(source({ 'assets/a.md': 'old' }), join(root, '1.0.0'), 'b1');
    await materialize(source({ 'assets/a.md': 'new' }), join(root, '1.1.0'), 'b2');
    expect(readFileSync(join(root, '1.0.0/assets/a.md'), 'utf8')).toBe('old');
    expect(readFileSync(join(root, '1.1.0/assets/a.md'), 'utf8')).toBe('new');
    expect(list(root)).toEqual(['1.0.0', '1.1.0']);
  });

  test('the same version rebuilt (different build id) replaces the tree and drops stale files', async () => {
    const root = tempDir('app-');
    const dest = join(root, '1.0.0');
    await materialize(source({ 'assets/a.md': 'v1', 'assets/gone.md': 'x' }), dest, 'b1');
    expect(await materialize(source({ 'assets/a.md': 'v2' }), dest, 'b2')).toBe(true);
    expect(readFileSync(join(dest, 'assets/a.md'), 'utf8')).toBe('v2');
    expect(existsSync(join(dest, 'assets/gone.md'))).toBe(false);
    expect(list(root)).toEqual(['1.0.0']);   // the aside copy is cleaned up
  });

  test('a half-written tree is never visible at dest: a failing source leaves dest absent and no temp dir', async () => {
    const root = tempDir('app-');
    const dest = join(root, '1.0.0');
    const files = { ...source({ 'assets/a.md': 'A' }), 'assets/missing.md': join(root, 'does-not-exist') };
    await expect(materialize(files, dest, 'b')).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(list(root)).toEqual([]);
  });

  test('concurrent starts are safe: all resolve, one complete tree, no leftovers', async () => {
    const root = tempDir('app-');
    const dest = join(root, 'app', '1.0.0');
    const files = source(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`assets/f${i}.md`, `file ${i}`])));
    const results = await Promise.all(Array.from({ length: 6 }, () => materialize(files, dest, 'same')));
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(dest, MARKER), 'utf8')).toBe('same');
    expect(list(join(dest, 'assets'))).toHaveLength(30);
    expect(list(join(root, 'app'))).toEqual(['1.0.0']);
  });
});

describe('ensureShim', () => {
  test('links <dest>/bin/sparrow to the binary, idempotently and following a moved binary', () => {
    const dest = tempDir('shim-');
    ensureShim(dest, '/opt/a/sparrow-darwin-arm64');
    expect(readlinkSync(join(dest, 'bin', 'sparrow'))).toBe('/opt/a/sparrow-darwin-arm64');
    ensureShim(dest, '/opt/a/sparrow-darwin-arm64');
    ensureShim(dest, '/opt/b/sparrow');
    expect(readlinkSync(join(dest, 'bin', 'sparrow'))).toBe('/opt/b/sparrow');
    expect(lstatSync(join(dest, 'bin', 'sparrow')).isSymbolicLink()).toBe(true);
    expect(list(join(dest, 'bin'))).toEqual(['sparrow']);
  });
});
