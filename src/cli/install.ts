// `sparrow install [--force]` — idempotent setup of everything outside the repo.
//   1. SPARROW_HOME + resumes seeded from assets/resumes (user edits kept unless --force)
//   2. ~/.local/bin/sparrow → <repo>/bin/sparrow
//   3. skills sparrow-captain + sparrow-worker copied into the harnesses' user skill dirs
//   4. harness assets (T2's installHarnessAssets: OpenCode plugin, …)
//   5. binary check with versions
//
// Skill dirs (verified 2026-10-13 against the installed CLIs):
//   - Claude Code 2.1.296 reads ~/.claude/skills.
//   - OpenCode 1.18.33 reads ~/.config/opencode/skills AND ~/.claude/skills AND ~/.agents/skills
//     (`opencode debug skill` lists all three) → covered by the ~/.claude/skills copy.
//   - Codex 0.162.1 reads $CODEX_HOME/skills (~/.codex/skills) AND ~/.agents/skills, NOT ~/.claude/skills
//     (`codex debug prompt-input` lists both) → we copy into ~/.codex/skills.
//   Installing into ~/.claude/skills + ~/.codex/skills gives every harness exactly one copy (no duplicates).
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AGENTS_DIR, ASSETS, BIN, REPO_ROOT, RESUMES_DIR, SPARROW_HOME } from '../shared/config';

/** The web package dir. SPARROW_WEB_DIR overrides it (tests only). */
export function webDir(): string {
  return process.env.SPARROW_WEB_DIR || join(REPO_ROOT, 'web');
}

export function webBuilt(dir = webDir()): boolean {
  return existsSync(join(dir, 'dist', 'index.html'));
}

async function sh(cmd: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code: await p.exited, out: (out + '\n' + err).trim() };
}

/**
 * Build the web UI (`bun install` + `bun run build` in web/) when web/dist/index.html is missing, or always with force.
 * SPARROW_SKIP_WEB_BUILD=1 skips the actual build (tests) but still reports what would have happened.
 */
export async function ensureWebBuilt(opts: { force?: boolean } = {}): Promise<{ ok: boolean; line: string }> {
  const dir = webDir();
  if (!existsSync(join(dir, 'package.json'))) return { ok: false, line: `web UI: no package.json in ${dir}; UI not available` };
  const built = webBuilt(dir);
  if (built && !opts.force) return { ok: true, line: 'web UI: already built (web/dist)' };
  const why = built ? 'rebuild (--force)' : 'web/dist missing';
  if (process.env.SPARROW_SKIP_WEB_BUILD === '1') return { ok: true, line: `web UI: build needed (${why}) — skipped (SPARROW_SKIP_WEB_BUILD=1)` };
  const t0 = Date.now();
  for (const cmd of [[process.execPath, 'install'], [process.execPath, 'run', 'build']]) {
    const r = await sh(cmd, dir, 300_000);
    if (r.code !== 0) {
      const tail = r.out.split('\n').slice(-5).join(' | ');
      return { ok: false, line: `web UI: \`bun ${cmd.slice(1).join(' ')}\` failed in ${dir} (exit ${r.code}): ${tail}` };
    }
  }
  return {
    ok: webBuilt(dir),
    line: webBuilt(dir) ? `web UI: built web/dist (${why}; ${Math.round((Date.now() - t0) / 1000)}s)` : `web UI: build ran but ${join(dir, 'dist', 'index.html')} is missing`,
  };
}

export const SKILLS = ['sparrow-captain', 'sparrow-worker'];

export interface InstallResult {
  ok: string[];
  warnings: string[];
  text: string;
}

const tilde = (p: string, home: string) => (p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

function sameTree(a: string, b: string): boolean {
  if (!existsSync(b)) return false;
  for (const name of readdirSync(a, { withFileTypes: true })) {
    const pa = join(a, name.name);
    const pb = join(b, name.name);
    if (name.isDirectory()) { if (!sameTree(pa, pb)) return false; }
    else if (!existsSync(pb) || !readFileSync(pa).equals(readFileSync(pb))) return false;
  }
  return true;
}

async function version(cmd: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => p.kill(), 15_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(timer);
    if ((await p.exited) !== 0) return null;
    return (out.trim() || err.trim()).split('\n')[0];
  } catch {
    return null;
  }
}

