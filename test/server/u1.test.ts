// U1 server features: DB migration, hire gate, resume write API, apply, probes, doctor (fake harness),
// last_run / call fields, project semantics, global SSE, captain endpoints, pidfile.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/db';
import { DOCTOR_PROJECT } from '../../src/server/core';
import { BIN } from '../../src/shared/config';
import { defaultSharedChecks, healthFrom, missingManagedHooks, pathCheck } from '../../src/server/doctor';
import { removePidFile, writePidFile } from '../../src/server/main';
import { parseResume, serializeResume } from '../../src/server/resumes';
import type { CatalogModel, DoctorCheck, DoctorRun, HarnessCatalog, ResumeView } from '../../src/shared/types';
import { flush, hire, resume, setup, type Ctx } from './helpers';

const model = (id: string, efforts: string[], extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ id, label: id, efforts, default_effort: efforts[0] ?? null, hidden: false, cost: null, resolves_to: null, description: null, ...extra });
const catalog = (harness: HarnessCatalog['harness'], models: CatalogModel[], ok = true): HarnessCatalog =>
  ({ harness, ok, error: ok ? null : 'boom', version: '1.0.0', binary: `/bin/${harness}`, models, fetched_at: Date.now() });
const CODEX = catalog('codex', [model('gpt-6.1-sol', ['low', 'medium', 'high']), model('gpt-6-luna', ['low', 'medium']), model('plain', [])]);
const CLAUDE = catalog('claude', [model('haiku', ['low', 'max'], { resolves_to: 'claude-haiku-5-5' }), model('opus', ['low', 'max'], { resolves_to: 'claude-opus-5-5' })]);

/** builtin dir (like assets/resumes) + an empty user dir that receives writes. */
function resumeDirs() {
  const user = mkdtempSync(join(tmpdir(), 'sparrow-u1-user-'));
  const builtin = mkdtempSync(join(tmpdir(), 'sparrow-u1-builtin-'));
  writeFileSync(join(builtin, 'builder.md'), resume('builder', 'claude', 'model: haiku\neffort: low\n'));
  writeFileSync(join(builtin, 'builder-codex.md'), resume('builder-codex', 'codex', 'model: gpt-6.1-sol\neffort: high\n'));
  writeFileSync(join(builtin, 'dead.md'), resume('dead', 'codex', 'model: gpt-6-nova\neffort: low\n'));
  writeFileSync(join(builtin, 'fake.md'), resume('fake', 'fake', 'limits: { quiet_minutes: 1, max_call_minutes: 3 }\n'));
  return { user, builtin };
}

