// `sparrow sandbox up|down` (D19): the safe way to get a throwaway Sparrow server, for agents and humans alike.
// A sandbox owns a directory: <dir>/home (SPARROW_HOME), <dir>/skills-home (SPARROW_SKILLS_HOME: skills never touch the
// real ~/Skills or harness folders), a free port (never 4040), its own tmux socket and prefix.
// The server is detached with `--home` in its argv; `down` stops only the server that home owns, then kills the socket.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BIN } from '../shared/config';
import { AGENT_ENV_VARS } from './guard';

export interface SandboxInfo { dir: string; home: string; skillsHome: string; port: number; socket: string; prefix: string; url: string }

const META = 'sandbox.json';
/** Vars a sandbox command must not inherit from the caller (an agent window's identity and its server). */
const DROP = [...AGENT_ENV_VARS, 'SPARROW_URL', 'SPARROW_AGENT_URL', 'SPARROW_HOME', 'SPARROW_PORT', 'SPARROW_TMUX_SOCKET', 'SPARROW_TMUX_PREFIX'];

export async function freePort(): Promise<number> {
  for (;;) {
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = srv.port as number;
    srv.stop(true);
    if (port !== 4040) return port;
  }
}

async function health(port: number): Promise<{ pid: number } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const j = r.ok ? (await r.json()) as any : null;
    return j?.ok ? j : null;
  } catch { return null; }
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

function sandboxEnv(i: SandboxInfo): Record<string, string> {
  return { SPARROW_HOME: i.home, SPARROW_SKILLS_HOME: i.skillsHome, SPARROW_PORT: String(i.port), SPARROW_TMUX_SOCKET: i.socket, SPARROW_TMUX_PREFIX: i.prefix };
}
function cleanEnvFor(i: SandboxInfo): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.includes(k)) env[k] = v;
  return { ...env, ...sandboxEnv(i) };
}

/** Everything about a sandbox that follows from its directory alone: nothing here is read from sandbox.json. */
function derive(dirArg: string): { dir: string; home: string; skillsHome: string; socket: string; prefix: string } {
  const dir = real(resolve(dirArg));
  const h = createHash('sha1').update(dir).digest('hex').slice(0, 10);
  return { dir, home: join(dir, 'home'), skillsHome: join(dir, 'skills-home'), socket: `sbx-${h}`, prefix: `sbx${h}-` };
}

/** The port the server owned by <home> recorded in its own server.pid, or null when that home has no server. */
function pidfilePort(home: string): number | null {
  try {
    const p = JSON.parse(readFileSync(join(home, 'server.pid'), 'utf8'));
    return Number.isInteger(p.port) ? p.port : null;
  } catch { return null; }
}

/**
 * Load <dir>/sandbox.json and check it against what the directory itself implies (D19). The file is only a note:
 * home, tmux socket and prefix must equal the values derived from --dir, and the recorded port must be the one this
 * home's own server.pid names. Any disagreement refuses, naming what disagrees; nothing is ever acted on from the file.
 */
function load(dirArg: string): SandboxInfo {
  const d = derive(dirArg);
  const f = join(d.dir, META);
  if (!existsSync(f)) throw new Error(`no sandbox at ${d.dir} (no ${META}); start one with: sparrow sandbox up --dir ${d.dir}`);
  let m: any;
  try { m = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error(`${f} is not valid JSON`); }
  if (m?.port === 4040) throw new Error(`sandbox at ${d.dir} names port 4040 (the user's server); refusing.`);
  if (typeof m?.home === 'string' && real(m.home) === real(join(homedir(), '.sparrow'))) throw new Error(`sandbox at ${d.dir} names the real ~/.sparrow; refusing.`);
  if (real(d.home).startsWith(real(join(homedir(), '.sparrow')))) throw new Error(`sandbox dir ${d.dir} is inside the real ~/.sparrow; refusing.`);
  const bad: string[] = [];
  if (typeof m?.home !== 'string' || real(m.home) !== real(d.home)) bad.push(`home: file says ${m?.home}, directory implies ${d.home}`);
  if (m?.socket !== d.socket) bad.push(`tmux socket: file says ${m?.socket}, directory implies ${d.socket}`);
  if (m?.prefix !== d.prefix) bad.push(`tmux prefix: file says ${m?.prefix}, directory implies ${d.prefix}`);
  if (!Number.isInteger(m?.port)) bad.push(`port: file says ${m?.port}, not a port number`);
  else {
    const live = pidfilePort(d.home);
    if (live !== null && live !== m.port) bad.push(`port: file says ${m.port}, this home's server.pid says ${live}`);
  }
  if (bad.length) throw new Error(`${f} disagrees with ${d.dir}; refusing to act on it:\n  ${bad.join('\n  ')}`);
  // The skills home is a note too (a caller may have chosen their own at `up`); only ever exported, never acted on here.
  const skillsHome = typeof m?.skillsHome === 'string' && m.skillsHome ? m.skillsHome : d.skillsHome;
  return { ...d, skillsHome, port: m.port, url: `http://127.0.0.1:${m.port}` };
}

