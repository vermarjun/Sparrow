// Helper resumes (deckhand / advisor: helper + one_shot flags) and the live Settings API.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxBlock, resumesDirectory } from '../../src/cli/format';
import { ASSETS, DEFAULT_SETTINGS } from '../../src/shared/config';
import type { MessageView } from '../../src/shared/types';
import { messageHeader } from '../../src/server/prompts';
import { parseResume, serializeResume, validateResumeReq } from '../../src/server/resumes';
import { SettingsService } from '../../src/server/settings';
import { agentOf, hire, makeResumesDir, resume, setup } from './helpers';

const LIMITS = { quiet_minutes: 15, max_call_minutes: 90 };

/** The standard test resumes plus a helper pair; builder may hire both helpers, sub-captain may hire builder + deckhand. */
function helperResumes(): string {
  const dir = makeResumesDir();
  writeFileSync(join(dir, 'builder.md'), resume('builder', 'claude', 'model: sonnet\ncan_hire: [deckhand, advisor]\n'));
  writeFileSync(join(dir, 'sub-captain.md'), resume('sub-captain', 'claude', 'can_hire: [builder, deckhand]\n'));
  writeFileSync(join(dir, 'deckhand.md'), resume('deckhand', 'claude', 'model: haiku\neffort: medium\ncan_hire: []\nhelper: true\none_shot: true\n'));
  writeFileSync(join(dir, 'advisor.md'), resume('advisor', 'claude', 'model: opus\neffort: medium\ncan_hire: []\nhelper: true\n'));
  // A hand-edited helper that lists hires anyway: helpers are leaves regardless.
  writeFileSync(join(dir, 'sloppy.md'), resume('sloppy', 'claude', 'can_hire: [builder]\nhelper: true\n'));
  return dir;
}

const helperSetup = (settings = {}, extra = {}) =>
  setup({ max_running: 10, ...settings }, { resumeDirs: [helperResumes()], configFile: join(mkdtempSync(join(tmpdir(), 'sp-cfg-')), 'config.json'), ...extra });

describe('resume flags: helper / one_shot', () => {
  test('parse, serialize round trip, absent = not set', () => {
    const r = parseResume(resume('deckhand', 'claude', 'helper: true\none_shot: true\n'), '/x/deckhand.md', DEFAULT_SETTINGS);
    expect(r.helper).toBe(true);
    expect(r.one_shot).toBe(true);
    const plain = parseResume(resume('builder', 'claude'), '/x/builder.md', DEFAULT_SETTINGS);
    expect('helper' in plain).toBe(false);
    expect('one_shot' in plain).toBe(false);
    const text = serializeResume('deckhand', { title: 'Deckhand', description: 'd', harness: 'claude', model: 'haiku', effort: 'medium', can_hire: [], limits: LIMITS, body: 'b', helper: true, one_shot: true });
    expect(text).toContain('helper: true\none_shot: true\n---');
    const back = parseResume(text, '/x/deckhand.md', DEFAULT_SETTINGS);
    expect([back.helper, back.one_shot]).toEqual([true, true]);
    expect(serializeResume('b', { title: 'B', description: '', harness: 'claude', model: null, effort: null, can_hire: [], limits: LIMITS, body: 'b' })).not.toContain('helper');
  });

  test('validation: booleans only; a helper may not hire', () => {
    const base = { slug: 'x', title: 'X', harness: 'claude', body: 'b' };
    expect(validateResumeReq({ ...base, helper: 'yes' }, { create: true })).toEqual({ error: 'helper must be true or false' });
    expect(validateResumeReq({ ...base, one_shot: 1 }, { create: true })).toEqual({ error: 'one_shot must be true or false' });
    expect('error' in validateResumeReq({ ...base, helper: true, can_hire: ['builder'] }, { create: true })).toBe(true);
    const ok = validateResumeReq({ ...base, helper: true, one_shot: false }, { create: true });
    expect('value' in ok && ok.value.helper === true && ok.value.one_shot === false).toBe(true);
  });

  test('shipped resumes: deckhand = Haiku medium one-shot helper, advisor = Opus medium helper; workers may hire them', () => {
    const load = (slug: string) => parseResume(readFileSync(join(ASSETS, 'resumes', `${slug}.md`), 'utf8'), `${slug}.md`, DEFAULT_SETTINGS);
    const d = load('deckhand');
    expect([d.harness, d.model, d.effort, d.helper, d.one_shot, d.can_hire]).toEqual(['claude', 'haiku', 'medium', true, true, []]);
    expect(d.limits).toEqual({ quiet_minutes: 5, max_call_minutes: 15 });
    const a = load('advisor');
    expect([a.harness, a.model, a.effort, a.helper, a.one_shot, a.can_hire]).toEqual(['claude', 'opus', 'medium', true, undefined, []]);
    for (const w of ['builder', 'builder-codex', 'verifier', 'sub-captain']) expect(load(w).can_hire).toEqual(expect.arrayContaining(['deckhand', 'advisor']));
    expect(load('researcher').can_hire).toEqual(['deckhand']);
    expect(load('presenter').can_hire).toEqual([]);
  });

  test('`sparrow resumes` marks helpers and one-shot resumes', () => {
    const r = parseResume(resume('deckhand', 'claude', 'helper: true\none_shot: true\n'), '/x/deckhand.md', DEFAULT_SETTINGS);
    const out = resumesDirectory([r]);
    expect(out).toContain('can hire: nobody');
    expect(out).toContain('helper (a leaf; hiring it does not make you a captain) · one-shot (released right after its report');
  });
});