async function ctxWith(opts: { catalogs?: HarnessCatalog[]; settings?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  const dirs = resumeDirs();
  const ctx = await setup(opts.settings ?? {}, { resumeDirs: [dirs.user, dirs.builtin], ...(opts.extra ?? {}) });
  for (const c of opts.catalogs ?? []) ctx.catalogs.put(c);
  return { ...ctx, dirs };
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting');
};

const WRITE = (over: Record<string, unknown> = {}) => ({
  title: 'Tester', description: 'tests things', harness: 'codex', model: 'gpt-6-luna', effort: 'low', can_hire: [],
  limits: { quiet_minutes: 10, max_call_minutes: 60 }, body: 'You test things.\n', ...over,
});

// ---------------------------------------------------------------- migration

test('a v1 database is migrated in place: new columns + tables, data kept, version 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-u1-mig-'));
  const path = join(dir, 'v1.db');
  const v1 = new Database(path);
  v1.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1);
    CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, handle TEXT NOT NULL, kind TEXT NOT NULL, resume TEXT NOT NULL,
      title TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, effort TEXT, can_hire TEXT NOT NULL DEFAULT '[]', parent_id TEXT,
      depth INTEGER NOT NULL, cwd TEXT NOT NULL, tmux_session TEXT NOT NULL, tmux_window TEXT NOT NULL, tmux_window_id TEXT,
      session_id TEXT, state TEXT NOT NULL, call_id TEXT, last_end_reason TEXT, last_update TEXT, last_update_at INTEGER,
      last_seen_at INTEGER, queued_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (project_id, handle));
    CREATE TABLE calls (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT,
      exit_code INTEGER, resumed INTEGER NOT NULL DEFAULT 0, nudges INTEGER NOT NULL DEFAULT 0, restarts INTEGER NOT NULL DEFAULT 0,
      prompt TEXT NOT NULL DEFAULT '', quiet_nudged_at INTEGER, long_notified INTEGER NOT NULL DEFAULT 0);
    INSERT INTO agents VALUES ('ag_old','p','james','agent','builder','Builder','claude','opus','high','[]',NULL,1,'/x','s','james',NULL,NULL,'idle',NULL,NULL,NULL,NULL,NULL,NULL,1,1);
    INSERT INTO calls (id, agent_id, started_at, prompt) VALUES ('call_old','ag_old',5,'hi');`);
  v1.close();
  const s = new Store(path);
  expect(s.schemaVersion()).toBe(3);
  const old = s.getAgent('ag_old')!;
  expect(old.handle).toBe('james');
  expect(old.resume_hash).toBeNull();
  expect(old.last_run).toBeNull();
  expect(s.getCall('call_old')!.harness).toBeNull();
  const run = { harness: 'claude' as const, model: 'opus', effort: 'high', at: 9 };
  expect(s.patchAgent('ag_old', { resume_hash: 'abc', last_run: run }, 10).last_run).toEqual(run);
  s.saveCatalog(CODEX);
  expect(s.listCatalogs()[0].models.length).toBe(3);
  s.close();
  const again = new Store(path); // idempotent re-open
  expect(again.getAgent('ag_old')!.resume_hash).toBe('abc');
  expect(again.schemaVersion()).toBe(3);
  again.close();
});

test('a v2 database gains deliveries.wake: existing deliveries stay waking, new quiet ones are stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-v3-mig-'));
  const path = join(dir, 'v2.db');
  const v2 = new Database(path);
  v2.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (2);
    CREATE TABLE deliveries (message_id TEXT NOT NULL, to_id TEXT NOT NULL, state TEXT NOT NULL, call_id TEXT, delivered_at INTEGER,
      PRIMARY KEY (message_id, to_id));
    INSERT INTO deliveries VALUES ('msg_old', 'ag_cap', 'pending', NULL, NULL);`);
  v2.close();
  const s = new Store(path);
  expect(s.schemaVersion()).toBe(3);
  expect(s.deliveriesFor('msg_old')).toEqual([{ message_id: 'msg_old', to_id: 'ag_cap', state: 'pending', wake: true, call_id: null, delivered_at: null }]);
  expect(s.countWaking('ag_cap')).toBe(1);
  s.insertDelivery('msg_new', 'ag_cap', false);
  expect(s.deliveriesFor('msg_new')[0].wake).toBe(false);
  expect(s.countPending('ag_cap')).toBe(2);
  expect(s.countWaking('ag_cap')).toBe(1);
  s.close();
  const again = new Store(path); // idempotent re-open
  expect(again.countWaking('ag_cap')).toBe(1);
  again.close();
});

// ---------------------------------------------------------------- hire gate

