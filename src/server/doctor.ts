// The doctor (U1-CONTRACT): runs ONLY on POST /api/doctor/run. Per harness, in parallel: binary, login, catalog,
// spawn + live round trip with a probe agent ("reply hey" → update or done → window closed), capped at
// doctor_timeout_ms. Shared checks: tmux, port, sparrow on PATH, skills current, hook paths. Every failing check
// carries a fix. Runs are stored in the DB and streamed over SSE (doctor.updated). Sparrow never repairs anything.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  binaryExists, binaryFor, cheapestModel, harnessVersion, loginStatus, type LoginResult, opencodeLastError, type RealHarness, run, spawnEnv,
} from '../harness/catalog';
import { opencodeConfigDir, pluginSource } from '../harness/drivers/opencode';
import { BIN, COMPILED, type Settings } from '../shared/config';
import { bunPath, hookEntry, isSandboxHome, serverUrl } from '../harness/env';
import { tmuxInstallHint } from '../shared/hints';
import { ulid } from '../shared/ids';
import type { Agent, CheckStatus, DoctorCheck, DoctorRun, HarnessCatalog, HarnessHealth, HarnessName } from '../shared/types';
import type { CatalogService } from './catalog';
import { type Core, HttpError } from './core';
import { libraryProblem, rootAliasWarnings, skillPaths } from '../skills/paths';
import { readManifest } from '../skills/manifest';
import { plan } from '../skills/link';
import { scanSkills } from '../skills/scan';
import { status as skillsGitStatus } from '../skills/git';
import type { SkillPaths } from '../skills/types';
import { resumeDescriptionDrift } from './resume-lint';

export interface BinaryResult { ok: boolean; path: string | null; version: string | null; detail: string; fix: string | null }

/** Harness probes (injectable for tests). */
export interface HarnessOps {
  binary(h: HarnessName): Promise<BinaryResult>;
  login(h: HarnessName): Promise<LoginResult>;
  /** The harness's own error for a failed probe (e.g. a provider API error), when it records one. */
  diagnose?(probe: Agent): string | null;
}

export const realOps: HarnessOps = {
  async binary(h) {
    const path = binaryFor(h as RealHarness);
    if (!binaryExists(path)) {
      return { ok: false, path: null, version: null, detail: `not found at ${path}`, fix: `Install ${h}${h === 'codex' ? ' (brew install codex)' : h === 'claude' ? ' (curl -fsSL https://claude.ai/install.sh | bash)' : ' (curl -fsSL https://opencode.ai/install | bash)'} or set SPARROW_${h.toUpperCase()}_BIN to its path, then Run doctor.` };
    }
    const version = await harnessVersion(h as RealHarness);
    if (!version) return { ok: false, path, version: null, detail: `${path} did not report a version`, fix: `Run '${path} --version' in a terminal to see why it fails, fix it, then Run doctor.` };
    return { ok: true, path, version, detail: `${path} (v${version})`, fix: null };
  },
  login: (h) => loginStatus(h as RealHarness),
  diagnose: (probe) => (probe.harness === 'opencode' ? opencodeLastError(probe.session_id) : null),
};

export interface SharedCheck { id: string; label: string; run(): Promise<{ status: CheckStatus; detail: string; fix: string | null }> }

export interface DoctorDeps {
  core: Core;
  catalogs: CatalogService;
  settings: Settings;
  harnesses?: HarnessName[];        // default claude, codex, opencode
  ops?: HarnessOps;
  shared?: SharedCheck[];           // default: defaultSharedChecks()
  log?: (line: string) => void;
}

const PER_HARNESS: [suffix: string, label: string][] = [
  ['binary', 'Binary found'], ['login', 'Logged in'], ['catalog', 'Model catalog'], ['spawn', 'Spawns in tmux'], ['roundtrip', 'Live round trip'],
];

export const PROBE_TASK = 'Health check from the Sparrow doctor. Reply hey: run this shell command now: sparrow done "hey" — then stop. Do nothing else.';

/** Per-harness verdict from a finished run (the hire gate and resume status use it). */
export function healthFrom(run: DoctorRun | null, h: HarnessName): HarnessHealth {
  const get = (s: string) => run?.checks.find((c) => c.id === `${h}.${s}`) ?? null;
  const verdict = (c: DoctorCheck | null) => (!c ? null : c.status === 'pass' || c.status === 'warn' ? true : c.status === 'fail' ? false : null);
  const cs = [get('binary'), get('login'), get('roundtrip')];
  const fix = cs.find((c) => c?.status === 'fail')?.fix ?? null;
  return {
    harness: h, installed: verdict(cs[0]), logged_in: verdict(cs[1]), working: verdict(cs[2]), fix,
    checked_at: run?.ended_at ?? null,
  };
}

