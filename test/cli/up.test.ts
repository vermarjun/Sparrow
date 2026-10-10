// `sparrow up` against the real server (T1). Temp SPARROW_HOME, ports 4133/4134, own tmux socket.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, REPO, cleanEnv, run, tempDir } from './helpers';

const HAVE_SERVER = existsSync(join(REPO, 'src', 'server', 'main.ts'));
const SOCKET = 'sparrow-test-t3-up';

async function health(port: number) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok ? ((await r.json()) as any) : null;
  } catch { return null; }
}

afterAll(() => {
  Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
});

describe.skipIf(!HAVE_SERVER)('sparrow up', () => {
  test('foreground: serves health, stops cleanly on SIGTERM', async () => {
    const home = tempDir();
    const web = join(home, 'web'); // no dist → the hint is printed, the server still starts
    mkdirSync(web);
    writeFileSync(join(web, 'package.json'), '{}');
    const p = Bun.spawn([process.execPath, BIN, 'up', '--port', '4133', '--max-running', '2'], {
      env: cleanEnv({ SPARROW_HOME: join(home, 'h'), SPARROW_TMUX_SOCKET: SOCKET, SPARROW_TMUX_PREFIX: 'sptest-', SPARROW_WEB_DIR: web }),
      stdout: 'pipe', stderr: 'pipe',
    });
    let h = null;
    for (let i = 0; i < 40 && !h; i++) { await Bun.sleep(250); h = await health(4133); }
    expect(h?.ok).toBe(true);
    expect(h.pid).toBe(p.pid);
    // second `up` on the same port says it is already running
    const again = await run(['up', '--port', '4133'], { env: { SPARROW_HOME: join(home, 'h') } });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already running');
    p.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    const out = await new Response(p.stdout).text();
    expect(out).toContain('Sparrow server on http://127.0.0.1:4133');
    expect(out).toContain('max_running 2');
    expect(out).toContain('UI not built — run `sparrow install` (or `cd web && bun run build`)');
    expect(await health(4133)).toBeNull();
  }, 30_000);

  test('--tmux: starts in session sparrow / window server, idempotent', async () => {
    const home = tempDir();
    const web = join(home, 'web'); // a "built" UI → no hint
    mkdirSync(join(web, 'dist'), { recursive: true });
    writeFileSync(join(web, 'package.json'), '{}');
    writeFileSync(join(web, 'dist', 'index.html'), '<html></html>');
    const env = { SPARROW_HOME: join(home, 'h'), SPARROW_PORT: '4134', SPARROW_TMUX_SOCKET: SOCKET, SPARROW_TMUX_PREFIX: 'sptest-', SPARROW_WEB_DIR: web };
    const r1 = await run(['up', '--tmux'], { env });
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain(`in tmux session 'sparrow', window 'server'`);
    expect(r1.stdout).toContain(`tmux -L ${SOCKET} attach -t sparrow`);
    expect(r1.stdout).not.toContain('UI not built'); // SPARROW_WEB_DIR has dist/index.html
    const wins = Bun.spawnSync(['tmux', '-L', SOCKET, 'list-windows', '-t', '=sparrow', '-F', '#{window_name}']).stdout.toString().trim();
    expect(wins).toBe('server');
    const h = await health(4134);
    expect(h?.ok).toBe(true);
    const r2 = await run(['up', '--tmux'], { env });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('already running');
    const st = await run(['status'], { env, url: 'http://127.0.0.1:4134' });
    expect(st.code).toBe(0);
    expect(st.stdout).toContain(`pid ${h.pid}`);
    // the server inside tmux got our temp SPARROW_HOME through `tmux -e`
    expect(existsSync(join(home, 'h', 'sparrow.db'))).toBe(true);
  }, 30_000);
});