function envLines(i: SandboxInfo): string {
  const wrapper = join(i.dir, 'sbx');
  return [
    `Sandbox Sparrow: ${i.url} · home ${i.home} · tmux socket ${i.socket}`,
    ...Object.entries(sandboxEnv(i)).map(([k, v]) => `export ${k}=${v}`),
    '',
    `Run sandbox commands without touching your own identity/reporting (your window keeps reporting to its own server):`,
    `  ${wrapper} <sparrow args>      # e.g. ${wrapper} hire fake "FAKE:done ok"; it drops SPARROW_AGENT_ID/URL/WINDOW/HARNESS`,
    `Stop it with: sparrow sandbox down --dir ${i.dir}`,
  ].join('\n');
}

function writeWrapper(i: SandboxInfo) {
  const unsets = DROP.filter((k) => !(k in sandboxEnv(i))).map((k) => `-u ${k}`).join(' ');
  const sets = Object.entries(sandboxEnv(i)).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(' ');
  const f = join(i.dir, 'sbx');
  writeFileSync(f, `#!/bin/sh\n# sparrow sandbox wrapper: runs sparrow against this sandbox only.\nexec env ${unsets} ${sets} '${process.execPath}' '${BIN}' "$@"\n`);
  chmodSync(f, 0o755);
}

function defaultDir(): string {
  const root = resolve('.sandbox');
  for (let n = 1; ; n++) if (!existsSync(join(root, `sparrow-${n}`))) return join(root, `sparrow-${n}`);
}

export async function sandboxUp(dirArg?: string): Promise<{ info: SandboxInfo; text: string; reused: boolean }> {
  const wanted = resolve(dirArg ?? defaultDir());
  mkdirSync(join(wanted, 'home'), { recursive: true });
  const { dir, home, socket, prefix, skillsHome: defaultSkillsHome } = derive(wanted);
  // Skills isolation by default: the caller's own SPARROW_SKILLS_HOME wins, otherwise <dir>/skills-home (created), so a
  // sandbox server (and the agents it launches, which inherit its env) can never touch ~/Skills or the harness folders.
  const callerSkills = process.env.SPARROW_SKILLS_HOME?.trim();
  const skillsHome = callerSkills ? resolve(callerSkills) : defaultSkillsHome;
  mkdirSync(skillsHome, { recursive: true });
  // Re-running `up` for a live sandbox just prints its env again.
  if (existsSync(join(dir, META))) {
    const prev = load(dir);
    if (await health(prev.port)) { writeWrapper(prev); return { info: prev, text: envLines(prev), reused: true }; }
  }
  const port = await freePort();
  const info: SandboxInfo = { dir, home, skillsHome, port, socket, prefix, url: `http://127.0.0.1:${port}` };
  writeFileSync(join(dir, META), JSON.stringify({ home, skillsHome, port, socket: info.socket, prefix: info.prefix, url: info.url }, null, 2) + '\n');
  writeWrapper(info);
  const log = openSync(join(dir, 'server.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [BIN, 'up', '--home', home, '--port', String(port)], {
      detached: true, stdio: ['ignore', log, log], env: cleanEnvFor(info),
    });
    await new Promise<void>((ok, bad) => { child!.once('spawn', ok); child!.once('error', bad); });
    child.unref();
  } finally { closeSync(log); }
  for (let i = 0; i < 120; i++) {
    if (await health(port)) return { info, text: envLines(info), reused: false };
    await Bun.sleep(250);
  }
  throw new Error(`sandbox server did not become healthy on ${info.url}; inspect ${join(dir, 'server.log')}`);
}

export async function sandboxDown(dirArg?: string): Promise<string> {
  let dir: string;
  if (dirArg) dir = resolve(dirArg);
  else {
    const root = resolve('.sandbox');
    const found = existsSync(root) ? readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, META))) : [];
    if (found.length !== 1) throw new Error(found.length ? `several sandboxes under ${root}; pass --dir (${found.join(', ')})` : `no sandbox under ${root}; pass --dir`);
    dir = found[0];
  }
  const info = load(dir);   // refuses on any disagreement between sandbox.json and the directory
  // Stop through the ownership-checked `sparrow stop` of exactly this home (D18): it signals only the server whose
  // server.pid, or `--home` argv, is this home. The port comes from this home's own pidfile, not from the file.
  const live = pidfilePort(info.home);
  const lines: string[] = [];
  if (live === null) lines.push('Sparrow server: not running (this home has no server.pid).');
  else {
    const r = spawnSync(process.execPath, [BIN, 'stop'], { env: cleanEnvFor({ ...info, port: live }), encoding: 'utf8' });
    lines.push((r.stdout + r.stderr).trim());
    if (r.status !== 0) throw new Error(lines[0] || 'sparrow stop failed');
  }
  // The socket name is derived from the directory (sbx-<hash of realpath>), so it can only be this sandbox's own.
  spawnSync('tmux', ['-L', info.socket, 'kill-server'], { stdio: 'ignore' });
  lines.push(`tmux socket ${info.socket}: killed`);
  for (const f of [META, 'sbx']) { try { unlinkSync(join(info.dir, f)); } catch {} }   // a stopped sandbox is no longer "live" for `down` without --dir
  return lines.join('\n');
}