export class Doctor {
  private current: DoctorRun | null = null;
  private tests = new Map<string, DoctorCheck>();
  readonly harnesses: HarnessName[];
  private ops: HarnessOps;
  private shared: SharedCheck[];
  private log: (line: string) => void;

  constructor(private d: DoctorDeps) {
    this.harnesses = d.harnesses ?? ['claude', 'codex', 'opencode'];
    this.ops = d.ops ?? realOps;
    this.shared = d.shared ?? [...defaultSharedChecks(), resumeDescriptionsCheck(d.core, d.catalogs)];
    this.log = d.log ?? (() => {});
    // A run left open by a server stop is over: close it so it never blocks a new run.
    const last = d.core.store.latestDoctorRun();
    if (last && last.ended_at == null) {
      for (const c of last.checks) if (c.status === 'pending' || c.status === 'running') { c.status = 'skipped'; c.detail = c.detail || 'interrupted by a server restart'; }
      last.ended_at = Date.now();
      d.core.store.saveDoctorRun(last);
    }
  }

  get running(): boolean { return !!this.current && this.current.ended_at == null; }

  latest(): DoctorRun | null { return this.current ?? this.d.core.store.latestDoctorRun(); }

  /** Verdicts from the latest FINISHED run (a run in progress does not change hiring). */
  health(h: HarnessName): HarnessHealth | null {
    const run = this.d.core.store.latestDoctorRun(true);
    return run ? healthFrom(run, h) : null;
  }

  healthAll(): HarnessHealth[] {
    const run = this.d.core.store.latestDoctorRun(true);
    return this.harnesses.map((h) => healthFrom(run, h));
  }

  // ------------------------------------------------------------ run

  start(): DoctorRun {
    if (this.running) throw new HttpError(409, 'A doctor run is already in progress; wait for it to finish (progress streams over SSE as doctor.updated).');
    const now = Date.now();
    const checks: DoctorCheck[] = [];
    for (const h of this.harnesses) for (const [s, label] of PER_HARNESS) checks.push(blank(`${h}.${s}`, h, `${h}: ${label}`, now));
    for (const s of this.shared) checks.push(blank(s.id, null, s.label, now));
    const run: DoctorRun = { id: `doc_${ulid()}`, started_at: now, ended_at: null, checks, versions: {}, version_changed: [] };
    this.current = run;
    this.save();
    this.log(`doctor ${run.id} started`);
    this.execute(run).catch((e) => this.log(`doctor error: ${(e as Error).message}`));
    return structuredClone(run);
  }

  private save() {
    const run = this.current;
    if (!run) return;
    this.d.core.store.saveDoctorRun(run);
    this.d.core.events.emit({ type: 'doctor.updated', project_id: '*', run: structuredClone(run) });
  }

