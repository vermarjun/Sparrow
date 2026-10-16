import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, run, tempDir, REPO } from './helpers';

function setup(port: number) {
  const home = tempDir('u1cli-');
  const bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$SPARROW_HOME/opened"\n');
  chmodSync(join(bin, 'open'), 0o755);
  const web = join(home, 'web'); mkdirSync(web);
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'stub-ui', scripts: { build: 'mkdir -p dist; echo ui > dist/index.html' } }));
  return { home, env: {
    SPARROW_HOME: home, SPARROW_PORT: String(port), SPARROW_TMUX_SOCKET: 'u1cli', SPARROW_TMUX_PREFIX: 'u1cli-',
    SPARROW_WEB_DIR: web, PATH: `${bin}:${process.env.PATH}`,
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
      Bun.spawnSync(['tmux', '-L', 'u1cli', 'kill-session', '-t', '=u1cli-sparrow-u1-cli'], { stderr: 'ignore' });
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
      expect((await run(['stop'], { env })).code).toBe(0);
      expect(await fetch('http://127.0.0.1:4151').then(r => r.text())).toBe('foreign');
    } finally { foreign.kill(); await foreign.exited; }
  }, 15_000);
});

describe('captain', () => {
  test('normal Claude argv, folder, trust, no worker identity, exact attach command', async () => {
    const { home, env } = setup(4152);
    const fake = join(home, 'bin/claude');
    writeFileSync(fake, '#!/bin/sh\npwd > "$SPARROW_HOME/cwd"\nprintf "%s\\n" "$@" > "$SPARROW_HOME/argv"\nprintf "%s" "$SPARROW_AGENT_ID" > "$SPARROW_HOME/identity"\nsleep 30\n'); chmodSync(fake, 0o755);
    const server = Bun.serve({ port: 4152, fetch: () => Response.json({ ok: true }) });
    try {
      const r = await run(['captain', '--cwd', home, '--model', 'haiku', '--effort', 'low', '--json'], { env: { ...env, SPARROW_CLAUDE_BIN: fake, SPARROW_CLAUDE_JSON: join(home, 'claude.json'), SPARROW_AGENT_ID: 'must-not-inherit' } });
      expect(r.code).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(result.session).toBe('u1cli-captains'); expect(result.attach).toContain(`select-window -t ${result.window_id}`);
      for (let i = 0; i < 40 && !existsSync(join(home, 'argv')); i++) await Bun.sleep(50);
      expect(readFileSync(join(home, 'cwd'), 'utf8').trim()).toBe(home);
      expect(readFileSync(join(home, 'identity'), 'utf8')).toBe('');
      expect(readFileSync(join(home, 'argv'), 'utf8').trim().split('\n')).toEqual(['--append-system-prompt-file', join(REPO, 'assets/captain.md'), '--model', 'haiku', '--effort', 'low']);
      expect(JSON.parse(readFileSync(join(home, 'claude.json'), 'utf8')).projects[home].hasTrustDialogAccepted).toBe(true);
      expect(Bun.spawnSync(['tmux', '-L', 'u1cli', 'display-message', '-p', '-t', result.window_id, '#{pane_current_path}']).stdout.toString().trim()).toBe(home);
      const bad = await run(['captain', '--cwd', join(home, 'absent')], { env: { ...env, SPARROW_CLAUDE_BIN: fake } });
      expect(bad.code).toBe(1); expect(bad.stderr).toContain('existing directory');
    } finally {
      server.stop(true);
      Bun.spawnSync(['tmux', '-L', 'u1cli', 'kill-session', '-t', '=u1cli-captains'], { stderr: 'ignore' });
    }
  }, 15_000);
});

// Attach instructions are shell commands: the semicolon must reach tmux as one argument.
test('attach command shell escaping preserves the tmux command separator', async () => {
  const { tmuxAttach } = await import('../../src/cli/format');
  const cmd = tmuxAttach({ tmux_session: 'u1cli-demo', tmux_window: 'worker' });
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