describe('hiring helpers', () => {
  test('a builder may hire its helpers; helpers never hire, whatever their file says', async () => {
    const ctx = await helperSetup();
    const b = await hire(ctx, 'builder', 'build');
    const d = await hire(ctx, 'deckhand', 'grep', {}, b.id);
    expect(d.depth).toBe(2);
    expect(d.can_hire).toEqual([]);
    const s = await hire(ctx, 'sloppy', 'x');
    expect(s.can_hire).toEqual([]);
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y' }, s.id);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('may not hire builder: can_hire = []');
    const nope = await ctx.req('POST', '/api/hire', { resume: 'researcher', task: 'y' }, b.id);
    expect(nope.status).toBe(403);
  });

  test('default max_depth 3: you → sub-captain → builder → deckhand', async () => {
    expect(DEFAULT_SETTINGS.max_depth).toBe(3);
    const ctx = await helperSetup();
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const b = await hire(ctx, 'builder', 'build', {}, sc.id);
    const d = await hire(ctx, 'deckhand', 'grep', {}, b.id);
    expect([sc.depth, b.depth, d.depth]).toEqual([1, 2, 3]);
  });

  test('may hire only helpers ⇒ not a captain (worker card rights); may hire a non-helper ⇒ captain', async () => {
    const ctx = await helperSetup();
    const b = await hire(ctx, 'builder', 'build');
    expect(ctx.core.isCaptain(agentOf(ctx, b.id))).toBe(false);
    const card = await ctx.req('POST', '/api/cards', { title: 'x' }, b.id);
    expect(card.status).toBe(403);
    const sc = await hire(ctx, 'sub-captain', 'lead');
    expect(ctx.core.isCaptain(agentOf(ctx, sc.id))).toBe(true);
    expect((await ctx.req('POST', '/api/cards', { title: 'y' }, sc.id)).status).toBe(200);
  });
});

describe('review fixes', () => {
  test('a can_hire slug with no resume grants no captain rights (deleted helper)', async () => {
    const ctx = await helperSetup();
    const b = await hire(ctx, 'builder', 'build');
    ctx.core.resumes.delete('deckhand');
    expect(ctx.core.isCaptain(agentOf(ctx, b.id))).toBe(false);
    expect((await ctx.req('POST', '/api/cards', { title: 'x' }, b.id)).status).toBe(403);
  });

  test('duplicating a hand-edited helper drops its hires', async () => {
    const ctx = await helperSetup();
    const dup = await ctx.req('POST', '/api/resumes/sloppy/duplicate', { slug: 'sloppy-2' });
    expect(dup.status).toBe(201);
    expect([dup.body.helper, dup.body.can_hire]).toEqual([true, []]);
  });
});