  private set(id: string, patch: Partial<DoctorCheck>) {
    const c = this.current?.checks.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch, { updated_at: Date.now() });
    this.save();
  }

  private async execute(run: DoctorRun) {
    const prev = this.d.core.store.latestDoctorRun(true);
    try {
      await Promise.all([
        ...this.harnesses.map((h) => this.harness(run, h, prev)),
        ...this.shared.map(async (s) => {
          const t = Date.now();
          this.set(s.id, { status: 'running' });
          try {
            const r = await s.run();
            this.set(s.id, { ...r, duration_ms: Date.now() - t });
          } catch (e) {
            this.set(s.id, { status: 'fail', detail: (e as Error).message, fix: 'Unexpected error in this check; see the server log.', duration_ms: Date.now() - t });
          }
        }),
      ]);
    } finally {
      run.ended_at = Date.now();
      for (const c of run.checks) if (c.status === 'pending' || c.status === 'running') c.status = 'skipped';
      this.save();
      this.log(`doctor ${run.id} finished: ${run.checks.filter((c) => c.status === 'fail').map((c) => c.id).join(', ') || 'all green'}`);
      this.current = null;
    }
  }

  private skipRest(h: HarnessName, from: string, why: string) {
    const ids = PER_HARNESS.map(([s]) => s);
    for (const s of ids.slice(ids.indexOf(from))) this.set(`${h}.${s}`, { status: 'skipped', detail: why });
  }

  private async harness(run: DoctorRun, h: HarnessName, prev: DoctorRun | null) {
    // 1. binary + version (+ "re-verified on new version")
    let t = Date.now();
    this.set(`${h}.binary`, { status: 'running' });
    const bin = await this.ops.binary(h).catch((e): BinaryResult => ({ ok: false, path: null, version: null, detail: (e as Error).message, fix: `Check that ${h} runs in a terminal.` }));
    run.versions[h] = bin.version;
    const before = prev?.versions?.[h];
    let detail = bin.detail;
    if (bin.ok && before && bin.version && before !== bin.version) {
      run.version_changed.push(h);
      detail += ` — changed from v${before}: re-verified on new version`;
    }
    this.set(`${h}.binary`, { status: bin.ok ? 'pass' : 'fail', detail, fix: bin.fix, duration_ms: Date.now() - t });
    if (!bin.ok) return this.skipRest(h, 'login', `skipped: ${h} not installed`);

    // 2. login
    t = Date.now();
    this.set(`${h}.login`, { status: 'running' });
    const login = await this.ops.login(h).catch((e): LoginResult => ({ ok: false, detail: (e as Error).message, fix: `Log in to ${h}.` }));
    this.set(`${h}.login`, { status: login.ok ? 'pass' : 'fail', detail: login.detail, fix: login.ok ? null : login.fix, duration_ms: Date.now() - t });

    // 3. catalog (refreshed as part of the run)
    t = Date.now();
    let cat: HarnessCatalog | null = null;
    if (h === 'fake') this.set(`${h}.catalog`, { status: 'skipped', detail: 'the fake harness has no model catalog' });
    else {
      this.set(`${h}.catalog`, { status: 'running' });
      cat = await this.d.catalogs.refreshOne(h as RealHarness);
      this.set(`${h}.catalog`, cat.ok
        ? { status: 'pass', detail: `${cat.models.length} models (v${cat.version ?? '?'})`, duration_ms: Date.now() - t }
        : { status: 'fail', detail: cat.error ?? 'fetch failed', fix: cat.error?.match(/Fix: (.*)$/)?.[1] ?? `Run the ${h} model list command in a terminal to see the error.`, duration_ms: Date.now() - t });
    }
    if (!login.ok) return this.skipRest(h, 'spawn', `skipped: ${h} not logged in`);

    // 4 + 5. spawn + live round trip on the cheapest model at the lowest effort
    const pick = cat ? cheapestModel(cat, this.d.settings.doctor_models) : null;
    await this.roundTrip({
      harness: h, model: pick?.model ?? null, effort: pick?.effort ?? null, run: run.id, label: h,
      onSpawn: (r) => this.set(`${h}.spawn`, r),
      onTrip: (r) => this.set(`${h}.roundtrip`, r),
    });
  }

  /**
   * Hire a probe and follow it: spawn = its window opened; round trip = update or done, then the window closed,
   * within doctor_timeout_ms. The probe is retired afterwards either way.
   */
  async roundTrip(o: {
    harness: HarnessName; model: string | null; effort: string | null; run: string; label: string; resume?: string;
    onSpawn?: (p: Partial<DoctorCheck>) => void; onTrip: (p: Partial<DoctorCheck>) => void;
  }): Promise<boolean> {
    const core = this.d.core;
    const timeout = this.d.settings.doctor_timeout_ms;
    const t0 = Date.now();
    const what = `${o.model ?? '(default model)'} · effort ${o.effort ?? '(default)'}`;
    o.onSpawn?.({ status: 'running', detail: `starting ${o.harness} TUI (${what})` });
    o.onTrip({ status: 'running', detail: `waiting for the probe to reply (${what})` });
    let probe;
    try {
      probe = core.hireProbe({ harness: o.harness, model: o.model, effort: o.effort, task: PROBE_TASK, run: o.run, label: o.label, resume: o.resume });
    } catch (e) {
      const msg = (e as Error).message;
      o.onSpawn?.({ status: 'fail', detail: msg, fix: 'See the server log.', duration_ms: Date.now() - t0 });
      o.onTrip({ status: 'skipped', detail: 'no probe' });
      return false;
    }
    const id = probe.id;
    let spawnAt: number | null = null;
    let reportAt: number | null = null;
    let reportKind = '';
    let ok = false;
    let failure: { detail: string; fix: string } | null = null;
    // Events give exact times (a fast probe can open and close its window between two polls).
    const unsub = core.events.subscribe((e) => {
      if (e.type === 'agent.updated' && e.agent.id === id && e.agent.tmux_window_id && spawnAt == null) {
        spawnAt = Date.now();
        const a = e.agent;
        o.onSpawn?.({ status: 'pass', detail: `window ${a.tmux_session}:${a.tmux_window} (${a.tmux_window_id}) opened in ${fmt(spawnAt - t0)} · ${what}`, fix: null, duration_ms: spawnAt - t0 });
      }
      if (e.type === 'message.created' && e.message.from_id === id && (e.message.kind === 'update' || e.message.kind === 'result') && reportAt == null) {
        reportAt = Date.now();
        reportKind = e.message.kind === 'result' ? 'done' : 'update';
      }
    });
    try {
      while (Date.now() - t0 < timeout) {
        const a = core.store.getAgent(id)!;
        const ended = a.state !== 'working' && a.state !== 'queued';
        if (ended && a.last_end_reason && a.last_end_reason !== 'done' && reportAt == null) {
          failure = { detail: `the probe's call ended "${a.last_end_reason}" without reporting`, fix: fixFor(o.harness, a.last_end_reason) };
          break;
        }
        if (reportAt != null && ended && !a.tmux_window_id) { ok = true; break; }
        await Bun.sleep(300);
      }
      const total = Date.now() - t0;
      if (spawnAt == null) {
        const a = core.store.getAgent(id)!;
        o.onSpawn?.({ status: 'fail', detail: failure?.detail ?? `no window after ${fmt(total)}${a.last_end_reason ? ` (call ended ${a.last_end_reason})` : ''}`, fix: `Check that tmux works and that '${o.harness}' starts in a terminal; then Run doctor.`, duration_ms: total });
      }
      if (ok) {
        o.onTrip({ status: 'pass', detail: `${what}: hire → ${reportKind} in ${fmt(reportAt! - t0)} → window closed in ${fmt(total)}`, fix: null, duration_ms: total });
      } else {
        const screen = core.lastScreenOf(id, 8);
        const why = failure?.detail ?? (reportAt == null ? `no update or done within ${fmt(timeout)}` : `reported, but the window did not close within ${fmt(timeout)}`);
        let said: string | null = null;
        try { said = this.ops.diagnose?.(core.store.getAgent(id)!) ?? null; } catch { said = null; }
        o.onTrip({
          status: 'fail', detail: `${what}: ${why}${said ? `\n${o.harness} reported: ${said}` : ''}${screen ? `\nLast screen:\n${screen}` : ''}`,
          fix: said
            ? `${o.harness} itself reported: ${said.slice(0, 300).replace(/\.+$/, '')}. Fix that in your ${o.harness} account or provider (or set doctor_models.${o.harness} in config.json to a model you can use), then Run doctor.`
            : failure?.fix ?? `Attach to the probe window (tmux session ${probe.tmux_session}) during the next run to see where ${o.harness} stops; if the model is the problem, set doctor_models.${o.harness} in config.json. Then Run doctor.`,
          duration_ms: total,
        });
      }
    } finally {
      unsub();
      await core.retireProbe(id).catch(() => {});
    }
    return ok;
  }

  // ------------------------------------------------------------ "Test this resume"

  getTest(slug: string): DoctorCheck | null { return this.tests.get(slug) ?? this.d.core.store.getResumeTest(slug); }

  startTest(slug: string): DoctorCheck {
    const cur = this.tests.get(slug);
    if (cur && cur.status === 'running') return structuredClone(cur);
    const r = this.d.core.resumes.get(slug);
    if (!r) throw new HttpError(404, `No resume "${slug}".`);
    const check: DoctorCheck = { ...blank(`test.${slug}`, r.harness, `Test resume ${slug}`, Date.now()), status: 'running', detail: 'starting' };
    this.tests.set(slug, check);
    this.d.core.store.saveResumeTest(slug, check);
    const runId = `test-${slug}-${Date.now().toString(36)}`;
    this.roundTrip({
      harness: r.harness, model: r.model, effort: r.effort, run: runId, label: `t-${slug}`, resume: slug,
      onTrip: (p) => {
        Object.assign(check, p, { updated_at: Date.now() });
        this.d.core.store.saveResumeTest(slug, check);
      },
    }).catch((e) => {
      Object.assign(check, { status: 'fail', detail: (e as Error).message, updated_at: Date.now() });
      this.d.core.store.saveResumeTest(slug, check);
    }).finally(() => { if (this.tests.get(slug) === check && check.status !== 'running') this.tests.delete(slug); });
    return structuredClone(check);
  }
}

