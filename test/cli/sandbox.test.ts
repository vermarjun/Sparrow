// D19(b): `sparrow sandbox up|down`. Temp dirs only; every port is OS-assigned by the command itself (never 4040).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, run, tempDir } from './helpers';

const AGENT = { SPARROW_AGENT_ID: 'ag_KAI', SPARROW_CALL_ID: 'call_1', SPARROW_URL: 'http://127.0.0.1:4040', SPARROW_AGENT_URL: 'http://127.0.0.1:4040', SPARROW_WINDOW: 'ag_KAI', SPARROW_HARNESS: 'claude' };
const made: string[] = [];
afterEach(async () => { for (const d of made.splice(0)) await run(['sandbox', 'down', '--dir', d]); });

const health = async (port: number) => {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json() as Promise<any>; } catch { return null; }
};
const meta = (dir: string) => JSON.parse(readFileSync(join(dir, 'sandbox.json'), 'utf8'));
const psCommand = (pid: number) => Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command=']).stdout.toString().trim();

async function up(dir: string, env: Record<string, string> = {}) {
  made.push(dir);
  const r = await run(['sandbox', 'up', '--dir', dir, '--json'], { env });
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

describe('sparrow sandbox up / down', () => {
  test('up creates <dir>/home, picks a free port (not 4040), owns the server via --home, prints env lines; down stops it and the tmux socket', async () => {
    const dir = join(tempDir('sbx-'), 'one');
    const text = await run(['sandbox', 'up', '--dir', dir]); made.push(dir);
    expect(text.code).toBe(0);
    const m = meta(dir);
    expect(m.home).toBe(join(dir, 'home'));
    expect(existsSync(m.home)).toBe(true);
    expect(m.port).not.toBe(4040);
    for (const line of [`export SPARROW_HOME=${m.home}`, `export SPARROW_PORT=${m.port}`, `export SPARROW_TMUX_SOCKET=${m.socket}`, `export SPARROW_TMUX_PREFIX=${m.prefix}`, `sparrow sandbox down --dir ${dir}`])
      expect(text.stdout).toContain(line);
    const h = await health(m.port);
    expect(h?.ok).toBe(true);
    expect(psCommand(h.pid)).toContain(`up --home ${m.home} --port ${m.port}`);
    // a tmux socket of its own, so `down` has something to kill
    Bun.spawnSync(['tmux', '-L', m.socket, 'new-session', '-d', '-s', 'x', 'sleep 60']);
    expect(Bun.spawnSync(['tmux', '-L', m.socket, 'ls']).exitCode).toBe(0);
    const down = await run(['sandbox', 'down', '--dir', dir]);
    expect(down.stderr).toBe('');
    expect(down.stdout).toContain(`stopped (pid ${h.pid})`);
    expect(await health(m.port)).toBeNull();
    expect(Bun.spawnSync(['tmux', '-L', m.socket, 'ls'], { stderr: 'ignore' }).exitCode).not.toBe(0);
  }, 40_000);

  test('two sandboxes get different ports/sockets; down stops only the named one; up is idempotent', async () => {
    const root = tempDir('sbx-');
    const a = join(root, 'a'), b = join(root, 'b');
    const ia = await up(a), ib = await up(b);
    expect(ia.port).not.toBe(ib.port);
    expect(ia.socket).not.toBe(ib.socket);
    expect(ia.prefix).not.toBe(ib.prefix);
    const again = JSON.parse((await run(['sandbox', 'up', '--dir', a, '--json'])).stdout);
    expect(again.port).toBe(ia.port); expect(again.reused).toBe(true);
    expect((await run(['sandbox', 'down', '--dir', a])).code).toBe(0);
    expect(await health(ia.port)).toBeNull();
    expect((await health(ib.port))?.ok).toBe(true);
  }, 60_000);

  test('allowed from an agent window; the server does not inherit the agent identity and the wrapper drops it', async () => {
    const dir = join(tempDir('sbx-'), 'agent');
    const info = await up(dir, AGENT);
    expect((await health(info.port))?.ok).toBe(true);
    const wrapper = join(dir, 'sbx');
    // the wrapper runs sparrow against the sandbox even though the caller is an agent with AGENT_ID/URL set
    const p = Bun.spawn([wrapper, 'status'], { env: { ...(process.env as Record<string, string>), ...AGENT }, stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).toContain(`http://127.0.0.1:${info.port}`);
    expect(out).toContain(`Home: ${info.home}`);
    const d = await run(['sandbox', 'down', '--dir', dir], { env: AGENT });
    expect(d.code).toBe(0);
  }, 40_000);

  test('skills are isolated by default: SPARROW_SKILLS_HOME=<dir>/skills-home (created), exported, in the wrapper, and what the server really uses', async () => {
    const dir = join(tempDir('sbx-'), 'skills');
    const text = await run(['sandbox', 'up', '--dir', dir]); made.push(dir);
    expect(text.code).toBe(0);
    const m = meta(dir);
    expect(m.skillsHome).toBe(join(dir, 'skills-home'));
    expect(existsSync(m.skillsHome)).toBe(true);
    expect(text.stdout).toContain(`export SPARROW_SKILLS_HOME=${m.skillsHome}`);
    expect(readFileSync(join(dir, 'sbx'), 'utf8')).toContain(`SPARROW_SKILLS_HOME='${m.skillsHome}'`);
    // the running server resolves its skill paths from it, never from the real HOME
    const state = await (await fetch(`http://127.0.0.1:${m.port}/api/skills`)).json() as any;
    expect(state.paths.home).toBe(m.skillsHome);
    expect(state.paths.sandbox).toBe(true);
    expect(state.paths.library).toBe(join(m.skillsHome, 'Skills'));
    // up is idempotent and prints the same value again
    const again = await run(['sandbox', 'up', '--dir', dir]);
    expect(again.stdout).toContain(`export SPARROW_SKILLS_HOME=${m.skillsHome}`);
  }, 40_000);

  test('a SPARROW_SKILLS_HOME the caller already set wins over the default', async () => {
    const dir = join(tempDir('sbx-'), 'mine');
    const mine = join(tempDir('sbx-skills-'), 'my-skills');
    const info = await up(dir, { SPARROW_SKILLS_HOME: mine });
    expect(info.skillsHome).toBe(mine);
    expect(meta(dir).skillsHome).toBe(mine);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(join(dir, 'skills-home'))).toBe(false);
    const state = await (await fetch(`http://127.0.0.1:${info.port}/api/skills`)).json() as any;
    expect(state.paths.home).toBe(mine);
  }, 40_000);

  test('default dir is ./.sandbox/sparrow-<n> under the cwd; down without --dir finds the only one', async () => {
    const cwd = tempDir('sbx-cwd-');
    const r = await run(['sandbox', 'up', '--json'], { cwd });
    expect(r.code).toBe(0);
    const info = JSON.parse(r.stdout);
    expect(info.dir).toBe(join(cwd, '.sandbox', 'sparrow-1'));
    made.push(info.dir);
    const second = JSON.parse((await run(['sandbox', 'up', '--json'], { cwd })).stdout);
    made.push(second.dir);
    expect(second.dir).toBe(join(cwd, '.sandbox', 'sparrow-2'));
    const amb = await run(['sandbox', 'down'], { cwd });
    expect(amb.code).toBe(1); expect(amb.stderr).toContain('several sandboxes');
    expect((await run(['sandbox', 'down', '--dir', second.dir], { cwd })).code).toBe(0);
    const only = await run(['sandbox', 'down'], { cwd });
    expect(only.code).toBe(0); expect(only.stdout).toContain('stopped');
    expect(await health(info.port)).toBeNull();
  }, 60_000);

  test('down refuses a sandbox record that names port 4040 or the real ~/.sparrow, before any I/O', async () => {
    const dir = tempDir('sbx-');
    writeFileSync(join(dir, 'sandbox.json'), JSON.stringify({ home: join(dir, 'home'), port: 4040, socket: 's', prefix: 'p-' }));
    const r = await run(['sandbox', 'down', '--dir', dir]);
    expect(r.code).toBe(1); expect(r.stderr).toContain('4040');
    const dir2 = tempDir('sbx-'); mkdirSync(join(dir2, 'fake'), { recursive: true });
    writeFileSync(join(dir2, 'sandbox.json'), JSON.stringify({ home: join(process.env.HOME!, '.sparrow'), port: 4999, socket: 's', prefix: 'p-' }));
    const r2 = await run(['sandbox', 'down', '--dir', dir2]);
    expect(r2.code).toBe(1); expect(r2.stderr).toContain('real ~/.sparrow');
    expect((await run(['sandbox', 'down', '--dir', join(dir, 'nope')])).stderr).toContain('no sandbox at');
  });
});

describe('down trusts the directory, not sandbox.json (theo2: tampering)', () => {
  const edit = (dir: string, patch: Record<string, unknown>) => writeFileSync(join(dir, 'sandbox.json'), JSON.stringify({ ...meta(dir), ...patch }, null, 2));
  const tmuxAlive = (sock: string) => Bun.spawnSync(['tmux', '-L', sock, 'ls'], { stderr: 'ignore' }).exitCode === 0;

  test('BUG-2: editing C\'s home/port/url to sibling B\'s values does not stop B (nor C): refused with what disagrees', async () => {
    const root = tempDir('sbx-');
    const b = join(root, 'b'), c = join(root, 'c');
    const ib = await up(b), ic = await up(c);
    const orig = meta(c);
    edit(c, { home: ib.home, port: ib.port, url: `http://127.0.0.1:${ib.port}` });
    const r = await run(['sandbox', 'down', '--dir', c]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('disagrees with');
    expect(r.stderr).toContain(`home: file says ${ib.home}, directory implies ${ic.home}`);
    expect((await health(ib.port))?.ok).toBe(true);   // sibling B untouched
    expect((await health(ic.port))?.ok).toBe(true);   // and C was not stopped half-way
    // same lie about the port only (home honest): refused too, B survives
    edit(c, { ...orig, port: ib.port });
    const r2 = await run(['sandbox', 'down', '--dir', c]);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain(`port: file says ${ib.port}, this home's server.pid says ${ic.port}`);
    expect((await health(ib.port))?.ok).toBe(true);
    edit(c, orig);
    expect((await run(['sandbox', 'down', '--dir', c])).code).toBe(0);
    expect(await health(ic.port)).toBeNull();
  }, 60_000);

  test('BUG-1: editing the recorded tmux socket/prefix does not kill another tmux server', async () => {
    const dir = join(tempDir('sbx-'), 'd');
    const info = await up(dir);
    const orig = meta(dir);
    const other = `unrelated-${info.port}`;
    try {
      Bun.spawnSync(['tmux', '-L', other, 'new-session', '-d', '-s', 'x', 'sleep 60']);
      Bun.spawnSync(['tmux', '-L', info.socket, 'new-session', '-d', '-s', 'x', 'sleep 60']);
      edit(dir, { socket: other });
      const r = await run(['sandbox', 'down', '--dir', dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`tmux socket: file says ${other}, directory implies ${info.socket}`);
      expect(tmuxAlive(other)).toBe(true);
      expect(tmuxAlive(info.socket)).toBe(true);
      expect((await health(info.port))?.ok).toBe(true);
      edit(dir, { prefix: 'sbx-evil-' });
      const r2 = await run(['sandbox', 'down', '--dir', dir]);
      expect(r2.code).toBe(1); expect(r2.stderr).toContain('tmux prefix: file says sbx-evil-');
      edit(dir, orig);
      expect((await run(['sandbox', 'down', '--dir', dir])).code).toBe(0);
      expect(tmuxAlive(info.socket)).toBe(false);   // its own socket is killed (derived from the dir)
      expect(tmuxAlive(other)).toBe(true);          // the unrelated one never is
    } finally { Bun.spawnSync(['tmux', '-L', other, 'kill-server'], { stderr: 'ignore' }); }
  }, 60_000);

  test('the socket and prefix are a function of the directory: stable across re-up, different per dir', async () => {
    const root = tempDir('sbx-');
    const a = await up(join(root, 'a')), b = await up(join(root, 'b'));
    expect(a.socket).toMatch(/^sbx-[0-9a-f]{10}$/);
    expect(a.socket).not.toBe(b.socket);
    expect(a.prefix).not.toBe(b.prefix);
    const again = JSON.parse((await run(['sandbox', 'up', '--dir', join(root, 'a'), '--json'])).stdout);
    expect(again.socket).toBe(a.socket);
  }, 60_000);

  test('a record whose server is not this home\'s: a decoy on the recorded port is never stopped', async () => {
    const dir = join(tempDir('sbx-'), 'd');
    const info = await up(dir);
    expect((await run(['sandbox', 'down', '--dir', dir])).code).toBe(0);   // legit stop first; now no server.pid
    const decoyPort = await freePort();
    const decoy = Bun.serve({ port: decoyPort, hostname: '127.0.0.1', fetch: () => Response.json({ ok: true, pid: process.pid, version: '0', started_at: 1 }) });
    try {
      writeFileSync(join(dir, 'sandbox.json'), JSON.stringify({ home: join(dir, 'home'), port: decoyPort, socket: info.socket, prefix: info.prefix, url: `http://127.0.0.1:${decoyPort}` }));
      const r = await run(['sandbox', 'down', '--dir', dir]);
      expect(r.code).toBe(0);                         // nothing of this home to stop
      expect(r.stdout).toContain('not running');
      expect((await health(decoyPort))?.ok).toBe(true);
    } finally { decoy.stop(true); }
  }, 40_000);
});
