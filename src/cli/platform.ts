// Linux-safe replacements for the macOS-only `open`, `lsof` and `ps` calls in the lifecycle code.
// The parsers are pure and exported so they are tested against fixture text on any OS.
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- open a URL

/** Commands to try, in order, to open `url` in a browser on this platform. Pure: platform/env/which are injected. */
export function openCommands(
  url: string, platform: string, env: Record<string, string | undefined>, which: (name: string) => string | null,
): string[][] {
  if (platform === 'darwin') return [['open', url]];
  if (platform !== 'linux') return [];
  const out: string[][] = [];
  const wsl = !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (wsl && which('wslview')) out.push(['wslview', url]);
  // xdg-open without a display falls back to a terminal browser that would block the CLI: only try with a GUI session.
  const gui = !!(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (gui) {
    for (const c of ['xdg-open', 'gio', 'sensible-browser']) {
      if (which(c)) out.push(c === 'gio' ? [c, 'open', url] : [c, url]);
    }
  }
  return out;
}

/** Open `url` in the default browser. False when nothing could (the caller prints the URL). SPARROW_NO_OPEN=1 never spawns. */
export async function openUrl(url: string): Promise<boolean> {
  if (process.env.SPARROW_NO_OPEN === '1') return false;
  for (const argv of openCommands(url, process.platform, process.env, (n) => Bun.which(n))) {
    try {
      const p = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
      // A launcher that is still running after 3 s handed the URL to a long-lived browser: count it as opened.
      const code = await Promise.race([p.exited, Bun.sleep(3000).then(() => 'running' as const)]);
      if (code === 'running') { p.unref(); return true; }
      if (code === 0) return true;
    } catch { /* try the next opener */ }
  }
  return false;
}

// ---------------------------------------------------------------- who listens on a TCP port

const uniq = (ns: number[]) => [...new Set(ns.filter((n) => Number.isInteger(n) && n > 0))];

/** Pids from `lsof -Fp` output (`p1234` lines). */
export function parseLsofPids(text: string): number[] {
  return uniq([...text.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1])));
}

/** Pids of LISTEN sockets on `port` from `ss -ltnpH` output (`… 127.0.0.1:4040 0.0.0.0:* users:(("bun",pid=12,fd=9))`). */
export function parseSsPids(text: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const local = f[3];
    if (Number(local.slice(local.lastIndexOf(':') + 1)) !== port) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
  }
  return uniq(pids);
}

/** Socket inodes of LISTEN (state 0A) sockets on `port` from the text of /proc/net/tcp or /proc/net/tcp6. */
export function parseProcNetTcp(text: string, port: number): string[] {
  const inodes: string[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const p = parseInt(f[1].slice(f[1].lastIndexOf(':') + 1), 16);
    if (p === port && f[9] !== '0') inodes.push(f[9]);
  }
  return inodes;
}

/** Pids under `procRoot` (default /proc) that hold one of `inodes` as a socket fd. Unreadable processes are skipped. */
export function pidsOwningInodes(inodes: string[], procRoot = '/proc'): number[] {
  if (!inodes.length) return [];
  const want = new Set(inodes.map((i) => `socket:[${i}]`));
  const pids: number[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(procRoot); } catch { return []; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let fds: string[];
    try { fds = readdirSync(join(procRoot, e, 'fd')); } catch { continue; }
    for (const fd of fds) {
      try {
        if (want.has(readlinkSync(join(procRoot, e, 'fd', fd)))) { pids.push(Number(e)); break; }
      } catch { /* fd closed or not ours */ }
    }
  }
  return uniq(pids);
}

function run(argv: string[]): string | null {
  try {
    const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'ignore' });
    return r.exitCode === 0 || r.stdout.length ? r.stdout.toString() : null;
  } catch { return null; }
}

/** Pids listening on TCP `port`: lsof, else Linux `ss`, else the /proc scan. [] when unknown or nobody listens. */
export function listenerPids(port: number): number[] {
  if (Bun.which('lsof')) {
    const out = run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    if (out !== null) return parseLsofPids(out);
  }
  if (process.platform !== 'linux') return [];
  if (Bun.which('ss')) {
    const pids = parseSsPids(run(['ss', '-ltnpH']) ?? '', port);
    if (pids.length) return pids;
  }
  const inodes: string[] = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { inodes.push(...parseProcNetTcp(readFileSync(f, 'utf8'), port)); } catch { /* not Linux */ }
  }
  return pidsOwningInodes(inodes);
}

// ---------------------------------------------------------------- a process's command line

/** /proc/<pid>/cmdline (NUL-separated argv) as one space-joined line. */
export const cmdlineToCommand = (raw: string): string => raw.replace(/\0+$/, '').replace(/\0/g, ' ').trim();

/** The command line of `pid` ('' when it is gone or unreadable): /proc when present, else `ps`. */
export function processCommand(pid: number): string {
  const proc = `/proc/${pid}/cmdline`;
  if (existsSync(proc)) {
    try {
      const cmd = cmdlineToCommand(readFileSync(proc, 'utf8'));
      if (cmd) return cmd;
    } catch { /* fall back to ps */ }
  }
  return (run(['ps', '-p', String(pid), '-o', 'command=']) ?? '').trim();
}