function blank(id: string, harness: HarnessName | null, label: string, now: number): DoctorCheck {
  return { id, harness, label, status: 'pending', detail: '', fix: null, duration_ms: null, updated_at: now };
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function fixFor(h: HarnessName, reason: string): string {
  if (reason === 'provider_error') return `${h}'s model provider answered with an error (see the detail above). Fix that in your ${h} account or provider, or pick another model, then Run doctor.`;
  if (reason === 'crashed') return `${h} exited right after starting. Run it in a terminal with the same model to see the error (log in again, update it, or pick another model), then Run doctor.`;
  return `${h} started but never ran the sparrow CLI. Attach to the probe window during the next run to see why, then Run doctor.`;
}

// ---------------------------------------------------------------- shared checks

/** D1: resume descriptions that hard-code a harness or model different from the resume's own settings. */
export function resumeDescriptionsCheck(core: Core, catalogs: CatalogService): SharedCheck {
  return {
    id: 'resume-descriptions', label: 'Resume descriptions match settings',
    async run() {
      const drift = resumeDescriptionDrift(core.resumes.list(), catalogs.list());
      if (!drift.length) return { status: 'pass', detail: 'no description names a harness or model that differs from its resume', fix: null };
      return {
        status: 'warn',
        detail: drift.map((d) => `${d.slug}: ${d.problems.join('; ')}`).join('\n'),
        fix: `Replace the hard-coded name with {{runtime}} (or {{model}} / {{harness}}) in the description of ${drift.map((d) => d.slug).join(', ')} on the Resumes page; it then always matches the settings.`,
      };
    },
  };
}

const sameFile = (a: string, b: string) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/**
 * The `sparrow` on PATH check. `sparrow install` links the REAL ~/.local/bin/sparrow and writes real harness folders, so a
 * sandbox server (SPARROW_HOME or SPARROW_SKILLS_HOME set) never recommends it: it points at this checkout's own binary.
 */
export function pathCheck(found: string | null, sandbox: boolean, compiled = COMPILED): { status: CheckStatus; detail: string; fix: string | null } {
  const what = compiled ? 'binary' : "checkout's binary";
  const direct = `Run this ${what} directly (${BIN}) or the sandbox's own \`sbx\` wrapper that \`sparrow sandbox up\` prints.`;
  if (!found) {
    return {
      status: 'fail', detail: 'sparrow is not on PATH (agents still get it; your own terminal does not)',
      fix: sandbox
        ? `This is a sandbox server: do not run \`sparrow install\` (it writes your real ~/.local/bin and harness folders). ${direct}`
        : compiled
          ? 'Run `sparrow install` (it links ~/.local/bin/sparrow; make sure ~/.local/bin is on PATH), then open a new terminal.'
          : 'Run `bun run sparrow install` in the Sparrow repo (it links ~/.local/bin/sparrow; make sure ~/.local/bin is on PATH), then open a new terminal.',
    };
  }
  if (!sameFile(found, BIN)) {
    return {
      status: 'warn', detail: compiled ? `${found} is not this binary (${BIN})` : `${found} is not this checkout's ${BIN}`,
      fix: sandbox
        ? `This is a sandbox server: do not run \`sparrow install\` (it would relink your real ~/.local/bin/sparrow). ${direct}`
        : compiled ? 'Another `sparrow` comes first on PATH: remove it, or run this binary\'s `install` to relink ~/.local/bin/sparrow.' : 'Run `sparrow install` from this checkout to relink it.',
    };
  }
  return { status: 'pass', detail: found, fix: null };
}

export async function skillsCheck(paths: SkillPaths = skillPaths()): Promise<{ status: CheckStatus; detail: string; fix: string | null }> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const fix = 'Open the Skills page to review the library, links, and conflicts.';
  const unsafeLibrary = libraryProblem(paths);
  // A library that overlaps a harness folder or a migration source is refused: nothing else about the skills can be trusted.
  if (unsafeLibrary) {
    return { status: 'fail', detail: unsafeLibrary, fix: 'Set skills_dir in config.json (or SPARROW_SKILLS_DIR) to a separate folder such as ~/Skills; Sparrow will not use this one.' };
  }
  warnings.push(...rootAliasWarnings(paths));
  const source = paths.roots.sparrow;
  const names = existsSync(source) ? readdirSync(source).filter((name) => existsSync(join(source, name, 'SKILL.md'))).sort() : [];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const name of names) {
    const expected = readFileSync(join(source, name, 'SKILL.md'), 'utf8');
    for (const root of ['claude', 'codex'] as const) {
      const actual = join(paths.roots[root], name, 'SKILL.md');
      if (!existsSync(actual)) missing.push(actual);
      else if (readFileSync(actual, 'utf8') !== expected) stale.push(actual);
    }
  }
  if (missing.length) warnings.push(`Sparrow skills missing: ${missing.join(', ')}`);
  if (stale.length) warnings.push(`Sparrow skills outdated: ${stale.join(', ')}`);

  if (!existsSync(paths.library)) warnings.push(`Skills library missing: ${paths.library}`);
  let entries: ReturnType<typeof scanSkills> = [];
  let manifest;
  try {
    manifest = readManifest(paths.library);
    entries = scanSkills(paths);
  } catch (error) {
    warnings.push(`Skills inventory could not be read: ${(error as Error).message}`);
    manifest = { version: 1, skills: {} };
  }
  for (const entry of entries.filter((item) => item.root === 'library' && item.problems.some((problem) => problem.code === 'not-in-manifest'))) {
    warnings.push(`Library skill is missing from skills.json: ${entry.name}`);
  }
  for (const entry of entries.filter((item) => item.status === 'conflict' || item.status === 'broken')) {
    const managed = Array.isArray(manifest.skills[entry.name]?.harnesses) && manifest.skills[entry.name]!.harnesses.includes(entry.root as any);
    const message = entry.status === 'broken'
      ? `Broken link ${entry.root}/${entry.name}`
      : `Conflict ${entry.root}/${entry.name} (${entry.conflict ?? 'different'})`;
    (managed ? failures : warnings).push(managed ? `Managed ${message}` : message);
  }
  try {
    const actions = plan(manifest, entries, paths);
    for (const action of actions) {
      if (action.type === 'create') warnings.push(`Missing managed link ${action.root}/${action.name}`);
      else if (action.type === 'repair') warnings.push(`Managed link needs repair ${action.root}/${action.name}`);
      else if (action.type === 'remove-own-link') warnings.push(`Stale managed link ${action.root}/${action.name}`);
      else if (!entries.some((entry) => entry.root === action.root && entry.name === action.name && (entry.status === 'conflict' || entry.status === 'broken'))) {
        warnings.push(`Link conflict ${action.root}/${action.name}: ${action.reason}`);
      }
    }
  } catch (error) {
    warnings.push(`Skills links could not be checked: ${(error as Error).message}`);
  }
  const git = skillsGitStatus(paths);
  if (!git.available) warnings.push(`Skills library git status unavailable${git.error ? `: ${git.error}` : ''}`);
  else {
    if (git.dirty.length) warnings.push(`Skills library has uncommitted files: ${git.dirty.join(', ')}`);
    if (!git.remote) info.push('Skills library has no origin remote (local-only; push is unavailable).');
    else if (git.ahead === null) warnings.push('Skills library has no upstream tracking branch');
    else if (git.ahead > 0) warnings.push(`Skills library has ${git.ahead} unpushed commit(s)`);
    if (git.behind !== null && git.behind > 0) warnings.push(`Skills library is ${git.behind} commit(s) behind origin`);
  }
  const detail = [
    ...failures, ...warnings,
    ...(failures.length || warnings.length ? [] : [`${names.join(', ') || 'no Sparrow skills'} current; ${Object.keys(manifest.skills).length} library skills checked`]),
    ...info,
  ].join('; ');
  return failures.length
    ? { status: 'fail', detail, fix }
    : warnings.length
      ? { status: 'warn', detail, fix }
      : { status: 'pass', detail, fix: null };
}