describe('hire gate', () => {
  test('model gone → 409 with the available list, before any row or window', async () => {
    const ctx = await ctxWith({ catalogs: [CODEX] });
    const r = await ctx.req('POST', '/api/hire', { resume: 'dead', task: 't' }, ctx.captain.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('model gpt-6-nova no longer offered by codex; available: gpt-6.1-sol, gpt-6-luna, plain');
    expect(ctx.store.listAgents().filter((a) => a.kind === 'agent').length).toBe(0);
    await flush();
    expect(ctx.sp.starts.length).toBe(0);
  });

  test('effort must be in the model\'s efforts; non-null effort on a no-effort model is refused; overrides are checked', async () => {
    const ctx = await ctxWith({ catalogs: [CODEX] });
    const bad = await ctx.req('POST', '/api/hire', { resume: 'builder-codex', task: 't', model: 'gpt-6-luna' }, ctx.captain.id);
    expect(bad.status).toBe(409);
    expect(bad.body.error).toContain('effort high is not supported by gpt-6-luna on codex; supported: low, medium');
    const none = await ctx.req('POST', '/api/hire', { resume: 'builder-codex', task: 't', model: 'plain' }, ctx.captain.id);
    expect(none.status).toBe(409);
    expect(none.body.error).toContain('has no effort levels');
    const ok = await ctx.req('POST', '/api/hire', { resume: 'builder-codex', task: 't', model: 'gpt-6-luna', effort: 'medium' }, ctx.captain.id);
    expect(ok.status).toBe(200);
    expect(ok.body.agent.model).toBe('gpt-6-luna');
  });

  test('claude: alias, full id and resolves_to all pass; an unknown model does not', async () => {
    const ctx = await ctxWith({ catalogs: [CLAUDE] });
    expect((await ctx.req('POST', '/api/hire', { resume: 'builder', task: 't' }, ctx.captain.id)).status).toBe(200);
    expect((await ctx.req('POST', '/api/hire', { resume: 'builder', task: 't', model: 'claude-opus-5-5' }, ctx.captain.id)).status).toBe(200);
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 't', model: 'claude-mythos-9' }, ctx.captain.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('no longer offered by claude');
  });

  test('no catalog, or a failed fetch → allow; fake always passes', async () => {
    const ctx = await ctxWith();
    expect((await ctx.req('POST', '/api/hire', { resume: 'dead', task: 't' }, ctx.captain.id)).status).toBe(200);
    ctx.catalogs.put(catalog('codex', [], false));
    expect((await ctx.req('POST', '/api/hire', { resume: 'dead', task: 't' }, ctx.captain.id)).status).toBe(200);
    ctx.catalogs.put(CODEX);
    expect((await ctx.req('POST', '/api/hire', { resume: 'fake', task: 't' }, ctx.captain.id)).status).toBe(200);
  });

  test('the latest finished doctor run says not logged in → 409 with its fix', async () => {
    const ctx = await ctxWith({
      settings: { doctor_timeout_ms: 2000 },
      extra: {
        doctorHarnesses: ['codex'],
        fetcher: async () => CODEX,
        doctorOps: {
          binary: async () => ({ ok: true, path: '/bin/codex', version: '0.163.0', detail: '/bin/codex (v0.163.0)', fix: null }),
          login: async () => ({ ok: false, detail: 'Not logged in', fix: "Run 'codex login', then Run doctor." }),
        },
      },
    });
    // before any doctor run: allowed
    expect((await ctx.req('POST', '/api/hire', { resume: 'builder-codex', task: 't' }, ctx.captain.id)).status).toBe(200);
    const started = await ctx.req('POST', '/api/doctor/run');
    expect(started.status).toBe(200);
    await until(async () => (await ctx.req('GET', '/api/doctor')).body.run.ended_at != null);
    const d = (await ctx.req('GET', '/api/doctor')).body as { run: DoctorRun; health: any[] };
    expect(d.run.checks.find((c) => c.id === 'codex.login')!.status).toBe('fail');
    expect(d.run.checks.find((c) => c.id === 'codex.spawn')!.status).toBe('skipped');
    expect(d.health[0]).toMatchObject({ harness: 'codex', installed: true, logged_in: false, fix: "Run 'codex login', then Run doctor." });
    const before = ctx.store.listAgents().length;
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder-codex', task: 't' }, ctx.captain.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^codex is not logged in \(doctor, \d+ s ago\)\. Fix: Run 'codex login', then Run doctor\.$/);
    expect(ctx.store.listAgents().length).toBe(before);
    expect((await ctx.req('GET', '/api/resumes/builder-codex')).body.status).toBe('harness_logged_out');
  });
});

// ---------------------------------------------------------------- resume_hash / last_run / call fields

test('hire records resume_hash; each call start persists last_run and the call harness/model/effort', async () => {
  const ctx = await ctxWith({ catalogs: [CLAUDE] });
  const a = await hire(ctx, 'builder', 'do it', { effort: 'max' });
  await flush();
  const view = (await ctx.req('GET', '/api/resumes/builder')).body as ResumeView;
  const row = ctx.store.getAgent(a.id)!;
  expect(row.resume_hash).toBe(view.hash);
  expect(row.last_run).toMatchObject({ harness: 'claude', model: 'haiku', effort: 'max' });
  const call = ctx.store.getCall(row.call_id!)!;
  expect([call.harness, call.model, call.effort]).toEqual(['claude', 'haiku', 'max']);
  const listed = (await ctx.req('GET', `/api/agents?project=${a.project_id}`)).body.find((x: any) => x.id === a.id);
  expect(listed.last_run.model).toBe('haiku');
  expect(listed.resume_hash).toBe(view.hash);
});

// ---------------------------------------------------------------- resume write API

