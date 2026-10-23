// First run + upgrade (plain `sparrow` in compiled mode), the short readiness check, and `sparrow uninstall`.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RealHarness } from '../harness/catalog';
import { CLAUDE_JSON, CODEX_HOME } from '../harness/env';
import { APP_VERSION, BIN, COMPILED, RESUMES_DIR, SPARROW_HOME } from '../shared/config';
import { tmuxInstallHint } from '../shared/hints';
import { skillPaths } from '../skills/paths';
import { installedHarnesses, needsSetup, readInstallRecord, readSeedRecord, runInstall, SKILLS } from './install';

/** Compiled mode sets itself up on the first plain `sparrow`, and again when the app version or the binary's path changed. */
export function firstRunNeeded(): boolean {
  if (process.env.SPARROW_NO_SETUP === '1') return false;
  return (COMPILED || process.env.SPARROW_FORCE_SETUP === '1') && needsSetup(readInstallRecord());
}

export async function firstRun(say: (l: string) => void): Promise<void> {
  const rec = readInstallRecord();
  say(rec ? `Sparrow ${APP_VERSION}: upgraded from ${rec.version}; refreshing the install…` : `Sparrow ${APP_VERSION}: first run, setting up ${SPARROW_HOME}…`);
  const res = await runInstall();
  // The short form: what matters for a first run. Missing binaries are the readiness check's job; `sparrow install` has the full list.
  const keep = (l: string) => /^(resumes|sparrow on PATH|link|relinked|linked)/.test(l);
  for (const l of res.ok.filter(keep)) say(`  ✓ ${l}`);
  for (const w of res.warnings.filter((w) => !/not found|NOT FOUND/.test(w))) say(`  ! ${w}`);
  say('  ✓ skills, plugins and the web UI installed (details: sparrow install)');
}

// ---------------------------------------------------------------- readiness (static, local, cheap)

const HARNESS_HINT: Record<RealHarness, string> = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm i -g @openai/codex   (or: brew install codex)',
  opencode: 'curl -fsSL https://opencode.ai/install | bash',
};
const LOGIN_HINT: Record<RealHarness, string> = { claude: 'claude auth login', codex: 'codex login', opencode: 'opencode auth login' };

function hasJson(file: string, ok: (j: any) => boolean = () => true): boolean {
  try { return ok(JSON.parse(readFileSync(file, 'utf8'))); } catch { return false; }
}

/** Are credentials for this harness on disk (or in env)? A static hint, not a login test: the doctor does the live one. */
export function loginFound(h: RealHarness, env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (h === 'claude') {
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN) return true;
    if (hasJson(CLAUDE_JSON(), (j) => !!j?.oauthAccount)) return true;
    if (existsSync(join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), '.credentials.json'))) return true;
    if (process.platform === 'darwin') {
      const r = Bun.spawnSync(['security', 'find-generic-password', '-s', 'Claude Code-credentials'], { stdout: 'ignore', stderr: 'ignore' });
      return r.exitCode === 0;
    }
    return false;
  }
  if (h === 'codex') return !!env.OPENAI_API_KEY || existsSync(join(env.CODEX_HOME ?? CODEX_HOME(), 'auth.json'));
  const data = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return hasJson(join(data, 'opencode', 'auth.json'), (j) => j && typeof j === 'object' && Object.keys(j).length > 0);
}

/** slug -> harness of the resumes in `dir` (front matter `harness:`, default claude). */
export function resumeHarnesses(dir = RESUMES_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      const head = readFileSync(join(dir, f), 'utf8').split(/^---\s*$/m)[1] ?? '';
      out[f.slice(0, -3)] = head.match(/^harness:\s*(\S+)/m)?.[1] ?? 'claude';
    }
  } catch {}
  return out;
}

export function readiness(): string[] {
  const lines: string[] = [];
  const tmux = Bun.which('tmux');
  lines.push(tmux ? `✓ tmux ${tmux}` : `✗ tmux not found: ${tmuxInstallHint()}`);
  const have = installedHarnesses();
  for (const h of ['claude', 'codex', 'opencode'] as RealHarness[]) {
    if (!have[h]) { lines.push(`– ${h} not installed (${HARNESS_HINT[h]})`); continue; }
    lines.push(loginFound(h) ? `✓ ${h} installed, login found` : `! ${h} installed, no login found (${LOGIN_HINT[h]})`);
  }
  const rh = resumeHarnesses();
  const ready = Object.keys(rh).filter((s) => rh[s] === 'fake' || (have[rh[s] as RealHarness] && loginFound(rh[s] as RealHarness)));
  const blocked = Object.keys(rh).filter((s) => !ready.includes(s));
  lines.push(ready.length ? `Hireable now: ${ready.join(', ')}` : 'Hireable now: none (install and log in to at least one harness)');
  if (blocked.length) lines.push(`Needs another harness/login: ${blocked.map((s) => `${s} (${rh[s]})`).join(', ')}`);
  const fb = Object.entries(readSeedRecord(RESUMES_DIR)).filter(([, v]) => v.fallback).map(([k]) => k);
  if (fb.length) lines.push(`Seeded on a fallback harness: ${fb.join(', ')}. They stay there if you install the missing harness later; to reseed one, delete ${RESUMES_DIR}/<name>.md and run \`sparrow install\`.`);
  lines.push('Next: open the UI, Run doctor (live check), then Start captain.');
  return lines;
}

// ---------------------------------------------------------------- uninstall

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Remove what `sparrow install` wrote. $SPARROW_HOME data (db, resumes, agents) stays unless `purge`. Returns what it did. */
export function runUninstall(opts: { purge?: boolean } = {}): string[] {
  const out: string[] = [];
  const t = (p: string) => (p.startsWith(homedir() + '/') ? '~' + p.slice(homedir().length) : p);
  const rm = (p: string, what: string) => { if (existsSync(p) || isLink(p)) { rmSync(p, { recursive: true, force: true }); out.push(`removed ${what} ${t(p)}`); } };
  const link = join(homedir(), '.local', 'bin', 'sparrow');
  if (isLink(link)) {
    const target = readlinkSync(link);
    if (target === BIN || /(^|\/)(bin\/sparrow|sparrow[\w.-]*)$/.test(target)) rm(link, 'link');
    else out.push(`kept ${t(link)} (points at ${target}, not at a sparrow)`);
  }
  const roots = skillPaths().roots;
  for (const root of [roots.claude, roots.codex]) for (const s of SKILLS) rm(join(root, s), 'skill');
  rm(join(SPARROW_HOME, 'claude-plugin'), 'plugin');
  rm(join(SPARROW_HOME, 'opencode', 'plugins', 'sparrow.js'), 'plugin');
  rm(join(SPARROW_HOME, 'app'), 'app dir');
  rm(join(SPARROW_HOME, 'installed.json'), 'install record');
  if (opts.purge) rm(SPARROW_HOME, 'ALL Sparrow data');
  else if (existsSync(SPARROW_HOME) && statSync(SPARROW_HOME).isDirectory()) out.push(`kept your data in ${t(SPARROW_HOME)} (sparrow uninstall --purge removes it)`);
  return out;
}
