// How hooks, PATH and the fake harness are wired in both modes. Pure builders: no compiled binary needed.
import { describe, expect, test } from 'bun:test';
import { agentPathDirsFor, binDirFor, hookArgv, hookArgvFor } from '../../src/harness/env';
import { fakeAgentArgv } from '../../src/harness/drivers/fake';
import { hookCommand, sq } from '../../src/harness/launch';
import { isServerCommand } from '../../src/cli/lifecycle';
import { entry } from '../../src/cli/entry';
import { BIN, COMPILED, SELF_ARGV } from '../../src/shared/config';

describe('hook command', () => {
  test('compiled: <binary> hook; no bun, no .ts', () => {
    expect(hookArgvFor(true, '/usr/local/bin/sparrow', '/opt/homebrew/bin/bun', '/repo/src/cli/hook.ts')).toEqual(['/usr/local/bin/sparrow', 'hook']);
  });
  test('source: bun + the .ts entry, as before', () => {
    expect(hookArgvFor(false, '/repo/bin/sparrow', '/opt/homebrew/bin/bun', '/repo/src/cli/hook.ts')).toEqual(['/opt/homebrew/bin/bun', '/repo/src/cli/hook.ts']);
  });
  test('the test process is in source mode and builds the source form', () => {
    expect(COMPILED).toBe(false);
    expect(hookArgv()[1]).toMatch(/src\/cli\/hook\.ts$/);
    expect(hookCommand('claude-stop')).toBe(`${hookArgv().map(sq).join(' ')} claude-stop`);
    expect(hookCommand('exit', '--code "$__code"')).toEndWith(' exit --code "$__code"');
  });
  test('a binary path with spaces is single-quoted in the shell command', () => {
    const argv = hookArgvFor(true, '/Users/a b/bin/sparrow', 'bun', 'x');
    expect(`${argv.map(sq).join(' ')} turn-end`).toBe(`'/Users/a b/bin/sparrow' hook turn-end`);
  });
});

describe('agent PATH', () => {
  test('compiled: only the binary dir (no bun dir)', () => {
    expect(agentPathDirsFor(true, '/opt/bin', '/opt/bun')).toEqual(['/opt/bin']);
    expect(agentPathDirsFor(false, '/repo/bin', '/opt/bun')).toEqual(['/repo/bin', '/opt/bun']);
  });
  test('the resolved harness dirs follow, deduped, so a minimal tmux PATH still finds claude/codex/opencode', () => {
    expect(agentPathDirsFor(true, '/opt/bin', '/opt/bun', ['/home/u/.local/bin', '/opt/bin', '/opt/homebrew/bin'])).toEqual(['/opt/bin', '/home/u/.local/bin', '/opt/homebrew/bin']);
    expect(agentPathDirsFor(false, '/repo/bin', '/opt/bun', ['/opt/bun', '/x'])).toEqual(['/repo/bin', '/opt/bun', '/x']);
  });
  test('binDirFor: a binary named sparrow uses its own dir; any other name gets the app shim dir', () => {
    expect(binDirFor('/usr/local/bin/sparrow', '/h/app/1.0.0', true)).toBe('/usr/local/bin');
    expect(binDirFor('/x/dist/bin/sparrow-darwin-arm64', '/h/app/1.0.0', true)).toBe('/h/app/1.0.0/bin');
    expect(binDirFor('/repo/bin/sparrow', '/h/app/1.0.0', false)).toBe('/repo/bin');
  });
});

describe('fake harness + daemon argv', () => {
  test('compiled: the binary runs __fake-agent; source: bun + fake-agent.ts', () => {
    expect(fakeAgentArgv(true, '/b/sparrow', 'bun', '/r/fake-agent.ts')).toEqual(['/b/sparrow', '__fake-agent']);
    expect(fakeAgentArgv(false, '/b/sparrow', 'bun', '/r/fake-agent.ts')).toEqual(['bun', '/r/fake-agent.ts']);
  });
  test('source mode spawns `bun bin/sparrow up`', () => {
    expect(SELF_ARGV).toEqual([process.execPath, BIN]);
  });
});

describe('server process recognition', () => {
  test('source: bun + this checkout\'s bin/sparrow up', () => {
    expect(isServerCommand('bun /repo/bin/sparrow up --home /h --port 1', '/repo/bin/sparrow', false)).toBe(true);
    expect(isServerCommand('bun /other/bin/sparrow up --home /h', '/repo/bin/sparrow', false)).toBe(false);
    expect(isServerCommand('bun /repo/bin/sparrow status', '/repo/bin/sparrow', false)).toBe(false);
  });
  test('compiled: any sparrow binary running `up`, wherever an upgrade put it', () => {
    expect(isServerCommand('/opt/homebrew/Cellar/sparrow/0.1.0/bin/sparrow up --home /h --port 1', '/x', true)).toBe(true);
    expect(isServerCommand('/dist/bin/sparrow-darwin-arm64 up --home /h', '/x', true)).toBe(true);
    expect(isServerCommand('/usr/bin/python3 -m http.server up', '/x', true)).toBe(false);
    expect(isServerCommand('/opt/bin/sparrow status', '/x', true)).toBe(false);
  });
});

describe('entry', () => {
  test('`hook` with no kind falls through to the CLI (usage, exit 2) instead of the fast path', async () => {
    const err = console.error;
    console.error = () => {};
    try { expect(await entry(['hook'])).toBe(2); } finally { console.error = err; }
  });
});
