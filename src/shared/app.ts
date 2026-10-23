// Compiled mode: the binary carries assets/ and web/dist; the server, hooks and harnesses need real files, so they are
// materialised ONCE per version into <SPARROW_HOME>/app/<version>/{assets,web}. Atomic (temp dir + rename), idempotent,
// safe for concurrent starts. Source mode: nothing to do.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { APP_DIR, COMPILED, EMBEDDED } from './config';

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

/** Compiled mode: make sure APP_DIR holds this build's assets + web. No-op in source mode. */
export async function ensureApp(): Promise<boolean> {
  if (!COMPILED || !EMBEDDED) return false;
  const wrote = await materialize(EMBEDDED.files, APP_DIR, EMBEDDED.build);
  ensureShim(APP_DIR, process.execPath);
  return wrote;
}
