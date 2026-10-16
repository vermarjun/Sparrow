// Live model catalogs, fetched from each harness itself with Sparrow's spawn environment (U1-CONTRACT).
//   claude:   no list command — seed aliases (+ ~/.claude.json additionalModelOptionsCache), resolve each through the
//             stream-json init event (killed before any API request); efforts from the --effort line of --help.
//   codex:    `codex debug models` (JSON).
//   opencode: `opencode models --verbose` with OPENCODE_CONFIG_DIR = <SPARROW_HOME>/opencode (the user's global config may be broken).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Settings } from '../shared/config';
import type { CatalogModel, HarnessCatalog, HarnessName } from '../shared/types';
import { CLAUDE_BIN, CLAUDE_JSON, CODEX_BIN, OPENCODE_BIN, binDir, bunPath, sparrowHome } from './env';
import { KEEP_RE, UNSET_PREFIX_RE, UNSET_VARS } from './launch';
import { ensurePlugin, opencodeConfigDir } from './drivers/opencode';

export type RealHarness = 'claude' | 'codex' | 'opencode';
export const REAL_HARNESSES: RealHarness[] = ['claude', 'codex', 'opencode'];
export const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

// ---------------------------------------------------------------- spawn environment

/** The environment a harness gets inside an agent window (mirrors buildScript in launch.ts), minus the agent identity. */
export function spawnEnv(h: HarnessName, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const pre = new RegExp(UNSET_PREFIX_RE);
  const keep = new RegExp(KEEP_RE);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || UNSET_VARS.includes(k) || k.startsWith('SPARROW_AGENT') || k === 'SPARROW_CALL_ID') continue;
    if (pre.test(k) && !keep.test(k)) continue;
    env[k] = v;
  }
  env.PATH = [binDir(), dirname(bunPath()), env.PATH ?? ''].filter(Boolean).join(':');
  env.SPARROW_HOME = sparrowHome();
  if (h === 'opencode') env.OPENCODE_CONFIG_DIR = opencodeConfigDir();
  return env;
}

/** A neutral cwd for probes: OpenCode fails inside some git worktrees ("no such column: project_id"). */
export function neutralCwd(): string {
  const d = sparrowHome();
  mkdirSync(d, { recursive: true });
  return d;
}

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }

export async function run(argv: string[], opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { env: opts.env, cwd: opts.cwd ?? neutralCwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message, timedOut: false };
  }
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { proc.kill(9); } catch {} }, opts.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(t);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
}

export function binaryFor(h: RealHarness): string {
  return h === 'claude' ? CLAUDE_BIN() : h === 'codex' ? CODEX_BIN() : OPENCODE_BIN();
}

