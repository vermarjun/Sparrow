#!/usr/bin/env bun
// Isolated smoke test of a compiled binary, copied OUTSIDE the repo:
//   bun scripts/smoke-binary.ts [dist/bin/sparrow-darwin-arm64]     (default: this machine's binary in dist/bin)
// Own HOME, SPARROW_HOME, free port, tmux socket. Checks: --version, first run (setup + server), UI served, status,
// fake-harness hire -> update -> done -> window closed, hook speed, no repo path in the app dir or launch scripts,
// then stops the server and kills its tmux socket. Needs tmux. Never touches ~/.sparrow, :4040 or your tmux server.
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { hostTarget, outName } from './build-binary';

const ROOT = resolve(import.meta.dir, '..');
const bin = resolve(process.argv[2] ?? join(ROOT, 'dist', 'bin', outName(hostTarget())));
if (!existsSync(bin)) { console.error(`usage: bun scripts/smoke-binary.ts [path to compiled sparrow binary]; ${bin} not found (bun scripts/build-binary.ts builds it)`); process.exit(2); }

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sparrow-smoke-')));
const exe = join(tmp, 'bin', basename(bin));   // keeps its release name (sparrow-<os>-<arch>): agents then need the app's `sparrow` shim on PATH
mkdirSync(join(tmp, 'bin'));
copyFileSync(bin, exe); chmodSync(exe, 0o755);
const home = join(tmp, 'home'); const sh = join(tmp, 'sh'); const work = join(tmp, 'work');
for (const d of [home, work]) mkdirSync(d, { recursive: true });
const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
const port = srv.port as number; srv.stop(true);
const tag = `smoke${process.pid}`;
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(SPARROW_|CLAUDE|CODEX_|OPENCODE)/.test(k)) env[k] = v;
// A PATH without any other sparrow, so the first-run link into ~/.local/bin is exercised.
env.PATH = (env.PATH ?? '').split(':').filter((d) => d && !existsSync(join(d, 'sparrow'))).join(':');
Object.assign(env, { HOME: home, SPARROW_HOME: sh, SPARROW_PORT: String(port), SPARROW_TMUX_SOCKET: tag, SPARROW_TMUX_PREFIX: `${tag}-`, SPARROW_NO_OPEN: '1', SPARROW_SKILLS_HOME: home, SPARROW_NO_CATALOG_REFRESH: '1' });

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };
async function sp(args: string[], opts: { cwd?: string } = {}) {
  const t0 = performance.now();
  const p = Bun.spawn([exe, ...args], { cwd: opts.cwd ?? tmp, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err, ms: Math.round(performance.now() - t0) };
}
const grep = (dir: string, needle: string): string[] => {
  const hits: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && readFileSync(p).includes(needle)) hits.push(p); } };
  if (existsSync(dir)) walk(dir);
  return hits;
};

