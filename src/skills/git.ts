import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { assertWritable, skillPaths } from './paths';
import { emptyManifest, readManifest, writeManifest } from './manifest';
import type { GitState, SkillPaths } from './types';

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

function git(paths: SkillPaths, args: string[]): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  const result = Bun.spawnSync(['git', '-C', paths.library, ...args], { stdout: 'pipe', stderr: 'pipe', env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// Network operations (pull, push) run async with a timeout and no prompts, so a slow or unreachable origin never
// blocks the server's event loop (agent hooks, the CLI and SSE share it).
export const GIT_NETWORK_TIMEOUT_MS = 60_000;
async function gitNetwork(paths: SkillPaths, args: string[], timeoutMs = Number(process.env.SPARROW_GIT_TIMEOUT_MS) || GIT_NETWORK_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes';
  const proc = Bun.spawn(['git', '-C', paths.library, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
  try {
    const code = await proc.exited;
    if (timedOut) return { code: 124, stdout: '', stderr: `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s` };
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function repoRoot(paths: SkillPaths): string | null {
  if (!existsSync(paths.library)) return null;
  const result = git(paths, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) return null;
  try { return realpathSync.native(result.stdout.trim()); } catch { return null; }
}

function hasOwnRepo(paths: SkillPaths): boolean {
  try { return repoRoot(paths) === realpathSync.native(paths.library); } catch { return false; }
}

function ensureRepo(paths: SkillPaths): void {
  if (!existsSync(paths.library)) throw new Error(`Skills library is missing: ${paths.library}`);
  if (!hasOwnRepo(paths)) throw new Error(`Skills library is not a git repository rooted at ${paths.library}`);
}

function hasUpstream(paths: SkillPaths): boolean {
  const result = git(paths, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  return result.code === 0 && Boolean(result.stdout.trim());
}

function lstatIfPresent(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function ensureRegularMetadata(path: string): boolean {
  const stat = lstatIfPresent(path);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked skills library metadata: ${path}`);
  if (!stat.isFile()) throw new Error(`Skills library metadata is not a regular file: ${path}`);
  return true;
}

export function ensureLibrary(paths: SkillPaths = skillPaths()): string {
  const library = assertWritable(paths.library, paths);
  mkdirSync(library, { recursive: true });
  const gitEntry = lstatIfPresent(join(library, '.git'));
  if (gitEntry?.isSymbolicLink()) throw new Error(`Refusing symlinked git metadata: ${join(library, '.git')}`);
  const ignore = join(library, '.gitignore');
  const manifestFile = join(library, 'skills.json');
  const hasIgnore = ensureRegularMetadata(ignore);
  const hasManifest = ensureRegularMetadata(manifestFile);
  if (!gitEntry) {
    const init = git(paths, ['init']);
    if (init.code !== 0) throw new Error(init.stderr.trim() || 'git init failed');
  }
  ensureRepo(paths);
  if (!hasIgnore) {
    assertWritable(ignore, paths);
    try { writeFileSync(ignore, '.DS_Store\n.*-tmp\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      ensureRegularMetadata(ignore);
    }
  }
  if (!hasManifest) writeManifest(emptyManifest(), library, paths);
  return library;
}

export function status(paths: SkillPaths = skillPaths()): GitState {
  if (!existsSync(paths.library)) return { available: false, branch: null, dirty: [], ahead: null, behind: null, remote: null, error: `library missing: ${paths.library}` };
  if (!hasOwnRepo(paths)) return { available: false, branch: null, dirty: [], ahead: null, behind: null, remote: null, error: `Skills library is not a git repository rooted at ${paths.library}` };
  const result = git(paths, ['status', '--porcelain=1', '--branch']);
  if (result.code !== 0) return { available: false, branch: null, dirty: [], ahead: null, behind: null, remote: null, error: result.stderr.trim() || 'library is not a git repository' };
  const lines = result.stdout.trimEnd().split('\n');
  const head = lines.shift() ?? '';
  const branch = head.match(/^## (.+?)(?:\.\.\.|$)/)?.[1] ?? null;
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0);
  const dirty = lines.filter(Boolean).map((line) => line.slice(3));
  const remoteResult = git(paths, ['remote', 'get-url', 'origin']);
  const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : null;
  let upstream: { ahead: number; behind: number } | null = null;
  const counts = git(paths, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts.code === 0) {
    const [b, a] = counts.stdout.trim().split(/\s+/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) upstream = { ahead: a!, behind: b! };
  }
  // No upstream yet (a first commit, `push -u` still to come): the commits no remote branch has are the unpushed ones.
  let unpushed: number | null = null;
  if (!upstream && remote) {
    const local = git(paths, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    if (local.code === 0 && Number.isFinite(Number(local.stdout.trim()))) unpushed = Number(local.stdout.trim());
  }
  return {
    available: true, branch, dirty,
    ahead: upstream?.ahead ?? unpushed ?? (head.includes('ahead ') ? ahead : null),
    behind: upstream?.behind ?? (head.includes('behind ') ? behind : null),
    remote,
  };
}

export function log(path?: string, paths: SkillPaths = skillPaths()): GitCommit[] {
  ensureRepo(paths);
  const args = ['log', '-n', '100', '--format=%H%x09%h%x09%an%x09%ad%x09%s', '--date=iso-strict'];
  if (path) args.push('--', path);
  const result = git(paths, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'git log failed');
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash = '', shortHash = '', author = '', date = '', ...subject] = line.split('\t');
    return { hash, shortHash, author, date, subject: subject.join('\t') };
  });
}

export async function pull(paths: SkillPaths = skillPaths()): Promise<string> {
  ensureRepo(paths);
  if (!hasUpstream(paths)) {
    throw new Error('Cannot pull skills library: the current branch has no upstream tracking branch. Push to origin first to set one, or configure an upstream branch.');
  }
  const result = await gitNetwork(paths, ['pull', '--ff-only']);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'git pull --ff-only failed');
  return (result.stdout + result.stderr).trim();
}

export function commit(message: string, paths: SkillPaths = skillPaths()): string {
  ensureRepo(paths);
  assertWritable(paths.library, paths);
  const add = git(paths, ['add', '--all']);
  if (add.code !== 0) throw new Error(add.stderr.trim() || 'git add failed');
  const result = git(paths, ['commit', '-m', message]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'git commit failed');
  return (result.stdout + result.stderr).trim();
}

export async function push(paths: SkillPaths = skillPaths()): Promise<string> {
  ensureRepo(paths);
  const remote = git(paths, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0 || !remote.stdout.trim()) throw new Error('Cannot push skills library: origin remote is not configured');
  assertWritable(paths.library, paths);
  const result = await gitNetwork(paths, hasUpstream(paths) ? ['push', 'origin', 'HEAD'] : ['push', '-u', 'origin', 'HEAD']);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'git push origin HEAD failed');
  return (result.stdout + result.stderr).trim();
}
