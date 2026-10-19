// D15: an agent never starts or stops the user's server, except a sandbox one (--sandbox + non-default SPARROW_HOME).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, run, tempDir } from './helpers';

const AGENT = { SPARROW_AGENT_ID: 'ag_KAI', SPARROW_CALL_ID: 'call_1', SPARROW_URL: 'http://127.0.0.1:4040' };

function sandbox(port: number) {  // port from freePort()
  const root = tempDir('guard-');
  const web = join(root, 'web'); mkdirSync(join(web, 'dist'), { recursive: true });
  writeFileSync(join(web, 'package.json'), '{}'); writeFileSync(join(web, 'dist', 'index.html'), '<html></html>');
  const home = join(root, 'home');
  return { root, home, env: { SPARROW_HOME: home, SPARROW_PORT: String(port), SPARROW_TMUX_SOCKET: `guard${port}`, SPARROW_TMUX_PREFIX: `g${port}-`, SPARROW_WEB_DIR: web } };
}
const health = async (port: number) => {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json() as Promise<any>; } catch { return null; }
};

describe('agents and the server lifecycle (D15)', () => {
  test('up, stop and bare `sparrow` are refused from an agent, with no --sandbox, without touching anything', async () => {
    const { env, home } = sandbox(await freePort());
    const port = Number(env.SPARROW_PORT);
    for (const args of [['up'], ['up', '--tmux'], ['stop'], []]) {
      const r = await run(args, { env: { ...env, ...AGENT } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("agents must not start/stop the user's Sparrow server; report it to your captain");
    }
    expect(await health(port)).toBeNull();
    expect(Bun.file(join(home, 'server.pid')).size).toBe(0);
  });

  test('--sandbox is refused when SPARROW_HOME is the default ~/.sparrow (HOME is a temp dir here)', async () => {
    const { env, root } = sandbox(await freePort());
    const port = Number(env.SPARROW_PORT);
    const fakeHome = join(root, 'fakehome'); mkdirSync(join(fakeHome, '.sparrow'), { recursive: true });
    for (const cmd of ['up', 'stop']) {
      const r = await run([cmd, '--sandbox'], { env: { ...env, ...AGENT, HOME: fakeHome, SPARROW_HOME: join(fakeHome, '.sparrow') } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('--sandbox needs SPARROW_HOME set to a directory other than ~/.sparrow');
    }
    expect(await health(port)).toBeNull();
  });

  test('an agent can run and stop a sandbox server with --sandbox', async () => {
    const { env, home } = sandbox(await freePort());
    const port = Number(env.SPARROW_PORT);
    const p = Bun.spawn([process.execPath, join(import.meta.dir, '../../bin/sparrow'), 'up', '--sandbox'], {
      env: { ...process.env as Record<string, string>, ...env, ...AGENT, TZ: 'UTC' }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      let h = null;
      for (let i = 0; i < 60 && !h; i++) { await Bun.sleep(250); h = await health(port); }
      expect(h?.pid).toBe(p.pid);
      const stopped = await run(['stop', '--sandbox'], { env: { ...env, ...AGENT } });
      expect(stopped.stderr).toBe('');
      expect(stopped.stdout).toContain('stopped');
      expect(await p.exited).toBe(0);
      expect(await health(port)).toBeNull();
    } finally { p.kill('SIGKILL'); Bun.spawnSync(['tmux', '-L', `guard${port}`, 'kill-server'], { stderr: 'ignore' }); }
  }, 40_000);
});
