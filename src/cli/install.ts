// `sparrow install [--force]` — idempotent setup of everything outside the repo.
//   1. SPARROW_HOME + resumes seeded from assets/resumes (user edits always kept)
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
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { RealHarness } from '../harness/catalog';
import { resolveHarnessBin } from '../harness/discover';
import { writeAtomic } from '../harness/launch';
import { applyResumeFallback } from '../server/resume-fallback';
import { AGENTS_DIR, APP_VERSION, ASSETS, BIN, COMPILED, REPO_ROOT, RESUMES_DIR, SPARROW_HOME, WEB_DIST } from '../shared/config';
import { tmuxInstallHint } from '../shared/hints';
import { assertWritable, skillPaths } from '../skills/paths';

/** The web package dir. SPARROW_WEB_DIR overrides it (tests only). */
export function webDir(): string {
  return process.env.SPARROW_WEB_DIR || join(REPO_ROOT, 'web');
}

/** Where the built UI lives: SPARROW_WEB_DIR/dist (tests), else web/dist in a checkout or the materialised app's web/. */
export function webDist(): string {
  return process.env.SPARROW_WEB_DIR ? join(process.env.SPARROW_WEB_DIR, 'dist') : WEB_DIST;
}

export function webBuilt(dir?: string): boolean {
  return existsSync(dir ? join(dir, 'dist', 'index.html') : join(webDist(), 'index.html'));
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
  if (COMPILED && !process.env.SPARROW_WEB_DIR) return { ok: webBuilt(), line: webBuilt() ? `web UI: embedded (v${APP_VERSION})` : `web UI: embedded files missing in ${webDist()}` };
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

export async function runInstall(opts: { force?: boolean; installed?: Record<RealHarness, boolean> } = {}): Promise<InstallResult> {
  const home = homedir();
  const ok: string[] = [];
  const warnings: string[] = [];
  const t = (p: string) => tilde(p, home);

  // 1. home + resumes
  for (const d of [SPARROW_HOME, RESUMES_DIR, AGENTS_DIR]) mkdirSync(d, { recursive: true });
  const seed = seedResumes(join(ASSETS, 'resumes'), RESUMES_DIR, opts.installed ?? installedHarnesses());
  ok.push(`home ${t(SPARROW_HOME)}`);
  ok.push(`resumes in ${t(RESUMES_DIR)}: ${[
    seed.seeded.length && `seeded ${seed.seeded.join(', ')}`,
    seed.updated.length && `updated ${seed.updated.join(', ')} (you never edited them)`,
    seed.same && `${seed.same} up to date`,
  ].filter(Boolean).join('; ') || 'none found in assets/resumes'}`);
  for (const n of seed.notes) ok.push(`resumes: ${n}`);
  if (seed.kept.length) warnings.push(`kept your edited resumes: ${seed.kept.join(', ')} (never overwritten by install)`);

  // 2. ~/.local/bin/sparrow symlink → BIN
  try { chmodSync(BIN, 0o755); } catch {}
  const binDir = join(home, '.local', 'bin');
  const link = join(binDir, 'sparrow');
  const onPathAt = Bun.which('sparrow');
  // Compiled: a sparrow already on PATH (npm / brew / install.sh / a dir of the user's) needs no link of ours.
  const pathHasOther = COMPILED && !opts.force && !!onPathAt && onPathAt !== link;
  if (pathHasOther) ok.push(`sparrow on PATH: ${t(onPathAt!)}${sameFile(onPathAt!, BIN) ? '' : ' (a different sparrow; not linking over it)'}`);
  else {
    mkdirSync(binDir, { recursive: true });
    let linkState: 'ok' | 'made' | 'replaced' | 'blocked' = 'made';
    if (existsSync(link) || isSymlink(link)) {
      if (isSymlink(link) && readlinkSync(link) === BIN) linkState = 'ok';
      // Without --force, only replace a symlink into another sparrow checkout (…/bin/sparrow) or an older binary, never a user's own link/file.
      else if (opts.force || (isSymlink(link) && /(^|\/)(bin\/sparrow|sparrow[\w.-]*)$/.test(readlinkSync(link)))) { unlinkSync(link); linkState = 'replaced'; }
      else linkState = 'blocked';
    }
    if (linkState === 'made' || linkState === 'replaced') symlinkSync(BIN, link);
    if (linkState === 'blocked') warnings.push(`${t(link)} exists and is not our symlink; left alone (sparrow install --force replaces it)`);
    else ok.push(`${linkState === 'ok' ? 'link up to date' : linkState === 'replaced' ? 'relinked' : 'linked'} ${t(link)} → ${BIN}`);
    const onPath = (process.env.PATH ?? '').split(delimiter).some((p) => p.replace(/\/$/, '') === binDir);
    if (!onPath) warnings.push(`${t(binDir)} is not on your PATH — add: export PATH="$HOME/.local/bin:$PATH"`);
  }

  // 3. skills
  const skillLocation = skillPaths();
  const targets: { dir: string; who: string }[] = [
    { dir: skillLocation.roots.claude, who: 'Claude Code + OpenCode' },
    { dir: skillLocation.roots.codex, who: 'Codex' },
  ];
  for (const { dir, who } of targets) {
    const writableDir = assertWritable(dir, skillLocation);
    mkdirSync(writableDir, { recursive: true });
    const done: string[] = [];
    let fresh = 0;
    for (const skill of SKILLS) {
      const from = join(ASSETS, 'skills', skill);
      if (!existsSync(from)) { warnings.push(`missing assets/skills/${skill}`); continue; }
      const to = assertWritable(join(dir, skill), skillLocation);
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

  // 5. binaries (bun only matters in a source checkout: the compiled binary needs no runtime)
  const harnessBin = resolveHarnessBin;
  const bins: [string, string | null, string[]][] = [
    ['claude', harnessBin('claude'), ['--version']],
    ['codex', harnessBin('codex'), ['--version']],
    ['opencode', harnessBin('opencode'), ['--version']],
    ['tmux', Bun.which('tmux'), ['-V']],
    ...(COMPILED ? [] : [['bun', process.execPath, ['--version']] as [string, string | null, string[]]]),
  ];
  const vers = await Promise.all(bins.map(async ([name, path, args]) => [name, path, path ? await version([path, ...args]) : null] as const));
  const found: string[] = [];
  for (const [name, path, v] of vers) {
    if (!path) warnings.push(`${name} not found on PATH${name === 'tmux' ? ` (required: ${tmuxInstallHint()})` : name === 'bun' ? ' (required)' : ` (agents with harness ${name} cannot start)`}`);
    else if (!v) warnings.push(`${name} at ${path} did not report a version`);
    else found.push(`${name} ${v.replace(/^(tmux|codex-cli)\s+/, '').replace(/\s*\(Claude Code\)/, '')}`);
  }
  if (found.length) ok.push(`binaries: ${found.join(' · ')}`);

  if (COMPILED) recordInstall();
  const text = [
    'Sparrow install',
    ...ok.map((l) => `  ✓ ${l}`),
    ...warnings.map((l) => `  ! ${l}`),
    '',
    'Next: sparrow   (opens the UI; click Run doctor, then Start captain)',
  ].join('\n');
  return { ok, warnings, text };
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const sameFile = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };

// ---------------------------------------------------------------- resume seeding

/** What we seeded, per slug: kept NEXT to the resumes dir (not in it), so nothing that lists the dir ever sees it. */
export const seededFile = (resumesDir: string) => join(dirname(resumesDir), 'seeded-resumes.json');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Which harnesses have a binary on this machine (resolved the way the drivers resolve them). */
export function installedHarnesses(): Record<RealHarness, boolean> {
  const has = (h: RealHarness) => resolveHarnessBin(h) !== null;
  return { claude: has('claude'), codex: has('codex'), opencode: has('opencode') };
}

export interface SeedResult { seeded: string[]; updated: string[]; kept: string[]; same: number; notes: string[] }
/** Per slug: sha of what we wrote, sha of the shipped text it came from, and whether it was rewritten onto a fallback harness. */
export interface SeedRec { sha: string; src: string; fallback?: boolean }

export function readSeedRecord(resumesDir: string): Record<string, SeedRec> {
  try {
    const r = JSON.parse(readFileSync(seededFile(resumesDir), 'utf8')).resumes ?? {};
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? { sha: v, src: '' } : v as SeedRec]));
  } catch { return {}; }
}

