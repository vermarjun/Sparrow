// The default command owns only a detached server process; it never owns agent windows.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, LOG_FILE, PID_FILE, PORT, SERVER_URL, SPARROW_HOME } from '../shared/config';
import { ensureWebBuilt } from './install';

export interface Health { ok: true; pid: number; version: string; started_at: number }
export async function health(): Promise<Health | null> {
  try {
    const r = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
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
export function portOwner(): string | null {
  const r = Bun.spawnSync(['lsof', '-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fp'], { stdout: 'pipe', stderr: 'ignore' });
  const pids = [...r.stdout.toString().matchAll(/^p(\d+)$/gm)].map(m => Number(m[1]));
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
      for (const k of ['SPARROW_AGENT_ID', 'SPARROW_CALL_ID']) delete env[k];
      child = spawn(process.execPath, [BIN, 'up', '--port', String(PORT)], {
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
    throw new Error(`Server did not become healthy at ${SERVER_URL}; inspect ${LOG_FILE}.`);
  } finally { try { unlinkSync(lock); } catch {} }
}

export async function openUi() {
  const h = await startDetached();
  const p = Bun.spawn(['open', SERVER_URL], { stdout: 'ignore', stderr: 'pipe' });
  const err = await new Response(p.stderr).text();
  if (await p.exited) console.error(`Could not open the browser: ${err.trim()}`);
  return { health: h, url: SERVER_URL, log: LOG_FILE };
}

export async function stopServer(): Promise<string> {
  const h = await health();
  const saved = readPid();
  const pid = h?.pid ?? saved?.pid;
  if (!pid || !alive(pid)) { removePid(); return 'Sparrow server: not running.'; }
  // A stale pidfile can point at an unrelated process after PID reuse.
  if (!h && !isServer(pid)) { removePid(); return `Sparrow server: not running (removed stale pidfile for pid ${pid}).`; }
  if (!h && saved?.port !== PORT) throw new Error(`Pidfile belongs to port ${saved?.port}; set SPARROW_PORT to that port before stopping.`);
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
  return `Sparrow server: stopped (pid ${pid}).`;
}