export async function runInstall(opts: { force?: boolean } = {}): Promise<InstallResult> {
  const home = homedir();
  const ok: string[] = [];
  const warnings: string[] = [];
  const t = (p: string) => tilde(p, home);

  // 1. home + resumes
  for (const d of [SPARROW_HOME, RESUMES_DIR, AGENTS_DIR]) mkdirSync(d, { recursive: true });
  const src = join(ASSETS, 'resumes');
  const seeded: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  let same = 0;
  for (const f of existsSync(src) ? readdirSync(src).filter((f) => f.endsWith('.md')).sort() : []) {
    const from = join(src, f);
    const to = join(RESUMES_DIR, f);
    const body = readFileSync(from);
    if (!existsSync(to)) { writeFileSync(to, body); seeded.push(f.slice(0, -3)); }
    else if (readFileSync(to).equals(body)) same++;
    else if (opts.force) { writeFileSync(to, body); updated.push(f.slice(0, -3)); }
    else kept.push(f.slice(0, -3));
  }
  ok.push(`home ${t(SPARROW_HOME)}`);
  ok.push(`resumes in ${t(RESUMES_DIR)}: ${[
    seeded.length && `seeded ${seeded.join(', ')}`,
    updated.length && `overwritten ${updated.join(', ')}`,
    same && `${same} up to date`,
  ].filter(Boolean).join('; ') || 'none found in assets/resumes'}`);
  if (kept.length) warnings.push(`kept your edited resumes: ${kept.join(', ')} (sparrow install --force overwrites them)`);

  // 2. ~/.local/bin/sparrow symlink
  try { chmodSync(BIN, 0o755); } catch {}
  const binDir = join(home, '.local', 'bin');
  const link = join(binDir, 'sparrow');
  mkdirSync(binDir, { recursive: true });
  let linkState: 'ok' | 'made' | 'replaced' | 'blocked' = 'made';
  if (existsSync(link) || isSymlink(link)) {
    if (isSymlink(link) && readlinkSync(link) === BIN) linkState = 'ok';
    // Without --force, only replace a symlink into another sparrow checkout (…/bin/sparrow), never a user's own link/file.
    else if (opts.force || (isSymlink(link) && readlinkSync(link).endsWith('/bin/sparrow'))) { unlinkSync(link); linkState = 'replaced'; }
    else linkState = 'blocked';
  }
  if (linkState === 'made' || linkState === 'replaced') symlinkSync(BIN, link);
  if (linkState === 'blocked') warnings.push(`${t(link)} exists and is not our symlink; left alone (sparrow install --force replaces it)`);
  else ok.push(`${linkState === 'ok' ? 'link up to date' : linkState === 'replaced' ? 'relinked' : 'linked'} ${t(link)} → ${BIN}`);
  const onPath = (process.env.PATH ?? '').split(delimiter).some((p) => p.replace(/\/$/, '') === binDir);
  if (!onPath) warnings.push(`${t(binDir)} is not on your PATH — add: export PATH="$HOME/.local/bin:$PATH"`);

  // 3. skills
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  const targets: { dir: string; who: string }[] = [
    { dir: join(home, '.claude', 'skills'), who: 'Claude Code + OpenCode' },
    { dir: join(codexHome, 'skills'), who: 'Codex' },
  ];
  for (const { dir, who } of targets) {
    const done: string[] = [];
    let fresh = 0;
    for (const skill of SKILLS) {
      const from = join(ASSETS, 'skills', skill);
      if (!existsSync(from)) { warnings.push(`missing assets/skills/${skill}`); continue; }
      const to = join(dir, skill);
      if (sameTree(from, to)) fresh++;
      else { mkdirSync(to, { recursive: true }); cpSync(from, to, { recursive: true, force: true }); }
      done.push(skill);
    }
    if (done.length) ok.push(`skills ${done.join(', ')} → ${t(dir)} (${who})${fresh === done.length ? ' — up to date' : ''}`);
  }

  // 4b. web UI (web/dist is git-ignored: a fresh checkout has to build it)
  const web = await ensureWebBuilt({ force: opts.force });
  (web.ok ? ok : warnings).push(web.line);

  // 4. harness assets (T2)
  try {
    const mod: any = await import('../harness/install');
    const lines: string[] = await mod.installHarnessAssets();
    for (const l of lines) (/NOT FOUND|failed|error/i.test(l) ? warnings : ok).push(`harness: ${l}`);
  } catch (e) {
    warnings.push(`harness assets skipped (src/harness/install.ts: ${(e as Error).message.split('\n')[0]})`);
  }

  // 5. binaries
  const codexBin = existsSync('/opt/homebrew/bin/codex') ? '/opt/homebrew/bin/codex' : Bun.which('codex');
  const opencodeBin = Bun.which('opencode') ?? (existsSync(join(home, '.opencode/bin/opencode')) ? join(home, '.opencode/bin/opencode') : null);
  const bins: [string, string | null, string[]][] = [
    ['claude', Bun.which('claude'), ['--version']],
    ['codex', codexBin, ['--version']],
    ['opencode', opencodeBin, ['--version']],
    ['tmux', Bun.which('tmux'), ['-V']],
    ['bun', process.execPath, ['--version']],
  ];
  const vers = await Promise.all(bins.map(async ([name, path, args]) => [name, path, path ? await version([path, ...args]) : null] as const));
  const found: string[] = [];
  for (const [name, path, v] of vers) {
    if (!path) warnings.push(`${name} not found on PATH${name === 'tmux' || name === 'bun' ? ' (required)' : ` (agents with harness ${name} cannot start)`}`);
    else if (!v) warnings.push(`${name} at ${path} did not report a version`);
    else found.push(`${name} ${v.replace(/^(tmux|codex-cli)\s+/, '').replace(/\s*\(Claude Code\)/, '')}`);
  }
  if (found.length) ok.push(`binaries: ${found.join(' · ')}`);

  const text = [
    'Sparrow install',
    ...ok.map((l) => `  ✓ ${l}`),
    ...warnings.map((l) => `  ! ${l}`),
    '',
    'Next: sparrow up --tmux   (then, in your Claude Code session: sparrow resumes, sparrow hire …)',
  ].join('\n');
  return { ok, warnings, text };
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