describe('resume write API', () => {
  test('list views carry status, hash, builtin; model_gone flagged against the catalog', async () => {
    const ctx = await ctxWith({ catalogs: [CODEX, CLAUDE] });
    const list = (await ctx.req('GET', '/api/resumes')).body as ResumeView[];
    const by = Object.fromEntries(list.map((r) => [r.slug, r]));
    expect(by.dead.status).toBe('model_gone');
    expect(by.dead.status_detail).toContain('model gpt-6-nova no longer offered by codex');
    expect(by['builder-codex'].status).toBe('ok');
    expect(by.builder.resolved_model).toBe('claude-haiku-5-5');
    expect(by.builder.builtin).toBe(true);
    expect(by.builder.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(by.fake.status).toBe('ok');
  });

  test('create (201, file on disk, SSE) · 409 on an existing slug · 400 names the field', async () => {
    const ctx = await ctxWith({ catalogs: [CODEX] });
    const r = await ctx.req('POST', '/api/resumes', WRITE({ slug: 'tester', description: 'has: colons # and "quotes"' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'tester', harness: 'codex', model: 'gpt-6-luna', effort: 'low', builtin: false, status: 'ok' });
    const file = join(ctx.dirs.user, 'tester.md');
    expect(readFileSync(file, 'utf8')).toStartWith('---\nname: tester\ntitle: Tester\n');
    expect(r.body.description).toBe('has: colons # and "quotes"'); // round-trips through the frontmatter
    expect(ctx.events.some((e) => e.type === 'resume.updated' && e.project_id === '*' && e.resume.slug === 'tester')).toBe(true);
    expect((await ctx.req('POST', '/api/resumes', WRITE({ slug: 'tester' }))).status).toBe(409);
    expect((await ctx.req('POST', '/api/resumes', WRITE({ slug: 'builder' }))).status).toBe(409); // builtin slug exists too
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ slug: 'Bad Slug' }, /^slug/],
      [{ slug: 'x1', title: '' }, /^title/],
      [{ slug: 'x2', harness: 'gemini' }, /^harness/],
      [{ slug: 'x3', model: 'gpt-6-nova' }, /^model: model gpt-6-nova no longer offered by codex/],
      [{ slug: 'x4', effort: 'ultra' }, /^effort: effort ultra is not supported/],
      [{ slug: 'x5', limits: { quiet_minutes: -1 } }, /^limits\.quiet_minutes/],
      [{ slug: 'x6', can_hire: ['Not A Slug'] }, /^can_hire/],
      [{ slug: 'x7', body: '   ' }, /^body/],
    ];
    for (const [over, re] of cases) {
      const b = await ctx.req('POST', '/api/resumes', WRITE(over));
      expect(b.status).toBe(400);
      expect(b.body.error).toMatch(re);
    }
    expect(readdirSync(ctx.dirs.user).filter((f) => f.endsWith('.md'))).toEqual(['tester.md']);
  });

  test('update a builtin → user copy, new hash; hand-edit format still parses; restart-safe', async () => {
    const ctx = await ctxWith({ catalogs: [CODEX] });
    const before = (await ctx.req('GET', '/api/resumes/builder-codex')).body as ResumeView;
    const r = await ctx.req('PUT', '/api/resumes/builder-codex', WRITE({ title: 'Builder (Codex)', model: 'gpt-6.1-sol', effort: 'medium', body: 'New body line.\n' }));
    expect(r.status).toBe(200);
    expect(r.body.builtin).toBe(false);
    expect(r.body.effort).toBe('medium');
    expect(r.body.hash).not.toBe(before.hash);
    const text = readFileSync(join(ctx.dirs.user, 'builder-codex.md'), 'utf8');
    const parsed = parseResume(text, '/x/builder-codex.md', { quiet_minutes: 1, max_call_minutes: 1 });
    expect(parsed).toMatchObject({ title: 'Builder (Codex)', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', limits: { quiet_minutes: 10, max_call_minutes: 60 } });
    expect(parsed.body).toBe('New body line.\n');
    expect((await ctx.req('PUT', '/api/resumes/nope', WRITE())).status).toBe(404);
    // no tmp files left behind (atomic write)
    expect(readdirSync(ctx.dirs.user).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  test('duplicate · delete with tombstone hides the builtin · re-create clears it', async () => {
    const ctx = await ctxWith({ catalogs: [CODEX] });
    const d = await ctx.req('POST', '/api/resumes/builder-codex/duplicate', { slug: 'builder-codex-2' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ slug: 'builder-codex-2', model: 'gpt-6.1-sol', builtin: false });
    expect((await ctx.req('POST', '/api/resumes/builder-codex/duplicate', { slug: 'builder-codex-2' })).status).toBe(409);

    // builtin-only slug
    expect((await ctx.req('DELETE', '/api/resumes/builder-codex')).body).toEqual({ ok: true });
    expect(existsSync(join(ctx.dirs.user, '.deleted', 'builder-codex'))).toBe(true);
    expect((await ctx.req('GET', '/api/resumes/builder-codex')).status).toBe(404);
    expect(((await ctx.req('GET', '/api/resumes')).body as ResumeView[]).map((r) => r.slug)).not.toContain('builder-codex');
    expect(ctx.events.some((e) => e.type === 'resume.deleted' && e.slug === 'builder-codex' && e.project_id === '*')).toBe(true);
    expect((await ctx.req('POST', '/api/hire', { resume: 'builder-codex', task: 't' }, ctx.captain.id)).status).toBe(404);

    // user-only slug: moved to .deleted (recoverable), no tombstone needed
    expect((await ctx.req('DELETE', '/api/resumes/builder-codex-2')).status).toBe(200);
    expect(existsSync(join(ctx.dirs.user, 'builder-codex-2.md'))).toBe(false);
    expect(readdirSync(join(ctx.dirs.user, '.deleted')).some((f) => f.startsWith('builder-codex-2.md.'))).toBe(true);
    expect((await ctx.req('DELETE', '/api/resumes/builder-codex-2')).status).toBe(404);

    // re-create the tombstoned slug
    expect((await ctx.req('POST', '/api/resumes', WRITE({ slug: 'builder-codex' }))).status).toBe(201);
    expect(existsSync(join(ctx.dirs.user, '.deleted', 'builder-codex'))).toBe(false);
  });

  test('agents hired from a deleted resume keep working', async () => {
    const ctx = await ctxWith();
    const a = await hire(ctx, 'fake', 'go');
    await flush();
    expect((await ctx.req('DELETE', '/api/resumes/fake')).status).toBe(200);
    const r = await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'still there?' }, ctx.captain.id);
    expect(r.status).toBe(200);
  });

  test('stale agents + apply: agent takes the new settings and its next envelope starts with the new resume text', async () => {
    const ctx = await ctxWith({ catalogs: [CODEX] });
    const a = await hire(ctx, 'builder-codex', 'first task');
    await flush();
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, ctx.store.getAgent(a.id)!.call_id);
    await ctx.clock.advance(10_000);
    expect(((await ctx.req('GET', '/api/resumes/builder-codex')).body as ResumeView).stale_agents).toEqual([]);
    const upd = await ctx.req('PUT', '/api/resumes/builder-codex', WRITE({ model: 'gpt-6.1-sol', effort: 'medium', body: 'Brand new role text.\n' }));
    expect(upd.body.stale_agents).toEqual([a.id]);
    const ap = await ctx.req('POST', '/api/resumes/builder-codex/apply');
    expect(ap.body).toEqual({ updated: [a.id] });
    const row = ctx.store.getAgent(a.id)!;
    expect([row.model, row.effort, row.title, row.resume_hash]).toEqual(['gpt-6.1-sol', 'medium', 'Tester', upd.body.hash]);
    expect(((await ctx.req('GET', '/api/resumes/builder-codex')).body as ResumeView).stale_agents).toEqual([]);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'second task' }, ctx.captain.id);
    await flush();
    const start = ctx.sp.startsFor(a.id).at(-1)!;
    expect(start.prompt).toStartWith('[sparrow] Your resume "builder-codex" was updated by the user. Your role from now on:\n\nBrand new role text.');
    expect(start.prompt).toContain('second task');
    expect(start.agent.effort).toBe('medium');
    // only once
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, ctx.store.getAgent(a.id)!.call_id);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'third' }, ctx.captain.id);
    await flush();
    expect(ctx.sp.startsFor(a.id).at(-1)!.prompt).not.toContain('was updated by the user');
  });

  test('serializeResume round-trips odd values', () => {
    const req = { title: 'A: b', description: '#tag, "q"', harness: 'opencode' as const, model: 'opencode-go/glm-5.3', effort: null, can_hire: ['builder', 'x-1'], limits: { quiet_minutes: 5, max_call_minutes: 7 }, body: 'Body\n' };
    const r = parseResume(serializeResume('odd', req), '/d/odd.md', { quiet_minutes: 1, max_call_minutes: 1 });
    expect(r).toMatchObject({ ...req, slug: 'odd' });
  });
});

