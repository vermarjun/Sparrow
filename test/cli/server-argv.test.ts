// D12: the server's command line names its home, so a `ps` pattern can't confuse the user's server with a sandbox.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, run, tempDir } from './helpers';

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
const psCommand = (pid: number) => Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command=']).stdout.toString().trim();

describe('the server command line names its home (D12)', () => {
  test('startDetached passes --home and --port; up rejects a --home that disagrees with SPARROW_HOME', async () => {
    const { env, home, root } = sandbox(await freePort());
    const port = Number(env.SPARROW_PORT);
    try {
      const r = await run([], { env });
      expect(r.code).toBe(0);
      const h = await health(port);
      expect(h?.ok).toBe(true);
      const cmd = psCommand(h.pid);
      expect(cmd).toContain(`up --home ${home} --port ${port}`);

      const bad = await run(['up', '--home', join(root, 'other')], { env });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('disagrees with SPARROW_HOME');
      // the same home, spelled differently (trailing slash), is fine: it reports "already running"
      const same = await run(['up', '--home', home + '/'], { env });
      expect(same.stderr).toBe('');
      expect(same.stdout).toContain('already running');
    } finally {
      await run(['stop'], { env });
      Bun.spawnSync(['tmux', '-L', `guard${port}`, 'kill-server'], { stderr: 'ignore' });
    }
  }, 40_000);

  test('up --tmux also puts --home in the server command line', async () => {
    const { env, home } = sandbox(await freePort());
    const port = Number(env.SPARROW_PORT);
    try {
      const r = await run(['up', '--tmux'], { env });
      expect(r.code).toBe(0);
      const h = await health(port);
      expect(psCommand(h.pid)).toContain(`up --home ${home} --port ${port}`);
    } finally {
      await run(['stop'], { env });
      Bun.spawnSync(['tmux', '-L', `guard${port}`, 'kill-server'], { stderr: 'ignore' });
    }
  }, 40_000);
});
