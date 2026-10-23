import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, freePort, run, tempDir, REPO } from './helpers';

// This file owns a private server so its afterAll cleanup cannot kill panes from another test file.
const TEST_TAG = (process.env.SPARROW_TMUX_SOCKET ?? `${process.pid}`).replace(/[^a-zA-Z0-9-]/g, '-');
const SOCKET = `sparrow-cli-lifecycle-${TEST_TAG}`;
const PREFIX = `scl-${TEST_TAG}-`;
const HOMES = new Set<string>();

function fakeAgentPids(): number[] {
  const r = Bun.spawnSync(['ps', '-ww', '-Ao', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout.toString().split('\n').flatMap((line) => {
    if (!line.includes('/src/harness/fake-agent.ts') || ![...HOMES].some((home) => line.includes(`${home}/agents/`))) return [];
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    return Number.isInteger(pid) && pid > 0 ? [pid] : [];
  });
}

afterAll(async () => {
  // These tests own SOCKET. Killing only that tmux server reaps every child pane process, including fake agents.
  Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 40 && fakeAgentPids().length; i++) await Bun.sleep(50);
  const leaked = fakeAgentPids();
  // If a child survived tmux shutdown, terminate only PIDs whose argv names one of this suite's private homes.
  for (const pid of leaked) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  expect(leaked).toEqual([]);
});

function setup(port: number) {
  const home = tempDir(`sparrow-cli-lifecycle-${TEST_TAG}-`);
  HOMES.add(home);
  const bin = join(home, 'bin'); mkdirSync(bin);
  // macOS opens with `open`; Linux tries `xdg-open` only when a display is set (src/cli/platform.ts). Stub both.
  for (const opener of ['open', 'xdg-open']) {
    writeFileSync(join(bin, opener), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$SPARROW_HOME/opened"\n');
    chmodSync(join(bin, opener), 0o755);
  }
  const web = join(home, 'web'); mkdirSync(web);
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'stub-ui', scripts: { build: 'mkdir -p dist; echo ui > dist/index.html' } }));
  return { home, env: {
    SPARROW_HOME: home, SPARROW_PORT: String(port), SPARROW_TMUX_SOCKET: SOCKET, SPARROW_TMUX_PREFIX: PREFIX,
    SPARROW_WEB_DIR: web, PATH: `${bin}:${process.env.PATH}`, DISPLAY: ':99',
  } };
}