export function defaultSharedChecks(): SharedCheck[] {
  return [
    {
      id: 'tmux', label: 'tmux installed',
      async run() {
        const r = await run(['tmux', '-V'], { timeoutMs: 10_000 });
        return r.code === 0
          ? { status: 'pass', detail: r.stdout.trim(), fix: null }
          : { status: 'fail', detail: (r.stderr || 'tmux not found').trim(), fix: `Install tmux (${tmuxInstallHint()}), then Run doctor.` };
      },
    },
    {
      id: 'port', label: 'Agents reach this server',
      async run() {
        const url = serverUrl();
        try {
          const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
          const j = (await res.json()) as { pid?: number };
          if (j.pid === process.pid) return { status: 'pass', detail: `${url} answered by this server (pid ${process.pid})`, fix: null };
          return { status: 'fail', detail: `${url} is answered by another process (pid ${j.pid ?? '?'}), not this server (pid ${process.pid})`, fix: `Stop the other Sparrow server ('sparrow stop', or kill pid ${j.pid}) and start this one again.` };
        } catch (e) {
          return { status: 'fail', detail: `${url}/api/health unreachable: ${(e as Error).message}`, fix: 'Agents could not report. Restart Sparrow with `sparrow stop` then `sparrow`, and check that nothing else holds the port.' };
        }
      },
    },
    {
      id: 'path', label: '`sparrow` on PATH',
      async run() { return pathCheck(Bun.which('sparrow'), isSandboxHome() || skillPaths().sandboxHome); },
    },
    {
      id: 'skills', label: 'Skills library and links',
      async run() { return skillsCheck(skillPaths()); },
    },
    {
      id: 'hooks', label: 'Hook paths exist',
      async run() {
        // Compiled: hooks run through the binary itself, no bun and no .ts entry.
        const need = COMPILED
          ? [['sparrow binary', BIN], ['opencode plugin', pluginSource()]] as const
          : [['bun', bunPath()], ['hook entry', hookEntry()], ['opencode plugin', pluginSource()]] as const;
        const bad = need.filter(([, p]) => !existsSync(p));
        if (bad.length) return { status: 'fail', detail: bad.map(([n, p]) => `${n} missing: ${p}`).join('; '), fix: COMPILED ? 'Agent hooks call the sparrow binary by absolute path. Reinstall Sparrow (or run `sparrow install`), then restart it.' : 'Agent hooks call these by absolute path. Reinstall bun or restore the Sparrow checkout (git status), then restart Sparrow.' };
        const managed = missingManagedHooks(managedSettingsFiles());
        if (managed.length) {
          const bins = [...new Set(managed.map((m) => m.binary))];
          return {
            status: 'warn',
            detail: managed.map((m) => `org-managed Claude hook ${m.binary} is missing (${m.event} in ${m.file}); agents print a non-blocking hook error`).join('; '),
            fix: `install ${bins.join(', ')} or ask your Claude admin; Sparrow cannot disable managed hooks`,
          };
        }
        return { status: 'pass', detail: `${need.map(([, p]) => p).join(', ')} · opencode config ${opencodeConfigDir()} · PATH for agents ${spawnEnv('claude').PATH.split(':').slice(0, 2).join(':')}`, fix: null };
      },
    },
  ];
}