try {
  const v = await sp(['--version']);
  check('--version', v.code === 0 && /^sparrow \d+\.\d+\.\d+/.test(v.out), v.out.trim());
  const first = await sp([]);
  check('first run sets up and starts the server', first.code === 0 && first.out.includes('first run') && first.out.includes(`http://127.0.0.1:${port}`), `exit ${first.code} ${first.err.trim().slice(0, 200)}`);
  console.log(first.out.split('\n').map((l) => '    ' + l).join('\n'));
  const ui = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => '');
  check('GET / returns the app HTML', /<!doctype html>/i.test(ui) && ui.includes('<title>Sparrow</title>'));
  const st = await sp(['status']);
  check('status is up', st.code === 0 && st.out.includes('Sparrow server: up'), st.out.split('\n')[0]);
  check('first run linked ~/.local/bin/sparrow to the binary', existsSync(join(home, '.local', 'bin', 'sparrow')) && Bun.spawnSync(['readlink', join(home, '.local', 'bin', 'sparrow')]).stdout.toString().trim() === exe);
  const [i1, i2] = await Promise.all([sp(['install', '--force']), sp(['install', '--force'])]);
  check('two installs at once both succeed (race-safe link)', i1.code === 0 && i2.code === 0, `${i1.code}/${i2.code} ${(i1.err + i2.err).trim().slice(0, 120)}`);
  const again = await sp([]);
  check('second plain `sparrow` does not set up again', again.code === 0 && !again.out.includes('first run'));
  writeFileSync(join(sh, 'resumes', 'fake.md'), '---\nname: fake\ntitle: Fake\nharness: fake\ncan_hire: []\n---\nTest worker.\n');
  await Bun.spawn(['git', 'init', '-q', work], { stdout: 'ignore', stderr: 'ignore' }).exited;
  const hire = await sp(['hire', 'fake', 'FAKE:update working\nFAKE:done smoke-ok', '--json'], { cwd: work });
  check('hire (fake harness)', hire.code === 0, hire.err.trim().slice(0, 200));
  let done = '';
  for (let i = 0; i < 40 && !done.includes('smoke-ok'); i++) { await Bun.sleep(500); done = (await sp(['log'], { cwd: work })).out; }
  check('agent reported update + done', done.includes('[update]') && done.includes('result: ok') && done.includes('smoke-ok'));
  const win = () => Bun.spawnSync(['tmux', '-L', tag, 'list-windows', '-a'], { stdout: 'pipe', stderr: 'pipe' });
  let closed = false;
  for (let i = 0; i < 40 && !closed; i++) { const w = win(); closed = w.exitCode !== 0 || !w.stdout.toString().includes('james'); if (!closed) await Bun.sleep(500); }
  check('agent window closed after done', closed);
  const scripts = readdirSync(join(sh, 'agents')).flatMap((a) => (existsSync(join(sh, 'agents', a, 'calls')) ? readdirSync(join(sh, 'agents', a, 'calls')).filter((f) => f.endsWith('.sh')).map((f) => join(sh, 'agents', a, 'calls', f)) : []));
  const script = scripts.length ? readFileSync(scripts[0], 'utf8') : '';
  check('launch script hooks go through the binary', script.includes(`${exe} hook exit`) && !/\bbun\b|\.ts\b/.test(script.replace(/# sparrow launch.*/, '')));
  check('agents get a `sparrow` on PATH (the app shim, since the binary is not named sparrow)', /export PATH=\S*\/app\/[^/]+\/bin:/.test(script) && readdirSync(join(sh, 'app')).some((v) => existsSync(join(sh, 'app', v, 'bin', 'sparrow'))));
  check('launch script runs the fake agent through the binary', script.includes(`${exe} __fake-agent`));
  const repoHits = [...grep(join(sh, 'app'), ROOT), ...grep(join(sh, 'agents'), ROOT), ...grep(join(sh, 'claude-plugin'), ROOT), ...grep(join(sh, 'opencode'), ROOT)];
  check('no repo path in the app dir, agents, plugins', repoHits.length === 0, repoHits.slice(0, 3).join(', '));
  const sbx = join(tmp, 'sbx');
  const sup = await sp(['sandbox', 'up', '--dir', sbx]);
  const sport = Number(sup.out.match(/SPARROW_PORT=(\d+)/)?.[1]);
  const sstat = sport ? await fetch(`http://127.0.0.1:${sport}/api/health`).then((r) => r.json()).catch(() => null) as { ok?: boolean } | null : null;
  check('sandbox up starts a second server through the binary', sup.code === 0 && sstat?.ok === true, sup.err.trim().slice(0, 200));
  const sdown = await sp(['sandbox', 'down', '--dir', sbx]);
  check('sandbox down stops it', sdown.code === 0 && sdown.out.includes('stopped'), sdown.out.trim().slice(0, 120));
  const rec = JSON.parse(readFileSync(join(sh, 'installed.json'), 'utf8'));
  writeFileSync(join(sh, 'installed.json'), JSON.stringify({ ...rec, version: '0.0.1' }));
  const up = await sp([]);
  check('an older install record triggers the upgrade path', up.out.includes('upgraded from 0.0.1'), up.out.split('\n')[0]);
  const hookEnv = { ...env, SPARROW_AGENT_ID: 'ag_none', SPARROW_URL: `http://127.0.0.1:${port}` };
  const timeHook = async (args: string[]) => {
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      await Bun.spawn([exe, 'hook', ...args], { env: hookEnv, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).exited;
      times.push(Math.round(performance.now() - t0));
    }
    return { times, med: [...times].sort((a, b) => a - b)[3] };
  };
  const cold = await timeHook(['noop']);   // process start + module load only (no server call)
  check('hook startup (median of 6) under 150ms', cold.med < 150, `${cold.times.join(', ')} ms`);
  const live = await timeHook(['session', '--session', 'x']);   // with the server round trip
  check('hook with a server call (median of 6) under 150ms', live.med < 150, `${live.times.join(', ')} ms`);
} finally {
  const stop = await sp(['stop']);
  console.log(stop.out.trim() || stop.err.trim());
  Bun.spawnSync(['tmux', '-L', tag, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