// ---------------------------------------------------------------- probes + doctor (fake harness)

const okOps = {
  binary: async () => ({ ok: true, path: '/bin/fake', version: '1.0.0', detail: '/bin/fake (v1.0.0)', fix: null }),
  login: async () => ({ ok: true, detail: 'yes', fix: null }),
};

async function doctorCtx(settings: Record<string, unknown> = {}) {
  return ctxWith({
    settings: { close_grace_ms: 1000, ...settings },
    extra: {
      doctorHarnesses: ['fake'], doctorOps: okOps,
      doctorShared: [{ id: 'tmux', label: 'tmux installed', run: async () => ({ status: 'fail' as const, detail: 'tmux not found', fix: 'Install tmux (brew install tmux), then Run doctor.' }) }],
    },
  });
}

const probeOf = (ctx: Ctx) => ctx.store.listAgents(DOCTOR_PROJECT).find((a) => a.kind === 'probe' && a.state === 'working');

describe('doctor + probes', () => {
  test('round trip passes: probe hired in _doctor, done, window closed, retired; hidden everywhere; SSE doctor.updated', async () => {
    const ctx = await doctorCtx({ max_running: 1 });
    await hire(ctx, 'fake', 'occupy the only slot'); // max_running reached
    await flush();
    const run = (await ctx.req('POST', '/api/doctor/run')).body.run as DoctorRun;
    expect(run.ended_at).toBeNull();
    expect(run.checks.map((c) => c.id)).toEqual(['fake.binary', 'fake.login', 'fake.catalog', 'fake.spawn', 'fake.roundtrip', 'tmux']);
    expect((await ctx.req('POST', '/api/doctor/run')).status).toBe(409);
    await until(() => !!probeOf(ctx)?.tmux_window_id);
    const probe = probeOf(ctx)!;
    expect(probe.tmux_session).toBe('sptest-doctor');
    expect(ctx.store.countWorking()).toBe(1); // the probe is not counted
    // hidden from projects, agents and chat
    expect((await ctx.req('GET', '/api/projects')).body.map((p: any) => p.id)).not.toContain(DOCTOR_PROJECT);
    expect((await ctx.req('GET', '/api/agents')).body.some((a: any) => a.project_id === DOCTOR_PROJECT)).toBe(false);
    expect((await ctx.req('GET', '/api/messages')).body.some((m: any) => m.project_id === DOCTOR_PROJECT)).toBe(false);
    expect((await ctx.req('GET', `/api/agents?project=${DOCTOR_PROJECT}`)).body.some((a: any) => a.id === probe.id)).toBe(true);
    const task = ctx.sp.startsFor(probe.id)[0].prompt;
    expect(task).toContain('sparrow done "hey"');
    // the probe replies
    const done = await ctx.req('POST', '/api/done', { summary: 'hey' }, probe.id, probe.call_id);
    expect(done.body.ended).toBe(true);
    await ctx.clock.advance(1000); // close grace → window closed
    await until(async () => (await ctx.req('GET', '/api/doctor')).body.run.ended_at != null);
    const fin = (await ctx.req('GET', '/api/doctor')).body as { run: DoctorRun; health: any[] };
    const c = (id: string) => fin.run.checks.find((x) => x.id === id)!;
    expect(c('fake.binary').status).toBe('pass');
    expect(c('fake.catalog').status).toBe('skipped');
    expect(c('fake.spawn').status).toBe('pass');
    expect(c('fake.roundtrip').status).toBe('pass');
    expect(c('fake.roundtrip').detail).toMatch(/hire → done in .* → window closed in/);
    expect(c('fake.roundtrip').duration_ms).toBeGreaterThan(0);
    expect(c('tmux')).toMatchObject({ status: 'fail', fix: 'Install tmux (brew install tmux), then Run doctor.' });
    expect(fin.health[0]).toMatchObject({ harness: 'fake', installed: true, logged_in: true, working: true });
    expect(fin.run.versions).toEqual({ fake: '1.0.0' });
    expect(ctx.store.getAgent(probe.id)!.state).toBe('retired');
    expect(ctx.events.filter((e) => e.type === 'doctor.updated' && e.project_id === '*').length).toBeGreaterThan(5);
    // stored in the DB
    expect(ctx.store.latestDoctorRun(true)!.id).toBe(run.id);
  });

  test('a probe that never reports fails the round trip with the harness\'s own error as the fix, and is retired', async () => {
    const ctx = await ctxWith({
      settings: { doctor_timeout_ms: 800 },
      extra: { doctorHarnesses: ['fake'], doctorShared: [], doctorOps: { ...okOps, diagnose: (p: any) => `APIError: subscription ended (${p.handle})` } },
    });
    await ctx.req('POST', '/api/doctor/run');
    await until(async () => (await ctx.req('GET', '/api/doctor')).body.run.ended_at != null);
    const run = (await ctx.req('GET', '/api/doctor')).body.run as DoctorRun;
    const rt = run.checks.find((x) => x.id === 'fake.roundtrip')!;
    expect(rt.status).toBe('fail');
    expect(rt.detail).toContain('no update or done within 0.8 s\nfake reported: APIError: subscription ended (fake)');
    expect(rt.fix).toStartWith('fake itself reported: APIError: subscription ended (fake). Fix that in your fake account');
    expect(ctx.store.listAgents(DOCTOR_PROJECT).filter((a) => a.kind === 'probe').every((a) => a.state === 'retired')).toBe(true);
    expect(ctx.sp.stops.length).toBe(1);
  });

  test('version change since the last run is flagged ("re-verified on new version")', async () => {
    let v = '1.0.0';
    const ctx = await ctxWith({
      settings: { doctor_timeout_ms: 300 },
      extra: { doctorHarnesses: ['fake'], doctorOps: { ...okOps, binary: async () => ({ ok: true, path: '/bin/fake', version: v, detail: `v${v}`, fix: null }) } },
    });
    await ctx.req('POST', '/api/doctor/run');
    await until(async () => (await ctx.req('GET', '/api/doctor')).body.run.ended_at != null);
    v = '1.1.0';
    await ctx.req('POST', '/api/doctor/run');
    await until(async () => (await ctx.req('GET', '/api/doctor')).body.run.ended_at != null);
    const run = (await ctx.req('GET', '/api/doctor')).body.run as DoctorRun;
    expect(run.version_changed).toEqual(['fake']);
    expect(run.checks[0].detail).toContain('changed from v1.0.0: re-verified on new version');
  });

  test('test resume: POST returns a running check; GET follows it to pass', async () => {
    const ctx = await doctorCtx();
    expect((await ctx.req('GET', '/api/resumes/fake/test')).status).toBe(404);
    const r = await ctx.req('POST', '/api/resumes/fake/test');
    expect(r.body.check).toMatchObject({ id: 'test.fake', harness: 'fake', status: 'running' });
    await until(() => !!probeOf(ctx)?.tmux_window_id);
    const probe = probeOf(ctx)!;
    expect(probe.resume).toBe('fake');
    expect(ctx.sp.startsFor(probe.id)[0].system_prompt).toContain('You are the fake.'); // the resume's own body
    await ctx.req('POST', '/api/update', { text: 'hey' }, probe.id, probe.call_id);
    await ctx.req('POST', '/api/done', { summary: 'hey' }, probe.id, probe.call_id);
    await ctx.clock.advance(1000);
    await until(async () => ((await ctx.req('GET', '/api/resumes/fake/test')).body as DoctorCheck).status !== 'running');
    const c = (await ctx.req('GET', '/api/resumes/fake/test')).body as DoctorCheck;
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('hire → update in');
    expect((await ctx.req('POST', '/api/resumes/nope/test')).status).toBe(404);
  });

  test('boot recovery retires probes a restart interrupted', async () => {
    const ctx = await doctorCtx();
    const p = ctx.core.hireProbe({ harness: 'fake', model: null, effort: null, task: 'hey', run: 'r1', label: 'fake' });
    await until(() => !!ctx.store.getAgent(p.id)!.tmux_window_id);
    await ctx.core.recover();
    expect(ctx.store.getAgent(p.id)!.state).toBe('retired');
    expect(ctx.sp.stopsFor(p.id).length).toBe(1);
  });

  test('managed Claude hooks with a missing binary are reported (warn input), present ones are not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparrow-u1-managed-'));
    const f = join(dir, 'remote-settings.json');
    writeFileSync(f, JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/rtk hook claude' }, { type: 'command', command: '/bin/echo ok' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'nosuchtool-xyz --flag' }, { type: 'command', command: '"$HOME/x" y' }] }],
    } }));
    const miss = missingManagedHooks([f], (p) => p === '/bin/echo', () => null);
    expect(miss.map((m) => [m.event, m.binary])).toEqual([['PreToolUse', '/usr/local/bin/rtk'], ['Stop', 'nosuchtool-xyz']]);
    expect(missingManagedHooks([join(dir, 'nope.json')])).toEqual([]);
    expect(defaultSharedChecks().map((c) => c.id)).toEqual(['tmux', 'port', 'path', 'skills', 'hooks']);
  });

  test('the PATH check never tells a sandbox server to run `sparrow install` (it writes the real ~/.local/bin and harness folders)', () => {
    const nowhere = pathCheck(null, true);
    const elsewhere = pathCheck(process.execPath, true);          // on PATH, but not this checkout's bin/sparrow
    for (const r of [nowhere, elsewhere]) {
      expect(r.fix).toContain('sandbox');
      expect(r.fix).toContain('do not run `sparrow install`');
      expect(r.fix).toContain('sbx');
    }
    expect(nowhere.status).toBe('fail');
    expect(elsewhere.status).toBe('warn');
    // real server: unchanged advice
    expect(pathCheck(null, false).fix).toContain('bun run sparrow install');
    expect(pathCheck(process.execPath, false).fix).toBe('Run `sparrow install` from this checkout to relink it.');
    expect(pathCheck(BIN, true)).toMatchObject({ status: 'pass', fix: null });
  });

  test('healthFrom maps check statuses (warn counts as fine, missing run = unknown)', () => {
    const ck = (id: string, status: DoctorCheck['status'], fix: string | null = null): DoctorCheck => ({ id, harness: 'codex', label: id, status, detail: '', fix, duration_ms: null, updated_at: 0 });
    const run: DoctorRun = { id: 'doc_1', started_at: 0, ended_at: 5, checks: [ck('codex.binary', 'warn'), ck('codex.login', 'fail', 'log in'), ck('codex.roundtrip', 'skipped')], versions: {}, version_changed: [] };
    expect(healthFrom(run, 'codex')).toEqual({ harness: 'codex', installed: true, logged_in: false, working: null, fix: 'log in', checked_at: 5 });
    expect(healthFrom(null, 'claude')).toEqual({ harness: 'claude', installed: null, logged_in: null, working: null, fix: null, checked_at: null });
  });
});