// ---------------------------------------------------------------- org-managed Claude hooks

/** Claude settings Sparrow cannot override (remote / managed); their hooks run inside every Claude agent. */
export function managedSettingsFiles(home = skillPaths().home): string[] {
  const dir = join(home, '.claude');
  const out = [join(dir, 'remote-settings.json')];
  try { for (const f of readdirSync(dir)) if (/^managed-settings.*\.json$/.test(f)) out.push(join(dir, f)); } catch { /* no ~/.claude */ }
  out.push('/Library/Application Support/ClaudeCode/managed-settings.json');
  return out.filter((f) => existsSync(f));
}

export interface MissingHook { file: string; event: string; command: string; binary: string }

/** Hook commands in those files whose executable does not exist (e.g. /usr/local/bin/rtk). */
export function missingManagedHooks(files: string[], exists: (p: string) => boolean = existsSync, which: (b: string) => string | null = (b) => Bun.which(b)): MissingHook[] {
  const out: MissingHook[] = [];
  for (const file of files) {
    let j: any;
    try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const hooks = j?.hooks && typeof j.hooks === 'object' ? j.hooks : {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as any[]) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (typeof h?.command !== 'string') continue;
          const binary = (h.command.trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/) ?? []).slice(1).find(Boolean);
          if (!binary || /[$`]/.test(binary)) continue;
          const found = binary.includes('/') ? exists(binary) : !!which(binary);
          if (!found) out.push({ file, event, command: h.command, binary });
        }
      }
    }
  }
  return out;
}
