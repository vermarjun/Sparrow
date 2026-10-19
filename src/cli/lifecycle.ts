// The default command owns only a detached server process; it never owns agent windows.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, LOG_FILE, PID_FILE, PORT, SERVER_URL, SPARROW_HOME } from '../shared/config';
import { AGENT_ENV_VARS } from './guard';
import { isSandboxHome } from '../harness/env';
import { ensureWebBuilt } from './install';

// Lifecycle commands manage the server that owns THIS SPARROW_HOME / SPARROW_PORT. Agent windows export SPARROW_URL
// (the server that spawned them); it must never redirect `SPARROW_HOME=… SPARROW_PORT=… sparrow stop` to that server.
const LIFECYCLE_URL = process.env.SPARROW_PORT ? `http://127.0.0.1:${PORT}` : SERVER_URL;

export interface Health { ok: true; pid: number; version: string; started_at: number }
export async function health(): Promise<Health | null> {
  try {
    const r = await fetch(`${LIFECYCLE_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return null;
    const h = await r.json() as Health;
    return h.ok === true && Number.isInteger(h.pid) && typeof h.version === 'string' ? h : null;
  } catch { return null; }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readPid(): { pid: number; port: number } | null {
  try {
    const p = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    return Number.isInteger(p.pid) && p.pid > 1 ? p : null;
  } catch { return null; }
}
function removePid() { try { unlinkSync(PID_FILE); } catch {} }
function command(pid: number): string {
  return Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim();
}
function isServer(pid: number) {
  const cmd = command(pid);
  return cmd.includes(BIN) && /\bup\b/.test(cmd);
}
function argvValue(cmd: string, name: 'home' | 'port'): string | null {
  const m = cmd.match(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(.*?)(?=\\s+--[\\w-]+(?:=|\\s)|$)`));
  const value = m?.[1]?.trim();
  return value ? value.replace(/^(?:"(.*)"|'(.*)')$/, (_whole, double: string, single: string) => double ?? single) : null;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
/** The `--home` value in a server's command line (`sparrow up --home <dir> --port N`), or null. */
function argvHome(cmd: string): string | null { return argvValue(cmd, 'home'); }
function argvPort(cmd: string): number | null {
  const value = argvValue(cmd, 'port');
  return value && /^\d+$/.test(value) ? Number(value) : null;
}
function listeningPids(port = PORT): number[] {
  const r = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { stdout: 'pipe', stderr: 'ignore' });
  return [...new Set([...r.stdout.toString().matchAll(/^p(\d+)$/gm)].map(m => Number(m[1])))];
}
function confirmsHomeAndPort(pid: number): boolean {
  if (!isServer(pid)) return false;
  const cmd = command(pid);
  const home = argvHome(cmd);
  return home !== null && real(home) === real(SPARROW_HOME) && argvPort(cmd) === PORT;
}
/**
 * Does THIS SPARROW_HOME own the server answering at LIFECYCLE_URL (pid)? Yes when this home's server.pid names that pid,
 * or, with no usable pidfile, when its command line carries this home and port. Otherwise returns why not, naming the
 * other server's home/pid so stop/up never signal or adopt a server that belongs to someone else.
 */
export function foreignServer(pid: number, where = LIFECYCLE_URL): string | null {
  const target = new URL(where);
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const saved = readPid();
  if (saved && saved.pid === pid && saved.port === targetPort) return null;
  const cmd = command(pid);
  const home = argvHome(cmd);
  const port = argvPort(cmd);
  if ((!saved || !alive(saved.pid)) && home !== null && real(home) === real(SPARROW_HOME) && port === targetPort) {
    return null;
  }
  const whose = home !== null ? `home ${home}` : 'unknown home (no --home in its command line, not this home\'s pidfile)';
  const portInfo = port === null ? 'no --port in its command line' : `port ${port}`;
  const recovery = !saved || !alive(saved.pid)
    ? ` No usable ${PID_FILE} proves ownership; to stop safely, inspect lsof -nP -iTCP:${targetPort} -sTCP:LISTEN and ps -p ${pid} -o command=, then confirm both --home and --port.`
    : '';
  return `The server answering at ${where} (pid ${pid}, ${whose}, ${portInfo}) does not belong to SPARROW_HOME ${SPARROW_HOME} on port ${targetPort} based on its saved or command-line identity; refusing to touch it.${recovery}`;
}