export function binaryExists(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

/** First version-looking token of `<bin> --version`, or null. */
export async function harnessVersion(h: RealHarness): Promise<string | null> {
  const bin = binaryFor(h);
  if (!binaryExists(bin)) return null;
  const r = await run([bin, '--version'], { env: spawnEnv(h), timeoutMs: 15_000 });
  const m = stripAnsi(r.stdout + r.stderr).match(/\d+\.\d+\.\d+[\w.-]*/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------- parsers (pure; tested against captured fixtures)

/** `(low, medium, high, xhigh, max)` from the --effort entry of `claude --help` (the list may wrap to the next line). */
export function parseClaudeEfforts(help: string): string[] {
  const i = help.indexOf('--effort');
  if (i < 0) return [];
  const m = help.slice(i, i + 400).match(/\(([a-z]+(?:\s*[,|]\s*[a-z]+)+)\)/);
  return m ? m[1].split(/\s*[,|]\s*/) : [];
}

export interface ClaudeSeed { alias: string; label: string; description: string | null }

/** Built-in aliases plus the models Claude Code itself offers in /model (additionalModelOptionsCache). */
export function claudeSeeds(claudeJson: string | null): ClaudeSeed[] {
  const seeds: ClaudeSeed[] = CLAUDE_ALIASES.map((a) => ({ alias: a, label: a[0].toUpperCase() + a.slice(1), description: null }));
  if (claudeJson) {
    try {
      const extra = JSON.parse(claudeJson)?.additionalModelOptionsCache;
      if (Array.isArray(extra)) {
        for (const e of extra) {
          if (!e || typeof e.value !== 'string' || seeds.some((s) => s.alias === e.value)) continue;
          seeds.push({ alias: e.value, label: String(e.label ?? e.value), description: e.description ? String(e.description) : null });
        }
      }
    } catch { /* unreadable ~/.claude.json: aliases only */ }
  }
  return seeds;
}

/** The model id from a stream-json `system/init` line, or null. */
export function initModel(line: string): string | null {
  if (!line.includes('"init"')) return null;
  try {
    const j = JSON.parse(line);
    return j?.type === 'system' && j?.subtype === 'init' && typeof j.model === 'string' ? j.model : null;
  } catch { return null; }
}

export function parseCodexModels(json: string): CatalogModel[] {
  const j = JSON.parse(json);
  if (!Array.isArray(j?.models)) throw new Error('codex debug models: no "models" array in the output');
  const rows = [...j.models].sort((a: any, b: any) => (a.visibility === 'hide' ? 1 : 0) - (b.visibility === 'hide' ? 1 : 0) || (a.priority ?? 999) - (b.priority ?? 999));
  return rows.map((m: any): CatalogModel => ({
    id: String(m.slug),
    label: String(m.display_name ?? m.slug),
    efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((x: any) => String(x.effort)) : [],
    default_effort: m.default_reasoning_level ? String(m.default_reasoning_level) : null,
    hidden: m.visibility === 'hide',
    cost: null,
    resolves_to: null,
    description: m.description ? String(m.description) : null,
  }));
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** `provider/id` header lines, each followed by a pretty-printed JSON object. */
export function parseOpencodeModels(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  const lines = stripAnsi(text).split('\n');
  let id: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!id) return;
    let m: any = {};
    try { m = buf.join('\n').trim() ? JSON.parse(buf.join('\n')) : {}; } catch { m = {}; }
    const variants = m.variants && typeof m.variants === 'object' ? Object.keys(m.variants) : [];
    variants.sort((a, b) => (EFFORT_ORDER.indexOf(a) + 1 || 99) - (EFFORT_ORDER.indexOf(b) + 1 || 99));
    const cost = m.cost && typeof m.cost.input === 'number' ? { input: m.cost.input, output: Number(m.cost.output) || 0 } : null;
    out.push({
      id, label: String(m.name ?? id), efforts: variants, default_effort: null,
      hidden: m.status !== undefined && m.status !== 'active', cost, resolves_to: null,
      description: m.status && m.status !== 'active' ? `status: ${m.status}` : null,
    });
  };
  for (const line of lines) {
    if (/^[A-Za-z0-9][\w.-]*\/\S+$/.test(line)) { flush(); id = line.trim(); buf = []; }
    else if (id) buf.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- fetchers

const fail = (h: HarnessName, error: string, binary: string | null, version: string | null = null): HarnessCatalog =>
  ({ harness: h, ok: false, error, version, binary, models: [], fetched_at: Date.now() });

const missing = (h: RealHarness, bin: string) =>
  fail(h, `${h} not found at ${bin}. Fix: install ${h}${h === 'codex' ? ' (brew install codex)' : ''} or set SPARROW_${h.toUpperCase()}_BIN to its path, then refresh.`, null);

/** Resolve a Claude alias by reading the init event; the process is killed as soon as it arrives (no API request). */
export async function resolveClaudeModel(bin: string, alias: string, timeoutMs = 25_000): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, '-p', '--verbose', '--output-format', 'stream-json', '--setting-sources', '', '--no-session-persistence', '--model', alias, 'hi'], {
      env: spawnEnv('claude'), cwd: neutralCwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
    });
  } catch { return null; }
  const kill = () => { try { proc.kill(9); } catch {} };
  const t = setTimeout(kill, timeoutMs);
  let found: string | null = null;
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        found = initModel(line);
        if (found) break;
      }
      if (found) break;
    }
  } catch { /* killed */ } finally {
    clearTimeout(t);
    kill();
  }
  return found;
}

export async function fetchClaude(): Promise<HarnessCatalog> {
  const bin = CLAUDE_BIN();
  if (!binaryExists(bin)) return missing('claude', bin);
  const [version, help] = await Promise.all([harnessVersion('claude'), run([bin, '--help'], { env: spawnEnv('claude'), timeoutMs: 15_000 })]);
  const efforts = parseClaudeEfforts(help.stdout);
  let cj: string | null = null;
  try { cj = existsSync(CLAUDE_JSON()) ? readFileSync(CLAUDE_JSON(), 'utf8') : null; } catch { cj = null; }
  const seeds = claudeSeeds(cj);
  const resolved = await Promise.all(seeds.map((s) => resolveClaudeModel(bin, s.alias)));
  const models: CatalogModel[] = [];
  seeds.forEach((s, i) => {
    if (!resolved[i]) return;
    models.push({
      id: s.alias, label: `${s.label} (${resolved[i]})`, efforts, default_effort: null, hidden: false, cost: null,
      resolves_to: resolved[i], description: s.description,
    });
  });
  if (!models.length) {
    return fail('claude', `claude did not resolve any model alias (${seeds.map((s) => s.alias).join(', ')}). Fix: run 'claude' once and log in, then refresh.`, bin, version);
  }
  return { harness: 'claude', ok: true, error: null, version, binary: bin, models, fetched_at: Date.now() };
}

export async function fetchCodex(): Promise<HarnessCatalog> {
  const bin = CODEX_BIN();
  if (!binaryExists(bin)) return missing('codex', bin);
  const [version, r] = await Promise.all([harnessVersion('codex'), run([bin, 'debug', 'models'], { env: spawnEnv('codex'), timeoutMs: 30_000 })]);
  if (r.code !== 0) return fail('codex', `'codex debug models' failed (exit ${r.code}): ${stripAnsi(r.stderr || r.stdout).trim().slice(0, 300)}`, bin, version);
  try {
    return { harness: 'codex', ok: true, error: null, version, binary: bin, models: parseCodexModels(r.stdout), fetched_at: Date.now() };
  } catch (e) {
    return fail('codex', `could not parse 'codex debug models': ${(e as Error).message}`, bin, version);
  }
}