// ---------------------------------------------------------------- catalog endpoints + global SSE

test('GET /api/catalog, POST refresh (waits for the fetch), catalog.updated reaches a ?project= subscriber', async () => {
  let n = 0;
  const ctx = await ctxWith({ extra: { catalogHarnesses: ['codex'], fetcher: async () => ({ ...CODEX, fetched_at: ++n }) } });
  expect((await ctx.req('GET', '/api/catalog')).body).toEqual([]);
  const res = await ctx.app.request('/api/events?project=someproject');
  const reader = res.body!.getReader();
  const r = await ctx.req('POST', '/api/catalog/refresh');
  expect(r.body.length).toBe(1);
  expect(r.body[0]).toMatchObject({ harness: 'codex', ok: true, fetched_at: 1 });
  expect((await ctx.req('GET', '/api/catalog')).body[0].models.length).toBe(3);
  let text = '';
  const dec = new TextDecoder();
  while (!text.includes('catalog.updated')) text += dec.decode((await reader.read()).value);
  expect(text).toContain('"project_id":"*"');
  await reader.cancel();
  // persisted: a new app over the same store sees it
  expect(ctx.store.listCatalogs()[0].fetched_at).toBe(1);
});

// ---------------------------------------------------------------- project semantics + captain endpoints

test('registerCaptain: longest registered root containing cwd wins, else detectRoot', async () => {
  const ctx = await setup();
  const sub = join(ctx.root, 'sub');
  const inner = join(ctx.root, 'sub', 'deeper');
  mkdirSync(inner, { recursive: true });
  const a = await ctx.req('POST', '/api/captains/register', { cwd: inner });
  expect(a.body.project.root).toBe(ctx.root); // subfolder of a registered project → that project
  // register `sub` explicitly as its own project root via a store insert (e.g. a nested repo registered earlier)
  ctx.store.insertProject({ id: 'nested', name: 'nested', root: sub, created_at: 1 });
  const b = await ctx.req('POST', '/api/captains/register', { cwd: inner });
  expect(b.body.project.id).toBe('nested');
  const other = mkdtempSync(join(tmpdir(), 'sparrow-u1-other-'));
  const c = await ctx.req('POST', '/api/captains/register', { cwd: other });
  expect(c.body.project.root).toBe(other);
  // a sibling with a common prefix is NOT inside
  const sib = `${ctx.root}-sibling`;
  mkdirSync(sib, { recursive: true });
  expect((await ctx.req('POST', '/api/captains/register', { cwd: sib })).body.project.root).toBe(sib);
});

