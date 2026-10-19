// D7/D20/D6: the test preload and the server test helper keep a test run away from the user's real Sparrow.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scrub, testEnvProblem } from '../preload-guard';
import { cleanEnv, tempDir } from '../cli/helpers';

const REPO = resolve(import.meta.dir, '../..');

describe('testEnvProblem / scrub (pure)', () => {
  const ok = { SPARROW_HOME: '/tmp/x/home', SPARROW_PORT: '4597', SPARROW_TMUX_SOCKET: 'test-socket', SPARROW_TMUX_PREFIX: 'test-' };
  test('accepts a temp home, explicit non-4040 port, and isolated tmux values', () => expect(testEnvProblem(ok)).toBeNull());
  test('refuses unset or default home, unset or 4040 port, and unsafe tmux values', () => {
    expect(testEnvProblem({ SPARROW_PORT: '4597' })).toContain('SPARROW_HOME is unset');
    expect(testEnvProblem({ ...ok, SPARROW_HOME: join(homedir(), '.sparrow') })).toContain('real');
    expect(testEnvProblem({ ...ok, SPARROW_HOME: join(homedir(), '.sparrow') + '/' })).toContain('real');
    expect(testEnvProblem({ SPARROW_HOME: '/tmp/x/home' })).toContain('SPARROW_PORT is unset');
    expect(testEnvProblem({ ...ok, SPARROW_PORT: '4040' })).toContain('4040');
    expect(testEnvProblem({ ...ok, SPARROW_TMUX_SOCKET: undefined })).toContain('SPARROW_TMUX_SOCKET is unset');
    expect(testEnvProblem({ ...ok, SPARROW_TMUX_PREFIX: undefined })).toContain('SPARROW_TMUX_PREFIX is unset');
    expect(testEnvProblem({ ...ok, SPARROW_TMUX_PREFIX: 'sparrow-' })).toContain('default sparrow-');
  });
  test('scrub deletes the identity vars and nothing else', () => {
    const env: Record<string, string | undefined> = { SPARROW_AGENT_ID: 'a', SPARROW_CALL_ID: 'c', SPARROW_URL: 'u', SPARROW_WINDOW: 'w', SPARROW_AGENT_URL: 'x', SPARROW_HOME: 'h', SPARROW_PORT: '1' };
    expect(scrub(env).sort()).toEqual(['SPARROW_AGENT_ID', 'SPARROW_AGENT_URL', 'SPARROW_CALL_ID', 'SPARROW_URL', 'SPARROW_WINDOW']);
    expect(env).toEqual({ SPARROW_HOME: 'h', SPARROW_PORT: '1' });
  });
});

describe('bunfig.toml preload, end to end (a throwaway test file; no sparrow command is run)', () => {
  const preload = join(REPO, 'test', 'preload.ts');
  test('bunfig.toml registers the preload', () => {
    expect(readFileSync(join(REPO, 'bunfig.toml'), 'utf8')).toMatch(/\[test\][\s\S]*preload\s*=\s*\["\.\/test\/preload\.ts"\]/);
  });
  async function bunTest(env: Record<string, string | undefined>) {
    const dir = tempDir('preload-');
    writeFileSync(join(dir, 'probe.test.ts'), `import { test, expect } from 'bun:test';
test('probe', () => { expect(JSON.stringify(['SPARROW_AGENT_ID','SPARROW_CALL_ID','SPARROW_URL','SPARROW_WINDOW'].map((k) => process.env[k] ?? null))).toBe('[null,null,null,null]'); });\n`);
    const p = Bun.spawn([process.execPath, 'test', '--preload', preload, join(dir, 'probe.test.ts')], { cwd: dir, env: cleanEnv(env), stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out + err };
  }
  const good = { SPARROW_HOME: join(tmpdir(), 'preload-home'), SPARROW_PORT: '4597', SPARROW_TMUX_SOCKET: 'preload-test', SPARROW_TMUX_PREFIX: 'preload-' };
  test('identity vars are gone before the test file loads', async () => {
    const r = await bunTest({ ...good, SPARROW_AGENT_ID: 'ag_X', SPARROW_CALL_ID: 'c', SPARROW_URL: 'http://127.0.0.1:4040', SPARROW_WINDOW: 'ag_X' });
    expect(r.out).toContain('1 pass');
    expect(r.code).toBe(0);
  });
  for (const [label, env, msg] of [
    ['SPARROW_HOME unset', { SPARROW_PORT: '4597' }, 'SPARROW_HOME is unset'],
    ['SPARROW_HOME is ~/.sparrow', { SPARROW_PORT: '4597', SPARROW_HOME: join(homedir(), '.sparrow') }, 'bun test refused'],
    ['SPARROW_PORT unset', { SPARROW_HOME: good.SPARROW_HOME }, 'SPARROW_PORT is unset'],
    ['SPARROW_PORT is 4040', { ...good, SPARROW_PORT: '4040' }, 'SPARROW_PORT is 4040'],
    ['SPARROW_TMUX_SOCKET unset', { ...good, SPARROW_TMUX_SOCKET: '' }, 'SPARROW_TMUX_SOCKET is unset'],
    ['SPARROW_TMUX_PREFIX unset', { ...good, SPARROW_TMUX_PREFIX: '' }, 'SPARROW_TMUX_PREFIX is unset'],
    ['SPARROW_TMUX_PREFIX is default', { ...good, SPARROW_TMUX_PREFIX: 'sparrow-' }, 'default sparrow-'],
  ] as [string, Record<string, string>, string][]) {
    test(`refuses to run when ${label}`, async () => {
      const r = await bunTest(env);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(msg);
      expect(r.out).not.toContain('1 pass');
    });
  }
});

describe('D6: test/server/helpers.ts points SPARROW_HOME at a temp dir', () => {
  test('importing it replaces SPARROW_HOME with a fresh temp dir (subprocess; no sparrow command)', async () => {
    const fake = join(tempDir('d6-'), 'given-home'); mkdirSync(fake);
    const code = `const before = process.env.SPARROW_HOME; await import(${JSON.stringify(join(REPO, 'test/server/helpers.ts'))}); console.log(JSON.stringify([before, process.env.SPARROW_HOME]));`;
    const p = Bun.spawn([process.execPath, '-e', code], { cwd: REPO, env: cleanEnv({ SPARROW_HOME: fake }), stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const [before, after] = JSON.parse(out.trim().split('\n').pop()!);
    expect(before).toBe(fake);
    expect(after).not.toBe(fake);
    expect(after.startsWith(tmpdir()) || after.startsWith('/private' + tmpdir())).toBe(true);
    expect(after).not.toBe(join(homedir(), '.sparrow'));
  });
});