/**
 * Copy the shipped resumes (rewritten onto an installed harness when theirs is missing) into `dst`. Never overwrites an edit:
 * `<dst>/../seeded-resumes.json` records what WE wrote per slug, so a file still matching it was never edited and is updated
 * when a newer shipped version arrives; any other difference is the user's, and is kept. A fallback-seeded resume stays on its
 * fallback harness even after the missing one is installed (it is only rewritten when the shipped text itself changes; to reseed,
 * delete the file and run `sparrow install`). Tombstoned slugs are never recreated.
 */
export function seedResumes(src: string, dst: string, installed: Record<RealHarness, boolean>): SeedResult {
  const r: SeedResult = { seeded: [], updated: [], kept: [], same: 0, notes: [] };
  const rec = readSeedRecord(dst);
  const before = JSON.stringify(rec);
  for (const f of existsSync(src) ? readdirSync(src).filter((f) => f.endsWith('.md')).sort() : []) {
    const slug = f.slice(0, -3);
    if (existsSync(join(dst, '.deleted', slug))) continue;
    const asset = readFileSync(join(src, f), 'utf8');
    const fb = applyResumeFallback(asset, installed);
    const body = Buffer.from(fb.text);
    const mine: SeedRec = { sha: sha(body), src: sha(asset), ...(fb.text !== asset ? { fallback: true } : {}) };
    const to = join(dst, f);
    const cur = existsSync(to) ? readFileSync(to) : null;
    const prev = rec[slug];
    if (!cur) { writeFileSync(to, body); rec[slug] = mine; r.seeded.push(slug); if (fb.note) r.notes.push(fb.note); }
    else if (sha(cur) === mine.sha) { rec[slug] = mine; r.same++; }
    else if (prev && prev.sha === sha(cur)) {
      if (prev.src && prev.src !== mine.src) { writeFileSync(to, body); rec[slug] = mine; r.updated.push(slug); if (fb.note) r.notes.push(fb.note); }
      else r.same++;   // unedited and the shipped text is unchanged: stays as seeded (possibly on a fallback harness)
    }
    else r.kept.push(slug);
  }
  if (JSON.stringify(rec) !== before) writeFileSync(seededFile(dst), JSON.stringify({ version: APP_VERSION, resumes: rec }, null, 2) + '\n');
  return r;
}

// ---------------------------------------------------------------- install record (compiled mode)

export const INSTALLED_FILE = join(SPARROW_HOME, 'installed.json');
export interface InstallRecord { version: string; bin: string; at: number }

export function readInstallRecord(file = INSTALLED_FILE): InstallRecord | null {
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return typeof j?.version === 'string' ? j : null; } catch { return null; }
}
export function recordInstall(file = INSTALLED_FILE) {
  writeAtomic(file, JSON.stringify({ version: APP_VERSION, bin: BIN, at: Date.now() } satisfies InstallRecord, null, 2) + '\n');
}
/** First run, or the app version / binary path changed since the last install (an upgrade re-embeds the path in hooks). */
export function needsSetup(rec: InstallRecord | null, version = APP_VERSION, bin = BIN): boolean {
  return !rec || rec.version !== version || rec.bin !== bin;
}