describe('one-shot helpers are released on their report', () => {
  test('deckhand: done → result (released) to the parent, agent retired, window closed after grace, no follow-ups', async () => {
    const ctx = await helperSetup();
    const b = await hire(ctx, 'builder', 'build');
    const d = await hire(ctx, 'deckhand', 'count callers', {}, b.id);
    expect(agentOf(ctx, d.id).state).toBe('working');
    const r = await ctx.req('POST', '/api/done', { summary: '## Result\n3 callers' }, d.id, agentOf(ctx, d.id).call_id);
    expect(r.status).toBe(200);
    expect(r.body.message.meta.released).toBe(true);
    expect(agentOf(ctx, d.id).state).toBe('retired');
    expect(agentOf(ctx, d.id).call_id).toBeNull();
    expect(ctx.logs.some((l) => l.includes(`one-shot @${d.handle} released`))).toBe(true);
    // the parent got the result
    const inbox = await ctx.req('GET', '/api/inbox', undefined, b.id);
    expect(inbox.body.inbox.some((m: MessageView) => m.kind === 'result' && m.text.includes('3 callers'))).toBe(true);
    // window closes after the grace period
    expect(ctx.sp.stopsFor(d.id)).toEqual([]);
    await ctx.clock.advance(DEFAULT_SETTINGS.close_grace_ms + 10);
    expect(ctx.sp.stopsFor(d.id).length).toBe(1);
    expect(agentOf(ctx, d.id).tmux_window_id).toBeNull();
    // follow-ups go to a fresh hire
    const again = await ctx.req('POST', '/api/send', { to: `@${d.handle}`, text: 'one more thing' }, b.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('was released');
  });

  test('a released one-shot reporting again (no call header) records nothing', async () => {
    const ctx = await helperSetup();
    const d = await hire(ctx, 'deckhand', 'grep');
    await ctx.req('POST', '/api/done', { summary: 'first' }, d.id, agentOf(ctx, d.id).call_id);
    const again = await ctx.req('POST', '/api/done', { summary: 'second' }, d.id);
    expect(again.status).toBe(200);
    expect(again.body.message).toBeNull();
    const thread = `dm:${[ctx.captain.id, d.id].sort().join(':')}`;
    const msgs = (await ctx.req('GET', `/api/messages?project=${d.project_id}&thread=${encodeURIComponent(thread)}`)).body as MessageView[];
    expect(msgs.filter((m) => m.kind === 'result').map((m) => m.text)).toEqual(['first']);
  });

  test('blocked / failed reports release too', async () => {
    const ctx = await helperSetup();
    const d = await hire(ctx, 'deckhand', 'design the API');
    await ctx.req('POST', '/api/done', { summary: 'NEEDS-JUDGMENT: pick REST or RPC', status: 'blocked' }, d.id, agentOf(ctx, d.id).call_id);
    expect(agentOf(ctx, d.id).state).toBe('retired');
  });

  test('"Not sent" (new messages first) does NOT release; the next report does', async () => {
    const ctx = await helperSetup();
    const d = await hire(ctx, 'deckhand', 'grep');
    await ctx.req('POST', '/api/send', { to: `@${d.handle}`, text: 'also count tests' }, ctx.captain.id);
    const first = await ctx.req('POST', '/api/done', { summary: 'partial' }, d.id, agentOf(ctx, d.id).call_id);
    expect(first.body.message).toBeNull();
    expect(agentOf(ctx, d.id).state).toBe('working');
    const second = await ctx.req('POST', '/api/done', { summary: 'all' }, d.id, agentOf(ctx, d.id).call_id);
    expect(second.body.message.meta.released).toBe(true);
    expect(agentOf(ctx, d.id).state).toBe('retired');
  });

  test('advisor (not one-shot) stays idle and answers follow-ups in the same session', async () => {
    const ctx = await helperSetup();
    const b = await hire(ctx, 'builder', 'build');
    const a = await hire(ctx, 'advisor', 'middleware or per route?', {}, b.id);
    const r = await ctx.req('POST', '/api/done', { summary: 'VERDICT: GO' }, a.id, agentOf(ctx, a.id).call_id);
    expect(r.body.message.meta.released).toBeUndefined();
    expect(agentOf(ctx, a.id).state).toBe('idle');
    const follow = await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'and for websockets?' }, b.id);
    expect(follow.status).toBe(200);
  });

  test('headers say the result came from a released one-shot agent', () => {
    const m = { id: 'm1', seq: 1, project_id: 'p', thread: 't', from_id: 'ag_d', from_handle: 'kai', kind: 'result', text: 'done', to: ['ag_b'],
      mentions: ['ag_b'], card_id: null, meta: { status: 'ok', call_ms: 22_000, released: true }, created_at: Date.now() } as unknown as MessageView;
    expect(messageHeader(m, () => 'kai')).toContain('result from @kai (ok) · released (one-shot)');
    const block = inboxBlock([m], 'james', [{ id: 'ag_d', handle: 'kai', kind: 'agent', resume: 'deckhand' } as any]);
    expect(block).toContain('── @kai · deckhand · done ok · call 22s · released (one-shot) ──');
  });
});