test('captain endpoints: recent roots newest first; start calls launchCaptain; bad cwd 400', async () => {
  const calls: any[] = [];
  const ctx = await ctxWith({
    extra: { launchCaptain: async (req: any) => { calls.push(req); return { session: 's', window: 'captain', window_id: '@1', cwd: req.cwd, attach: 'tmux attach -t =s' }; } },
  });
  const other = mkdtempSync(join(tmpdir(), 'sparrow-u1-recent-'));
  await ctx.clock.advance(60_000);
  await ctx.req('POST', '/api/captains/register', { cwd: other });
  expect((await ctx.req('GET', '/api/captain/recent')).body).toEqual([other, ctx.root]);
  const r = await ctx.req('POST', '/api/captain/start', { cwd: other, model: 'haiku', effort: 'low' });
  expect(r.status).toBe(200);
  expect(r.body.attach).toBe('tmux attach -t =s');
  expect(calls).toEqual([{ cwd: other, model: 'haiku', effort: 'low' }]);
  expect((await ctx.req('POST', '/api/captain/start', { cwd: '/definitely/not/here' })).status).toBe(400);
  expect((await ctx.req('POST', '/api/captain/start', {})).status).toBe(400);
});

test('pidfile: written with pid/port, removed only when it is ours', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'sparrow-u1-pid-')), 'server.pid');
  writePidFile(4141, f);
  expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ pid: process.pid, port: 4141 });
  removePidFile(f);
  expect(existsSync(f)).toBe(false);
  writeFileSync(f, JSON.stringify({ pid: 1, port: 4141 }));
  removePidFile(f);
  expect(existsSync(f)).toBe(true);
});