export function portOwner(): string | null {
  const pids = listeningPids();
  return pids.length ? [...new Set(pids)].map(pid => `pid ${pid} (${command(pid) || 'unknown command'})`).join(', ') : null;
}

export async function startDetached(): Promise<Health> {
  mkdirSync(SPARROW_HOME, { recursive: true });
  const lock = join(SPARROW_HOME, 'start.lock');
  let held = false;
  for (let i = 0; i < 120; i++) {
    try {
      const fd = openSync(lock, 'wx');
      writeFileSync(fd, String(process.pid)); closeSync(fd); held = true; break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try { if (!alive(Number(readFileSync(lock, 'utf8')))) unlinkSync(lock); } catch {}
      await Bun.sleep(250);
    }
  }
  if (!held) throw new Error('Another Sparrow start is still in progress; retry shortly.');
  try {
    const running = await health();
    if (running) {
      const foreign = foreignServer(running.pid);
      if (foreign) throw new Error(foreign);
      const built = await ensureWebBuilt();
      if (!built.ok) throw new Error(built.line);
      return running;
    }
    const stale = readPid();
    if (!stale || !alive(stale.pid) || !isServer(stale.pid)) removePid();
    const owner = portOwner();
    if (owner) throw new Error(`Port ${PORT} is occupied by ${owner}; stop that process or choose SPARROW_PORT.`);
    const built = await ensureWebBuilt();
    if (!built.ok) throw new Error(built.line);
    const log = openSync(LOG_FILE, 'a');
    let child;
    try {
      const env = { ...process.env };
      for (const k of AGENT_ENV_VARS) delete env[k];
      // --home puts this server's home in its command line (`ps`), so a pattern can't confuse it with a sandbox's.
      child = spawn(process.execPath, [BIN, 'up', '--home', SPARROW_HOME, '--port', String(PORT)], {
        detached: true, stdio: ['ignore', log, log], env,
      });
      await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
      child.unref();
    } finally { closeSync(log); }
    for (let i = 0; i < 120; i++) {
      const h = await health();
      if (h) return h;
      if (child.pid && !alive(child.pid)) break;
      await Bun.sleep(250);
    }
    throw new Error(`Server did not become healthy at ${LIFECYCLE_URL}; inspect ${LOG_FILE}.`);
  } finally { try { unlinkSync(lock); } catch {} }
}

/**
 * Wait until GET /api/catalog has an entry (ok or failed) for every harness, so the UI opens with full model lists.
 * The server fetches them in the background after listening; claude/opencode take a few seconds. Never fails:
 * after timeoutMs the browser opens anyway and the UI fills in on catalog.updated.
 */
export async function waitForCatalogs(opts: { url?: string; timeoutMs?: number; harnesses?: string[]; say?: (line: string) => void; pollMs?: number } = {}): Promise<{ complete: boolean; have: string[] }> {
  const url = opts.url ?? LIFECYCLE_URL;
  const want = opts.harnesses ?? ['claude', 'codex', 'opencode'];
  const end = Date.now() + (opts.timeoutMs ?? startupCatalogWaitMs());
  let said = false;
  let have: string[] = [];
  for (;;) {
    try {
      const r = await fetch(`${url}/api/catalog`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) have = ((await r.json()) as { harness: string }[]).map((c) => c.harness);
    } catch { /* not answering yet */ }
    if (want.every((h) => have.includes(h))) return { complete: true, have };
    if (Date.now() >= end) return { complete: false, have };
    if (!said) { opts.say?.('Loading model lists…'); said = true; }
    await Bun.sleep(opts.pollMs ?? 250);
  }
}

