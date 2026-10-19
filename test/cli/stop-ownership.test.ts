// D15 follow-up: stop/up only act on a server THIS home owns (its server.pid, or `--home <this home>` in the server's
// command line). A server of another home on the same port is never signalled and never adopted.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, run, tempDir, cleanEnv, freePort } from './helpers';

const AGENT = { SPARROW_AGENT_ID: 'ag_KAI', SPARROW_CALL_ID: 'call_1', SPARROW_URL: 'http://127.0.0.1:4040' };
const decoys: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => { for (const d of decoys.splice(0)) d.kill('SIGKILL'); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const health = async (port: number) => {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json() as Promise<any>; } catch { return null; }
};

/** A stand-in Sparrow server (answers /api/health with its own pid), started with the given extra argv. */
async function decoy(root: string, port: number, extra: string[] = []) {
  const script = join(root, 'decoy.ts');
  writeFileSync(script, 'const port = Number(Bun.argv[2]);\nBun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, pid: process.pid, version: "0.0.0", started_at: 1 }) });\n');
  const p = Bun.spawn([process.execPath, script, String(port), ...extra], { env: cleanEnv(), stdout: 'ignore', stderr: 'ignore' });
  decoys.push(p);
  for (let i = 0; i < 40 && !(await health(port)); i++) await Bun.sleep(50);
  expect((await health(port))?.pid).toBe(p.pid);
  return p;
}

/** A listener that does not answer Sparrow health; extra argv emulate the identity written by `sparrow up`. */
async function unhealthyListener(root: string, port: number, home: string) {
  const script = join(root, 'unhealthy.ts');
  writeFileSync(script, 'const port = Number(Bun.argv[2]);\nBun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("not healthy", { status: 503 }) });\n');
  const p = Bun.spawn([process.execPath, script, String(port), BIN, 'up', '--home', home, '--port', String(port)], { env: cleanEnv(), stdout: 'ignore', stderr: 'ignore' });
  decoys.push(p);
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 503) break; } catch {}
    await Bun.sleep(50);
  }
  return p;
}

function mine(port: number) {  // port from freePort()
  const root = tempDir('own-');
  const web = join(root, 'web'); mkdirSync(join(web, 'dist'), { recursive: true });
  writeFileSync(join(web, 'package.json'), '{}'); writeFileSync(join(web, 'dist', 'index.html'), '<html></html>');
  const bin = join(root, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'open'), '#!/bin/sh\nexit 0\n'); Bun.spawnSync(['chmod', '+x', join(bin, 'open')]);
  // the home does not exist: no pidfile, never started anything
  return { root, home: join(root, 'my-home'), env: { SPARROW_PORT: String(port), SPARROW_TMUX_SOCKET: `own${port}`, SPARROW_TMUX_PREFIX: `o${port}-`, SPARROW_WEB_DIR: web, PATH: `${bin}:${process.env.PATH}` } };
}

