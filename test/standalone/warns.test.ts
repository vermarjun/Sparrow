// Verifier WARN fixes: race-safe first-run link, uninstall never materialises, old app versions pruned, bad harness overrides reported.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkAtomic } from '../../src/cli/install';
import { loginFound } from '../../src/cli/setup';
import { overrideProblem, resetHarnessCache } from '../../src/harness/discover';
import { MARKER, pruneOldVersions } from '../../src/shared/app';
import { NO_APP } from '../../src/cli/entry';
import { BIN, freePort, run, tempDir } from '../cli/helpers';

function homeEnv(home: string, extra: Record<string, string> = {}) {
  return { HOME: home, SPARROW_HOME: join(home, '.sparrow'), SPARROW_SKILLS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), SPARROW_SKIP_WEB_BUILD: '1', ...extra };
}

describe('first-run link is race-safe', () => {
  test('linkAtomic replaces or creates without EEXIST, however often it races', async () => {
    const dir = tempDir('link-');
    const link = join(dir, 'sparrow');
    await Promise.all(Array.from({ length: 20 }, async () => linkAtomic('/opt/a/sparrow', link)));
    expect(readlinkSync(link)).toBe('/opt/a/sparrow');
    linkAtomic('/opt/b/sparrow', link);
    expect(readlinkSync(link)).toBe('/opt/b/sparrow');
    expect(readdirSync(dir)).toEqual(['sparrow']);   // no temp links left
  });

  test('two installs at once in a fresh HOME both succeed and leave one correct link', async () => {
    const home = tempDir('race-');
    const env = homeEnv(home, { SPARROW_PORT: String(await freePort()) });
    const [a, b] = await Promise.all([run(['install'], { env, cwd: home }), run(['install'], { env, cwd: home })]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(a.stderr + b.stderr).not.toContain('EEXIST');
    expect(readlinkSync(join(home, '.local/bin/sparrow'))).toBe(BIN);
    expect(readdirSync(join(home, '.local/bin'))).toEqual(['sparrow']);
    expect(existsSync(join(home, '.sparrow/install.lock'))).toBe(false);
  }, 120_000);
});

describe('uninstall', () => {
  test('uninstall is excluded from materialising the app dir', () => {
    expect(NO_APP).toContain('uninstall');
    expect(NO_APP).toContain('--version');
    expect(NO_APP).not.toContain('install');
  });

  test('refuses while a server answers on its port, and removes nothing', async () => {
    const home = tempDir('un-live-');
    const port = await freePort();
    const srv = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => Response.json({ ok: true, pid: process.pid, version: '0.1.0', started_at: 1 }) });
    try {
      const env = homeEnv(home, { SPARROW_PORT: String(port) });
      expect((await run(['install'], { env, cwd: home })).code).toBe(0);
      mkdirSync(join(home, '.sparrow/app/0.1.0'), { recursive: true });
      const r = await run(['uninstall'], { env, cwd: home });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('sparrow stop');
      expect(existsSync(join(home, '.sparrow/app/0.1.0'))).toBe(true);
      expect(existsSync(join(home, '.claude/skills/sparrow-worker'))).toBe(true);
    } finally { srv.stop(true); }
  }, 120_000);
});

describe('pruneOldVersions', () => {
  function app(versions: Record<string, number>) {
    const root = tempDir('app-');
    for (const [v, age] of Object.entries(versions)) {
      mkdirSync(join(root, v), { recursive: true });
      writeFileSync(join(root, v, MARKER), 'b');
      const t = Date.now() / 1000 - age;
      utimesSync(join(root, v, MARKER), t, t);
    }
    return root;
  }
  test('keeps the current and the newest other version, removes older ones', () => {
    const root = app({ '0.1.0': 400, '0.2.0': 300, '0.3.0': 200, '0.4.0': 0 });
    expect(pruneOldVersions(root, '0.4.0').sort()).toEqual(['0.1.0', '0.2.0']);
    expect(readdirSync(root).sort()).toEqual(['0.3.0', '0.4.0']);
  });
  test('never removes a version a running server uses', () => {
    const root = app({ '0.1.0': 400, '0.2.0': 300, '0.3.0': 0 });
    expect(pruneOldVersions(root, '0.3.0', ['0.1.0'])).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['0.1.0', '0.2.0', '0.3.0']);
  });
  test('leaves unrelated dirs (no marker), temp trees and the shim alone', () => {
    const root = app({ '1.0.0': 0 });
    mkdirSync(join(root, 'mine')); mkdirSync(join(root, '1.1.0.tmp-1-x'));
    expect(pruneOldVersions(root, '1.0.0')).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['1.0.0', '1.1.0.tmp-1-x', 'mine']);
  });
  test('a missing root is fine', () => { expect(pruneOldVersions(join(tempDir('x-'), 'nope'), '1.0.0')).toEqual([]); });
});

describe('harness override warnings', () => {
  const KEYS = ['HOME', 'PATH', 'SPARROW_CLAUDE_BIN', 'SPARROW_CODEX_BIN', 'SPARROW_OPENCODE_BIN'];
  let saved: Record<string, string | undefined>; let home: string;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'sp-ovr-')));
    for (const k of KEYS) delete process.env[k];
    process.env.HOME = home; process.env.PATH = join(home, 'empty');
    resetHarnessCache();
  });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetHarnessCache(); });

  test('unset or valid override: no warning', () => {
    expect(overrideProblem('codex')).toBeNull();
    const ok = join(home, 'codex'); writeFileSync(ok, '#!/bin/sh\n'); chmodSync(ok, 0o755);
    process.env.SPARROW_CODEX_BIN = ok;
    expect(overrideProblem('codex')).toBeNull();
  });
  test('a missing or non-executable override is reported, naming what is used instead', () => {
    process.env.SPARROW_CODEX_BIN = join(home, 'nope');
    expect(overrideProblem('codex')).toContain('SPARROW_CODEX_BIN=');
    expect(overrideProblem('codex')).toMatch(/using \S*codex instead|was not found anywhere else either/);   // which one depends on the machine
    const plain = join(home, 'plain'); writeFileSync(plain, 'x');
    process.env.SPARROW_CLAUDE_BIN = plain;
    const real = join(home, '.local/bin/claude'); mkdirSync(join(home, '.local/bin'), { recursive: true }); writeFileSync(real, '#!/bin/sh\n'); chmodSync(real, 0o755);
    expect(overrideProblem('claude')).toContain(`using ${real} instead`);
  });
});

describe('login hint', () => {
  test('claude: never touches the macOS Keychain (no `security` process), only env and files', () => {
    const src = require('node:fs').readFileSync(join(import.meta.dir, '../../src/cli/setup.ts'), 'utf8') as string;
    expect(src).not.toMatch(/['"]security['"]/);
    const saved = process.env.SPARROW_CLAUDE_JSON;
    process.env.SPARROW_CLAUDE_JSON = '/nonexistent/claude.json';   // never the real ~/.claude.json
    try { expect(loginFound('claude', { CLAUDE_CONFIG_DIR: '/nonexistent' } as NodeJS.ProcessEnv, '/nonexistent')).toBe(false); }
    finally { if (saved === undefined) delete process.env.SPARROW_CLAUDE_JSON; else process.env.SPARROW_CLAUDE_JSON = saved; }
  });
});