describe('one command lifecycle', () => {
  test('builds UI, starts detached, handles stale pid, is concurrent-idempotent, hires fake, stops', async () => {
    const { home, env } = setup(4150);
    writeFileSync(join(home, 'server.pid'), JSON.stringify({ pid: 99999999, port: 4150 }));
    try {
      const starts = await Promise.all([run([], { env }), run([], { env })]);
      for (const r of starts) { expect(r.stderr).toBe(''); expect(r.code).toBe(0); expect(r.stdout).toContain('http://127.0.0.1:4150'); }
      expect(existsSync(join(home, 'web/dist/index.html'))).toBe(true);
      expect(readFileSync(join(home, 'opened'), 'utf8').trim().split('\n')).toHaveLength(2);
      const h = await fetch('http://127.0.0.1:4150/api/health').then(r => r.json()) as any;
      expect(h.ok).toBe(true);
      const again = await run([], { env });
      expect(again.stdout).toContain(`pid ${h.pid}`);
      const resumes = join(home, 'resumes'); mkdirSync(resumes);
      writeFileSync(join(resumes, 'fake.md'), '---\nname: fake\ntitle: Fake\nharness: fake\ncan_hire: []\n---\nTest worker.\n');
      const hired = await run(['hire', 'fake', 'FAKE:done lifecycle-ok', '--json'], { env });
      expect(hired.code).toBe(0);
      const st = await run(['status'], { env });
      expect(st.stdout).toContain(`pid ${h.pid}`); expect(st.stdout).toContain(`log ${home}/server.log`);
      const stopped = await run(['stop'], { env });
      expect(stopped.code).toBe(0); expect(stopped.stdout).toContain('stopped');
      expect((await run(['status'], { env })).code).toBe(1);
      expect((await run(['stop'], { env })).stdout).toContain('not running');
    } finally {
      await run(['stop'], { env });
    }
  }, 60_000);

  test('stop uses pidfile and SIGKILL fallback when a server cannot answer or handle SIGTERM', async () => {
    const { home, env } = setup(4154);
    let pid: number | undefined;
    try {
      expect((await run([], { env })).code).toBe(0);
      const h = await fetch('http://127.0.0.1:4154/api/health').then(r => r.json()) as any;
      pid = h.pid;
      writeFileSync(join(home, 'server.pid'), JSON.stringify({ pid, port: 4154 }));
      process.kill(pid!, 'SIGSTOP');
      const r = await run(['stop'], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`stopped (pid ${pid})`);
      expect(existsSync(join(home, 'server.pid'))).toBe(false);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }, 20_000);

  test('foreign port reports pid/command and never kills the owner, even with a stale pidfile', async () => {
    const { home, env } = setup(4151);
    const foreign = Bun.spawn([process.execPath, '-e', 'Bun.serve({port:4151,fetch:()=>new Response("foreign")});'], { env: cleanEnv(env), stdout: 'ignore', stderr: 'pipe' });
    try {
      for (let i = 0; i < 40; i++) { try { await fetch('http://127.0.0.1:4151'); break; } catch { await Bun.sleep(50); } }
      writeFileSync(join(home, 'server.pid'), JSON.stringify({ pid: foreign.pid, port: 4151 }));
      const r = await run([], { env });
      expect(r.code).toBe(1); expect(r.stderr).toContain(`pid ${foreign.pid}`); expect(r.stderr).toContain('occupied');
      expect(existsSync(join(home, 'server.pid'))).toBe(false);
      const stopped = await run(['stop'], { env });
      expect(stopped.code).toBe(1);
      expect(stopped.stderr).toContain('no process was signalled');
      expect(await fetch('http://127.0.0.1:4151').then(r => r.text())).toBe('foreign');
    } finally { foreign.kill(); await foreign.exited; }
  }, 15_000);
});

// `sparrow captain` now goes through POST /api/captain/start (the server launches); see captains.test.ts.

// Attach instructions are shell commands: the semicolon must reach tmux as one argument.
test('attach command shell escaping preserves the tmux command separator', async () => {
  const { tmuxAttach } = await import('../../src/cli/format');
  const cmd = tmuxAttach({ tmux_session: 'sparrow-cli-lifecycle-demo', tmux_window: 'worker' });
  const p = Bun.spawn(['bash', '-c', `tmux() { printf '<%s>\\n' "$@"; }; ${cmd}`], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(out).toContain('<;>\n<select-window>');
});

describe('waitForCatalogs (the browser opens with every harness listed)', () => {
  test('waits until claude, codex and opencode all have an entry (ok or failed); says "Loading model lists…" once', async () => {
    const { waitForCatalogs } = await import('../../src/cli/lifecycle');
    const t0 = Date.now();
    const at = (ms: number, h: string, ok = true) => (Date.now() - t0 >= ms ? [{ harness: h, ok }] : []);
    const srv = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => Response.json([...at(0, 'codex'), ...at(300, 'claude'), ...at(600, 'opencode', false)]),
    });
    const lines: string[] = [];
    try {
      const r = await waitForCatalogs({ url: `http://127.0.0.1:${srv.port}`, timeoutMs: 5000, pollMs: 50, say: (l) => lines.push(l) });
      expect(r.complete).toBe(true);
      expect(r.have.sort()).toEqual(['claude', 'codex', 'opencode']);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
      expect(lines).toEqual(['Loading model lists…']);
    } finally { srv.stop(true); }
  });

  test('gives up after the timeout without failing; silent when already complete', async () => {
    const { waitForCatalogs } = await import('../../src/cli/lifecycle');
    const partial = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json([{ harness: 'codex', ok: true }]) });
    const full = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json(['claude', 'codex', 'opencode'].map((harness) => ({ harness, ok: true }))) });
    try {
      const t0 = Date.now();
      const r = await waitForCatalogs({ url: `http://127.0.0.1:${partial.port}`, timeoutMs: 300, pollMs: 50 });
      expect(r).toEqual({ complete: false, have: ['codex'] });
      expect(Date.now() - t0).toBeLessThan(2000);
      const lines: string[] = [];
      expect((await waitForCatalogs({ url: `http://127.0.0.1:${full.port}`, say: (l) => lines.push(l) })).complete).toBe(true);
      expect(lines).toEqual([]);
    } finally { partial.stop(true); full.stop(true); }
  });
});

describe('stop targets this home, not the inherited SPARROW_URL', () => {
  // Agent windows export SPARROW_URL (the live server that spawned them). `SPARROW_HOME=<sandbox> SPARROW_PORT=<p>
  // sparrow stop` from such a window used to ask SPARROW_URL for the pid and SIGTERM the live server.
  test('a sandbox stop with no server of its own leaves the server at SPARROW_URL alone', async () => {
    const victim = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    const decoy = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true, pid: victim.pid, version: '0.1.0', started_at: 1 }),
    });
    const home = tempDir('stop-url-');
    try {
      const port = await freePort();
      const r = await run(['stop'], { env: { SPARROW_HOME: home, SPARROW_PORT: String(port) }, url: `http://127.0.0.1:${decoy.port}` });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('not running');
      expect(() => process.kill(victim.pid, 0)).not.toThrow();
    } finally {
      decoy.stop(true);
      victim.kill('SIGKILL');
    }
  });
});