describe('resume API keeps the flags', () => {
  test('PUT without the flags keeps them; helper + can_hire → 400; duplicate copies them', async () => {
    const ctx = await helperSetup();
    const cur = (await ctx.req('GET', '/api/resumes/deckhand')).body;
    const { slug: _s, hash: _h, builtin: _b, status: _st, status_detail: _sd, resolved_model: _r, stale_agents: _sa, path: _p, provider: _pv, provider_health: _ph, helper: _he, one_shot: _o, ...rest } = cur;
    const put = await ctx.req('PUT', '/api/resumes/deckhand', { ...rest, title: 'Deckhand 2' });
    expect(put.status).toBe(200);
    expect([put.body.title, put.body.helper, put.body.one_shot]).toEqual(['Deckhand 2', true, true]);
    const bad = await ctx.req('PUT', '/api/resumes/deckhand', { ...rest, can_hire: ['builder'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('can_hire must be empty for a helper');
    const off = await ctx.req('PUT', '/api/resumes/deckhand', { ...rest, one_shot: false });
    expect(off.body.one_shot).toBeUndefined();
    const dup = await ctx.req('POST', '/api/resumes/advisor/duplicate', { slug: 'advisor-2' });
    expect(dup.body.helper).toBe(true);
  });
});

describe('settings API', () => {
  test('GET: every field with default, live value, saved flag and the file', async () => {
    const ctx = await helperSetup({ max_running: 4 });
    const r = await ctx.req('GET', '/api/settings');
    expect(r.status).toBe(200);
    const f = (k: string) => r.body.fields.find((x: any) => x.key === k);
    expect(f('max_running')).toMatchObject({ value: 4, default: 3, saved: false, env_override: false, min: 1, unit: 'agents', group: 'Capacity' });
    expect(f('max_depth')).toMatchObject({ value: 3, default: 3 });
    expect(r.body.fields.length).toBe(13);
    expect(r.body.file.endsWith('config.json')).toBe(true);
  });

  test('PUT writes config.json (keeping other keys), applies live, and null resets', async () => {
    const ctx = await helperSetup();
    const file = (await ctx.req('GET', '/api/settings')).body.file;
    writeFileSync(file, JSON.stringify({ skills_dir: '/x/Skills', custom: 1 }));
    const r = await ctx.req('PUT', '/api/settings', { values: { max_running: 6, max_depth: 4, quiet_minutes: 7 } });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ skills_dir: '/x/Skills', custom: 1, max_running: 6, max_depth: 4, quiet_minutes: 7 });
    expect(r.body.fields.find((x: any) => x.key === 'max_running')).toMatchObject({ value: 6, saved: true });
    expect(ctx.core.settings.max_running).toBe(6);
    // live: max_depth 4 now allows what 3 refused? (depth check reads the shared object)
    expect(ctx.core.settings.max_depth).toBe(4);
    // resume defaults follow quiet_minutes live
    expect(ctx.core.resumes.get('fake')!.limits.quiet_minutes).toBe(1); // own limit wins
    expect(ctx.core.resumes.get('builder')!.limits.quiet_minutes).toBe(7);
    const reset = await ctx.req('PUT', '/api/settings', { values: { max_running: null } });
    expect(reset.body.fields.find((x: any) => x.key === 'max_running')).toMatchObject({ value: 3, saved: false });
    expect(JSON.parse(readFileSync(file, 'utf8')).max_running).toBeUndefined();
  });

  test('PUT validates everything first: one bad value → nothing written or applied', async () => {
    const ctx = await helperSetup();
    const file = (await ctx.req('GET', '/api/settings')).body.file;
    for (const [values, msg] of [
      [{ max_running: 2, max_depth: 0 }, 'max_depth: must be between 1 and 10 levels'],
      [{ max_running: 2.5 }, 'max_running: must be a whole number'],
      [{ max_running: '5' }, 'max_running: must be a whole number'],
      [{ wizard: 1 }, 'wizard: unknown setting'],
    ] as const) {
      const r = await ctx.req('PUT', '/api/settings', { values });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(msg);
    }
    expect(existsSync(file)).toBe(false);
    expect(ctx.core.settings.max_running).toBe(10);
  });

  test('agents may not change settings', async () => {
    const ctx = await helperSetup();
    const b = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('PUT', '/api/settings', { values: { max_depth: 9 } }, b.id);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('only the user can');
    expect(ctx.core.settings.max_depth).toBe(3);
  });

  test('raising max_running starts queued agents at once', async () => {
    const ctx = await helperSetup({ max_running: 1 });
    const a = await hire(ctx, 'builder', 'one');
    const b = await hire(ctx, 'builder', 'two');
    expect([agentOf(ctx, a.id).state, agentOf(ctx, b.id).state]).toEqual(['working', 'queued']);
    await ctx.req('PUT', '/api/settings', { values: { max_running: 2 } });
    for (let i = 0; i < 20 && agentOf(ctx, b.id).state !== 'working'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(agentOf(ctx, b.id).state).toBe('working');
  });

  test('doctor_models: set one, clear one', async () => {
    const ctx = await helperSetup();
    let r = await ctx.req('PUT', '/api/settings', { doctor_models: { claude: 'haiku', codex: 'gpt-6-luna' } });
    expect(r.body.doctor_models).toEqual({ claude: 'haiku', codex: 'gpt-6-luna' });
    r = await ctx.req('PUT', '/api/settings', { doctor_models: { codex: null } });
    expect(r.body.doctor_models).toEqual({ claude: 'haiku' });
    expect(ctx.core.settings.doctor_models).toEqual({ claude: 'haiku' });
    const bad = await ctx.req('PUT', '/api/settings', { doctor_models: { gemini: 'x' } });
    expect(bad.status).toBe(400);
  });

  test('SPARROW_SETTINGS keys are read-only and listeners hear only real changes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sp-cfg-')), 'config.json');
    const s = { ...DEFAULT_SETTINGS, max_running: 2 };
    const svc = new SettingsService(s, file, JSON.stringify({ max_running: 2 }));
    expect(svc.view().fields.find((f) => f.key === 'max_running')!.env_override).toBe(true);
    expect(() => svc.update({ values: { max_running: 5 } })).toThrow('SPARROW_SETTINGS');
    const heard: string[][] = [];
    svc.onChange((c) => heard.push(c.map(String)));
    svc.update({ values: { watchdog_ms: DEFAULT_SETTINGS.watchdog_ms } });
    svc.update({ values: { watchdog_ms: 1000, snapshot_ms: 2000 } });
    expect(heard).toEqual([['watchdog_ms', 'snapshot_ms']]);
  });
});
