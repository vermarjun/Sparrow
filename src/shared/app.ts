// Compiled mode: the binary carries assets/ and web/dist; the server, hooks and harnesses need real files, so they are
// materialised ONCE per version into <SPARROW_HOME>/app/<version>/{assets,web}. Atomic (temp dir + rename), idempotent,
// safe for concurrent starts. Source mode: nothing to do.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { APP_DIR, APP_VERSION, COMPILED, EMBEDDED, SERVER_URL } from './config';

export const MARKER = '.complete';
const readMarker = (dest: string): string | null => { try { return readFileSync(join(dest, MARKER), 'utf8'); } catch { return null; } };
const rand = () => Math.random().toString(36).slice(2, 8);

/** Copy `files` (relative path -> readable source file) into `dest`. Returns true when it wrote, false when `dest` was already this build. */
export async function materialize(files: Record<string, string>, dest: string, build: string): Promise<boolean> {
  if (readMarker(dest) === build) return false;
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${rand()}`;
  try {
    for (const [rel, src] of Object.entries(files)) {
      const to = join(tmp, rel);
      mkdirSync(dirname(to), { recursive: true });
      await Bun.write(to, Bun.file(src));
    }
    writeFileSync(join(tmp, MARKER), build);
    // The same version rebuilt (dev builds): the old tree goes aside first. Re-check, a concurrent start may just have done it.
    if (existsSync(dest) && readMarker(dest) !== build) renameSync(dest, `${dest}.old-${process.pid}-${rand()}`);
    try { renameSync(tmp, dest); } catch (e) {
      if (readMarker(dest) === build) return false;   // lost the race to an identical start
      throw e;
    }
    for (const n of readdirSync(dirname(dest))) if (n.startsWith(basename(dest) + '.old-')) rmSync(join(dirname(dest), n), { recursive: true, force: true });
    return true;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** `<dest>/bin/sparrow` -> the binary, for a binary that is not itself named `sparrow` (agents need `sparrow` on PATH). */
export function ensureShim(dest: string, target: string): void {
  const dir = join(dest, 'bin');
  const link = join(dir, 'sparrow');
  try { if (readlinkSync(link) === target) return; } catch {}
  mkdirSync(dir, { recursive: true });
  const tmp = `${link}.tmp-${process.pid}-${rand()}`;
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

/**
 * Delete materialised version dirs under `root` that nothing needs: keep `current`, the newest other one (a rollback, or a
 * server that has not restarted yet) and any version in `inUse`. Only dirs carrying our marker are touched. Returns what it removed.
 */
export function pruneOldVersions(root: string, current: string, inUse: string[] = []): string[] {
  let versions: { name: string; at: number }[] = [];
  try {
    versions = readdirSync(root).filter((n) => existsSync(join(root, n, MARKER)) && !n.includes('.tmp-') && !n.includes('.old-'))
      .map((name) => ({ name, at: statSync(join(root, name, MARKER)).mtimeMs }));
  } catch { return []; }
  const newestOther = versions.filter((v) => v.name !== current).sort((a, b) => b.at - a.at)[0]?.name;
  const keep = new Set([current, newestOther, ...inUse]);
  const gone: string[] = [];
  for (const v of versions) if (!keep.has(v.name)) { rmSync(join(root, v.name), { recursive: true, force: true }); gone.push(v.name); }
  return gone;
}

/** The version of the server answering at SERVER_URL (it serves its UI from its own app dir), or null. */
async function runningServerVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(700) });
    const j = (await r.json()) as { ok?: boolean; version?: string };
    return j.ok && typeof j.version === 'string' ? j.version : null;
  } catch { return null; }
}

/** Compiled mode: make sure APP_DIR holds this build's assets + web. No-op in source mode. */
export async function ensureApp(): Promise<boolean> {
  if (!COMPILED || !EMBEDDED) return false;
  const wrote = await materialize(EMBEDDED.files, APP_DIR, EMBEDDED.build);
  ensureShim(APP_DIR, process.execPath);
  if (wrote) {
    const running = await runningServerVersion();
    try { pruneOldVersions(dirname(APP_DIR), APP_VERSION, running ? [running] : []); } catch { /* best effort */ }
  }
  return wrote;
}