export function startupCatalogWaitMs(): number {
  return isSandboxHome() ? 0 : 20_000;
}

export async function openUi(opts: { say?: (line: string) => void } = {}) {
  const h = await startDetached();
  await waitForCatalogs({ say: opts.say });
  const p = Bun.spawn(['open', LIFECYCLE_URL], { stdout: 'ignore', stderr: 'pipe' });
  const err = await new Response(p.stderr).text();
  if (await p.exited) console.error(`Could not open the browser: ${err.trim()}`);
  return { health: h, url: LIFECYCLE_URL, log: LOG_FILE };
}

export async function stopServer(): Promise<string> {
  const h = await health();
  const saved = readPid();
  let pid = h?.pid ?? (saved && alive(saved.pid) ? saved.pid : null);
  let foundByArgs = false;
  if (!pid) {
    const listeners = listeningPids();
    const owned = listeners.filter(confirmsHomeAndPort);
    if (owned.length === 1 && listeners.length === 1) {
      [pid] = owned;
      foundByArgs = true;
    } else if (listeners.length) {
      const details = listeners.map(p => `pid ${p} (${command(p) || 'unknown command'})`).join(', ');
      const reason = owned.length ? 'The port has multiple listeners, so ownership is ambiguous' : `None confirms both --home ${SPARROW_HOME} and --port ${PORT}`;
      throw new Error(`No healthy Sparrow server answered at ${LIFECYCLE_URL} and no usable ${PID_FILE} was found. Port ${PORT} has listener(s): ${details}. ${reason}, so no process was signalled. Inspect with lsof and ps before stopping anything.`);
    } else {
      removePid();
      return 'Sparrow server: not running.';
    }
  }
  if (!pid || !alive(pid)) { removePid(); return 'Sparrow server: not running.'; }
  if (h && saved && saved.pid !== h.pid && alive(saved.pid)) {
    throw new Error(`The server answering at ${LIFECYCLE_URL} (pid ${h.pid}) is not the one recorded in ${PID_FILE} (pid ${saved.pid}); refusing to stop it.`);
  }
  if (h) {
    const foreign = foreignServer(h.pid);
    if (foreign) throw new Error(foreign);
  }
  // A stale pidfile can point at an unrelated process after PID reuse.
  if (!h && !isServer(pid)) { removePid(); return `Sparrow server: not running (removed stale pidfile for pid ${pid}).`; }
  if (!h && saved && saved.port !== PORT) throw new Error(`Pidfile belongs to port ${saved.port}; set SPARROW_PORT to that port before stopping.`);
  if (!h && saved?.pid === pid && !confirmsHomeAndPort(pid)) {
    throw new Error(`Pidfile ${PID_FILE} names pid ${pid}, but its command line does not confirm --home ${SPARROW_HOME} and --port ${PORT}; no process was signalled. Inspect the listener with lsof and ps before stopping anything.`);
  }
  if (foundByArgs && !confirmsHomeAndPort(pid)) throw new Error(`pid ${pid} no longer confirms --home ${SPARROW_HOME} and --port ${PORT}; refusing to stop it.`);
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(100);
  if (alive(pid)) {
    // Re-check ownership before the fallback signal.
    if (!isServer(pid)) throw new Error(`pid ${pid} did not stop; inspect it manually before sending SIGKILL.`);
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(100);
  }
  if (alive(pid)) throw new Error(`pid ${pid} is still present after SIGKILL; inspect ${LOG_FILE}.`);
  removePid();
  return `Sparrow server: stopped (pid ${pid}${foundByArgs ? `, confirmed by --home ${SPARROW_HOME} and --port ${PORT}` : ''}).`;
}
