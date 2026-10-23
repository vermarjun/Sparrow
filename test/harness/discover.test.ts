import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { harnessSearchPath, knownHarnessPaths, lookupHarness, resetHarnessCache, resolveHarnessBin } from '../../src/harness/discover';

const KEYS = ['HOME', 'PATH', 'SPARROW_CLAUDE_BIN', 'SPARROW_CODEX_BIN', 'SPARROW_OPENCODE_BIN', 'NVM_DIR', 'NVM_BIN', 'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'PNPM_HOME'];
let saved: Record<string, string | undefined>;
let home: string;

function exe(path: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sp-discover-')));
  for (const k of KEYS) delete process.env[k];
  process.env.HOME = home;
  process.env.PATH = join(home, 'emptybin'); // nothing real on PATH
  resetHarnessCache();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetHarnessCache();
});

describe('harnessSearchPath', () => {
  test('process PATH first, then the usual install dirs, deduped', () => {
    process.env.PATH = `/some/where${delimiter}/usr/local/bin`;
    const dirs = harnessSearchPath().split(delimiter);
    expect(dirs[0]).toBe('/some/where');
    for (const d of [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.opencode/bin'), join(home, '.bun/bin'), join(home, '.npm-global/bin')]) {
      expect(dirs).toContain(d);
    }
    expect(dirs.filter((d) => d === '/usr/local/bin')).toHaveLength(1);
  });

  test('npm prefix, nvm versions and volta are included when present', () => {
    process.env.npm_config_prefix = join(home, 'npmprefix');
    mkdirSync(join(home, '.nvm/versions/node/v18.1.0/bin'), { recursive: true });
    mkdirSync(join(home, '.nvm/versions/node/v20.5.0/bin'), { recursive: true });
    const dirs = harnessSearchPath().split(delimiter);
    expect(dirs).toContain(join(home, 'npmprefix/bin'));
    expect(dirs).toContain(join(home, '.volta/bin'));
    // newest node version first
    expect(dirs.indexOf(join(home, '.nvm/versions/node/v20.5.0/bin'))).toBeLessThan(dirs.indexOf(join(home, '.nvm/versions/node/v18.1.0/bin')));
  });
});

// The real search path includes system dirs (/opt/homebrew/bin, /usr/local/bin) that may hold a real harness on the
// machine running the tests, so location-specific tests only look at the dirs under the fake HOME.
const homeOnly = (h: 'claude' | 'codex' | 'opencode') =>
  lookupHarness(h, harnessSearchPath().split(delimiter).filter((d) => d.startsWith(home)).join(delimiter), knownHarnessPaths(h).filter((p) => p.startsWith(home)));

describe('lookupHarness', () => {
  test('null when nothing is installed', () => {
    expect(lookupHarness('claude', join(home, 'emptybin'), [])).toBeNull();
    expect(homeOnly('claude')).toBeNull();
  });

  test('finds a binary in ~/.local/bin', () => {
    const p = exe(join(home, '.local/bin/claude'));
    expect(homeOnly('claude')).toBe(p);
  });

  test('finds opencode in ~/.opencode/bin and codex under an npm prefix', () => {
    const oc = exe(join(home, '.opencode/bin/opencode'));
    process.env.npm_config_prefix = join(home, 'pfx');
    const cx = exe(join(home, 'pfx/bin/codex'));
    expect(homeOnly('opencode')).toBe(oc);
    expect(homeOnly('codex')).toBe(cx);
  });

  test('finds codex under a bun global bin and an nvm node version', () => {
    const b = exe(join(home, '.bun/bin/codex'));
    expect(homeOnly('codex')).toBe(b);
    require('node:fs').unlinkSync(b);
    const n = exe(join(home, '.nvm/versions/node/v20.5.0/bin/codex'));
    expect(homeOnly('codex')).toBe(n);
  });

  test('finds claude at the legacy ~/.claude/local/claude known path (on no PATH dir)', () => {
    const p = exe(join(home, '.claude/local/claude'));
    expect(lookupHarness('claude', join(home, 'emptybin'), knownHarnessPaths('claude'))).toBe(p);
  });

  test('a non-executable file is not a hit', () => {
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(join(home, '.local/bin/claude'), 'x');
    chmodSync(join(home, '.local/bin/claude'), 0o644);
    expect(homeOnly('claude')).toBeNull();
  });

  test('a symlink to an executable resolves (npm/brew shims are links)', () => {
    const real = exe(join(home, 'real/claude'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    symlinkSync(real, join(home, '.local/bin/claude'));
    expect(homeOnly('claude')).toBe(join(home, '.local/bin/claude'));
  });
});

describe('resolveHarnessBin', () => {
  test('process PATH wins and the result is absolute', () => {
    const p = exe(join(home, 'pathdir/claude'));
    process.env.PATH = join(home, 'pathdir');
    expect(resolveHarnessBin('claude')).toBe(p);
  });

  test('env override wins over PATH and must be an executable file; a bad one falls through', () => {
    const onPath = exe(join(home, 'pathdir/codex'));
    process.env.PATH = join(home, 'pathdir');
    const custom = exe(join(home, 'custom/my-codex'));
    process.env.SPARROW_CODEX_BIN = custom;
    expect(resolveHarnessBin('codex')).toBe(custom);
    process.env.SPARROW_CODEX_BIN = join(home, 'custom/missing');
    expect(resolveHarnessBin('codex')).toBe(onPath);
  });

  test('a bare command name in the override is looked up on the widened PATH and returned absolute', () => {
    const p = exe(join(home, '.bun/bin/oc-wrapper'));
    process.env.SPARROW_OPENCODE_BIN = 'oc-wrapper';
    expect(resolveHarnessBin('opencode')).toBe(p);
  });

  test('each override variable maps to its own harness', () => {
    const a = exe(join(home, 'o/a')), b = exe(join(home, 'o/b')), c = exe(join(home, 'o/c'));
    process.env.SPARROW_CLAUDE_BIN = a; process.env.SPARROW_CODEX_BIN = b; process.env.SPARROW_OPENCODE_BIN = c;
    expect([resolveHarnessBin('claude'), resolveHarnessBin('codex'), resolveHarnessBin('opencode')]).toEqual([a, b, c]);
  });

  test('hits are cached but re-checked: a removed binary is re-resolved, a later install is found', () => {
    const p = exe(join(home, 'd1/codex'));
    process.env.PATH = join(home, 'd1');
    expect(resolveHarnessBin('codex')).toBe(p);
    const p2 = exe(join(home, 'd2/codex'));
    process.env.PATH = `${join(home, 'd1')}${delimiter}${join(home, 'd2')}`;
    require('node:fs').unlinkSync(p);
    expect(resolveHarnessBin('codex')).toBe(p2);
  });

  test('resetHarnessCache forgets a cached hit so a changed PATH is honoured', () => {
    const a = exe(join(home, 'e1/opencode'));
    process.env.PATH = join(home, 'e1');
    expect(resolveHarnessBin('opencode')).toBe(a);
    const b = exe(join(home, 'e2/opencode'));
    process.env.PATH = join(home, 'e2');
    expect(resolveHarnessBin('opencode')).toBe(a); // still executable: served from the cache
    resetHarnessCache();
    expect(resolveHarnessBin('opencode')).toBe(b);
  });
});