export async function fetchOpencode(): Promise<HarnessCatalog> {
  const bin = OPENCODE_BIN();
  if (!binaryExists(bin)) return missing('opencode', bin);
  try { ensurePlugin(); } catch { /* plugin is only needed by agents */ }
  const [version, r] = await Promise.all([harnessVersion('opencode'), run([bin, 'models', '--verbose'], { env: spawnEnv('opencode'), timeoutMs: 60_000 })]);
  if (r.code !== 0) {
    return fail('opencode', `'opencode models --verbose' failed (exit ${r.code}): ${stripAnsi(r.stderr || r.stdout).trim().slice(0, 300)}. Fix: run 'OPENCODE_CONFIG_DIR=${opencodeConfigDir()} opencode models' to see the error.`, bin, version);
  }
  const models = parseOpencodeModels(r.stdout);
  if (!models.length) return fail('opencode', `'opencode models --verbose' listed no models. Fix: run 'opencode auth login' and add a provider.`, bin, version);
  return { harness: 'opencode', ok: true, error: null, version, binary: bin, models, fetched_at: Date.now() };
}

export const FETCHERS: Record<RealHarness, () => Promise<HarnessCatalog>> = { claude: fetchClaude, codex: fetchCodex, opencode: fetchOpencode };

export async function fetchCatalog(h: RealHarness): Promise<HarnessCatalog> {
  try { return await FETCHERS[h](); } catch (e) { return fail(h, `catalog fetch crashed: ${(e as Error).message}`, null); }
}

// ---------------------------------------------------------------- login

export interface LoginResult { ok: boolean; detail: string; fix: string | null }

export async function loginStatus(h: RealHarness): Promise<LoginResult> {
  const bin = binaryFor(h);
  if (h === 'claude') {
    const r = await run([bin, 'auth', 'status'], { env: spawnEnv(h), timeoutMs: 20_000 });
    let j: any = null;
    try { j = JSON.parse(r.stdout); } catch { /* not JSON */ }
    if (j?.loggedIn === true) return { ok: true, detail: `logged in (${j.authMethod ?? 'unknown method'}${j.subscriptionType ? `, ${j.subscriptionType}` : ''})`, fix: null };
    return { ok: false, detail: stripAnsi(r.stdout + r.stderr).trim().slice(0, 200) || `exit ${r.code}`, fix: "Run 'claude' in a terminal and log in (or 'claude auth login'), then Run doctor." };
  }
  if (h === 'codex') {
    const r = await run([bin, 'login', 'status'], { env: spawnEnv(h), timeoutMs: 20_000 });
    const text = stripAnsi(r.stdout + r.stderr).trim();
    if (r.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)) return { ok: true, detail: text.split('\n')[0], fix: null };
    return { ok: false, detail: text.slice(0, 200) || `exit ${r.code}`, fix: "Run 'codex login', then Run doctor." };
  }
  const r = await run([bin, 'auth', 'list'], { env: spawnEnv(h), timeoutMs: 20_000 });
  const text = stripAnsi(r.stdout + r.stderr);
  const n = Number(text.match(/(\d+)\s+credentials?/)?.[1] ?? 0);
  if (r.code === 0 && n > 0) return { ok: true, detail: `${n} credential${n === 1 ? '' : 's'}`, fix: null };
  return { ok: false, detail: text.trim().slice(0, 200) || `exit ${r.code}`, fix: "Run 'opencode auth login' and add a provider (e.g. OpenCode Go), then Run doctor." };
}

// ---------------------------------------------------------------- cheapest model (doctor round trips, real tests)

/** Contract rule: settings.doctor_models wins; else the cheapest model the catalog offers, at its lowest effort. */
export function cheapestModel(cat: HarnessCatalog, overrides: Settings['doctor_models'] = {}): { model: string; effort: string | null } | null {
  const h = cat.harness as RealHarness;
  const pick = (m: CatalogModel | undefined) => (m ? { model: m.id, effort: m.efforts[0] ?? null } : null);
  const ov = overrides[h];
  if (ov) return pick(cat.models.find((m) => m.id === ov)) ?? { model: ov, effort: null };
  if (!cat.ok || !cat.models.length) return null;
  if (h === 'claude') {
    return pick(cat.models.find((m) => m.id === 'haiku') ?? cat.models.find((m) => /haiku/i.test(m.resolves_to ?? '')));
  }
  if (h === 'codex') {
    // parseCodexModels keeps codex's priority order (lowest first).
    const vis = cat.models.filter((m) => !m.hidden);
    const by = (re: RegExp) => vis.find((m) => re.test(m.description ?? ''));
    return pick(by(/affordable/i) ?? by(/fast|efficient/i));
  }
  const paid = cat.models.filter((m) => !m.hidden && m.cost && m.cost.input + m.cost.output > 0 && !m.id.includes('preview'));
  paid.sort((a, b) => a.cost!.input + a.cost!.output - (b.cost!.input + b.cost!.output));
  return pick(paid[0]);
}