describe('stop never touches a server this home does not own', () => {
  for (const [label, extra] of [['a different --home', ['--home', '/somewhere/else/home']], ['no --home at all', []]] as const) {
    test(`decoy with ${label} survives stop, with and without --sandbox, from an agent and a human`, async () => {
      const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);
      const d = await decoy(root, port, [...extra]);
      const full = { ...env, SPARROW_HOME: home };
      const tries: [string[], Record<string, string>][] = [
        [['stop'], {}], [['stop', '--sandbox'], {}],                    // human shell
        [['stop', '--sandbox'], AGENT],                                  // agent sandbox stop
      ];
      for (const [args, who] of tries) {
        const r = await run(args, { env: { ...full, ...who } });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('does not belong to SPARROW_HOME');
        expect(r.stderr).toContain(`pid ${d.pid}`);
        expect(r.stderr).toContain(extra.length ? 'home /somewhere/else/home' : 'unknown home');
        expect(alive(d.pid)).toBe(true);
      }
      expect((await health(port))?.pid).toBe(d.pid);
    }, 30_000);
  }

  test('a decoy whose command line carries --home <this home> (no pidfile) is ours and gets stopped', async () => {
    const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);
    mkdirSync(home);
    const d = await decoy(root, port, ['--home', home, '--port', String(port)]);
    const r = await run(['stop'], { env: { ...env, SPARROW_HOME: home } });
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain(`stopped (pid ${d.pid})`);
    expect(alive(d.pid)).toBe(false);
  }, 30_000);

  test('when health and pidfile are missing, stop finds only a listener confirmed by this --home and --port', async () => {
    const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);
    mkdirSync(home);
    const d = await unhealthyListener(root, port, home);
    const r = await run(['stop'], { env: { ...env, SPARROW_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`stopped (pid ${d.pid}, confirmed by --home ${home} and --port ${port})`);
    expect(alive(d.pid)).toBe(false);
  }, 30_000);

  test('when health and pidfile are missing, an unconfirmed port listener is left alone with inspection steps', async () => {
    const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);
    mkdirSync(home);
    const d = await unhealthyListener(root, port, '/somewhere/else/home');
    const r = await run(['stop'], { env: { ...env, SPARROW_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`None confirms both --home ${home} and --port ${port}`);
    expect(r.stderr).toContain('no process was signalled');
    expect(alive(d.pid)).toBe(true);
  }, 30_000);

  test('a stale pidfile naming another Sparrow home is not enough to stop its server', async () => {
    const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);
    mkdirSync(home);
    const d = await unhealthyListener(root, port, '/somewhere/else/home');
    writeFileSync(join(home, 'server.pid'), JSON.stringify({ pid: d.pid, port }));
    const r = await run(['stop'], { env: { ...env, SPARROW_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('command line does not confirm');
    expect(r.stderr).toContain('no process was signalled');
    expect(alive(d.pid)).toBe(true);
  }, 30_000);

  test('--home is compared by realpath (symlinked home)', async () => {
    const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);
    mkdirSync(home);
    const link = join(root, 'link-home'); symlinkSync(home, link);
    const d = await decoy(root, port, ['--home', link, '--port', String(port)]);
    const r = await run(['stop'], { env: { ...env, SPARROW_HOME: home } });
    expect(r.stdout).toContain(`stopped (pid ${d.pid})`);
  }, 30_000);

  test('a real server: another home on the same port cannot stop it; its own home can', async () => {
    const port = await freePort();
    const a = mine(port);
    const b = { ...mine(port), home: join(tempDir('own-'), 'other-home') };
    try {
      expect((await run([], { env: { ...a.env, SPARROW_HOME: a.home } })).code).toBe(0);
      const h = await health(port);
      expect(h?.ok).toBe(true);
      for (const who of [{}, AGENT]) {
        const r = await run(['stop', ...(who === AGENT ? ['--sandbox'] : [])], { env: { ...b.env, SPARROW_HOME: b.home, ...who } });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('does not belong');
        expect(r.stderr).toContain(`home ${a.home}`);
        expect(alive(h.pid)).toBe(true);
      }
      const own = await run(['stop'], { env: { ...a.env, SPARROW_HOME: a.home } });
      expect(own.stdout).toContain(`stopped (pid ${h.pid})`);
      expect(alive(h.pid)).toBe(false);
    } finally {
      await run(['stop'], { env: { ...a.env, SPARROW_HOME: a.home } });
      Bun.spawnSync(['tmux', '-L', `own${port}`, 'kill-server'], { stderr: 'ignore' });
    }
  }, 60_000);
});

describe('up never adopts a server of another home', () => {
  test('foreground up, bare sparrow and up --tmux refuse, and the decoy keeps running', async () => {
    const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);
    const d = await decoy(root, port, ['--home', '/somewhere/else/home']);
    const full = { ...env, SPARROW_HOME: home };
    for (const args of [['up'], [], ['up', '--tmux']]) {
      const r = await run(args, { env: full });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('does not belong to SPARROW_HOME');
      expect(r.stdout).not.toContain('already running');
    }
    expect(alive(d.pid)).toBe(true);
    Bun.spawnSync(['tmux', '-L', `own${port}`, 'kill-server'], { stderr: 'ignore' });
  }, 40_000);
});

describe('up --tmux second probe (window already exists, server appears while waiting)', () => {
  test('a foreign-home server that comes up during the wait is refused, not reported as ours', async () => {
    const { root, home, env } = mine(await freePort());
    const port = Number(env.SPARROW_PORT);   // temp home, explicit free port: never 4040
    const sock = `own${port}`;
    try {
      // an existing 'sparrow:server' window with nothing listening: up --tmux waits ~3s, then probes again
      Bun.spawnSync(['tmux', '-L', sock, 'new-session', '-d', '-s', 'sparrow', '-n', 'server', 'sleep 120']);
      const pending = run(['up', '--tmux'], { env: { ...env, SPARROW_HOME: home } });
      await Bun.sleep(1200);
      const d = await decoy(root, port, ['--home', '/somewhere/else/home']);
      const r = await pending;
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('does not belong to SPARROW_HOME');
      expect(r.stderr).toContain('home /somewhere/else/home');
      expect(r.stdout).not.toContain('already running');
      expect(alive(d.pid)).toBe(true);
    } finally {
      Bun.spawnSync(['tmux', '-L', sock, 'kill-server'], { stderr: 'ignore' });
    }
  }, 30_000);
});

// The 4040 rule (sandbox never uses the user's port) is tested ONLY through the pure lifecycleRefusal() in
// guard-unit.test.ts: a CLI test with SPARROW_PORT unset/4040 would hit the user's live server on old code.
