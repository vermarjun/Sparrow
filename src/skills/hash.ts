import { readdirSync, readFileSync, lstatSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

interface HashedFile { relativePath: string; absolutePath: string; stat: BigIntStats }

/** The files Vercel's computeSkillFolderHash covers, in its localeCompare path order. */
function listFiles(dir: string): HashedFile[] {
  const files: HashedFile[] = [];
  const visit = (base: string, current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(current, entry.name);
      const rel = relative(base, absolutePath).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') visit(base, absolutePath);
      } else if (entry.isFile()) {
        // lstat keeps a race-created symlink from being followed during the subsequent read.
        const stat = lstatSync(absolutePath, { bigint: true });
        if (stat.isFile()) files.push({ relativePath: rel, absolutePath, stat });
      }
    }
  };
  visit(dir, dir);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

function digest(files: HashedFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(readFileSync(file.absolutePath));
  }
  return hash.digest('hex');
}

/** Vercel computeSkillFolderHash: localeCompare path order, then path bytes followed by file bytes. */
export function folderHash(dir: string): string {
  return digest(listFiles(dir));
}

// ---------------------------------------------------------------- cached variant (read-only listings)

const MAX_CACHED = 2_000;
const cache = new Map<string, { signature: string; hash: string }>();
export const hashCacheStats = { hits: 0, misses: 0 };

/** Every input a rewrite changes: path, size, inode and ctime (which also moves on rename and cannot be set back by `touch -r`). */
function signature(files: HashedFile[]): string {
  return files.map((f) => `${f.relativePath}\0${f.stat.size}\0${f.stat.ino}\0${f.stat.mtimeNs}\0${f.stat.ctimeNs}`).join('\n');
}

/**
 * folderHash for the skill listings (GET /api/skills hashes every skill of every root on every request). It still walks
 * and lstats the tree, so added, removed, renamed and rewritten files are always seen, but it reads the bytes only when
 * the (path, size, inode, mtime, ctime; nanoseconds, Bun's ms fields are rounded) signature of the folder changed. Writers that verify copies keep using folderHash.
 */
export function cachedFolderHash(dir: string): string {
  const files = listFiles(dir);
  const sig = signature(files);
  const hit = cache.get(dir);
  if (hit && hit.signature === sig) { hashCacheStats.hits++; return hit.hash; }
  hashCacheStats.misses++;
  const hash = digest(files);
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(dir, { signature: sig, hash });
  return hash;
}
