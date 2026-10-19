import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/shared/config';
import type { Agent, Message, Project, Resume } from '../../src/shared/types';
import { canHireSentence, crashResume, NUDGE_REPORT, nudgeQuiet, renderEnvelope, renderSystemPrompt } from '../../src/server/prompts';
import { parseResume, Resumes } from '../../src/server/resumes';
import { createApp } from '../../src/server/main';
import { agentOf, FakeSpawner, hire, resume, setup } from './helpers';

describe('SSE events', () => {
  test('emits message.created / agent.updated / card.updated / call.started / call.ended', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/propose', { title: 'idea' }, a.id);
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    const types = new Set(ctx.events.map((e) => e.type));
    for (const t of ['message.created', 'agent.updated', 'card.updated', 'call.started', 'call.ended']) expect(types.has(t as any)).toBe(true);
    const ended = ctx.events.find((e) => e.type === 'call.ended') as any;
    expect(ended.call.end_reason).toBe('done');
    expect(ended.call.quiet_nudged_at).toBeUndefined();
    const created = ctx.events.find((e) => e.type === 'message.created') as any;
    expect(created.message.from_handle).toBe('captain');
  });

  test('GET /api/events streams data lines filtered by project', async () => {
    const ctx = await setup();
    const res = await ctx.app.request(`/api/events?project=${ctx.captain.project_id}`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (pred: (s: string) => boolean) => {
      while (!pred(buf)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await readUntil((s) => s.includes(': connected'));
    // event in another project must not appear
    const other = mkdtempSync(join(tmpdir(), 'sp-other-'));
    await ctx.req('POST', '/api/captains/register', { cwd: other });
    await hire(ctx, 'builder', 'stream me');
    await readUntil((s) => s.includes('call.started'));
    const datas = buf.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    expect(datas.length).toBeGreaterThan(0);
    expect(datas.every((d) => d.project_id === ctx.captain.project_id)).toBe(true);
    await reader.cancel();
  });
});

describe('read endpoints', () => {
  test('health, resumes, projects, agents, agent detail, whoami', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const h = await ctx.req('GET', '/api/health');
    expect(h.body).toMatchObject({ ok: true, version: '0.1.0', pid: process.pid });
    const rs = await ctx.req('GET', '/api/resumes');
    expect(rs.body.find((r: any) => r.slug === 'builder')).toMatchObject({ harness: 'claude', model: 'haiku', body: 'You are the builder.\n' });
    const ps = await ctx.req('GET', '/api/projects');
    expect(ps.body[0]).toMatchObject({ id: ctx.captain.project_id, agents: 1, working: 1, cards: 0 });
    const ag = await ctx.req('GET', `/api/agents?project=${ctx.captain.project_id}`);
    expect(ag.body.map((x: any) => x.handle)).toEqual([a.handle, 'captain']);
    const d = await ctx.req('GET', `/api/agents/${ctx.captain.id}`);
    expect(d.body.children.map((x: any) => x.id)).toEqual([a.id]);
    const d2 = await ctx.req('GET', `/api/agents/${a.id}`);
    expect(d2.body.calls.length).toBe(1);
    const w = await ctx.req('GET', '/api/whoami', undefined, a.id);
    expect(w.body.project.id).toBe(ctx.captain.project_id);
    expect(w.body.parent.id).toBe(ctx.captain.id);
    expect(w.body.inbox).toEqual([]);
    expect(agentOf(ctx, a.id).last_seen_at).toBe(ctx.clock.now());
  });

  test('messages (thread, after, @handle) and threads; old group rows stay in the DB but are hidden', async () => {
    const ctx = await setup({ max_running: 10 });
    const pid = ctx.captain.project_id;
    const a = await hire(ctx, 'builder', 'task one');
    const b = await hire(ctx, 'builder', 'task two');
    // rows written by an older server, when group chat existed
    const old = (text: string) => ctx.store.insertMessage({
      id: `msg_old_${text}`, project_id: pid, thread: 'group', from_id: ctx.captain.id, kind: 'chat', text,
      mentions: [a.id], card_id: null, meta: {}, created_at: ctx.clock.now(),
    });
    old('g1');
    await ctx.req('POST', '/api/update', { text: 'u1' }, a.id);
    old('g2');
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'dm1' }, ctx.captain.id);
    expect(ctx.store.countMessages()).toBe(6);
    const all = await ctx.req('GET', `/api/messages?project=${pid}`);
    expect(all.body.map((m: any) => m.text)).toEqual(['task one', 'task two', 'u1', 'dm1']);
    const after = await ctx.req('GET', `/api/messages?project=${pid}&after=${all.body[0].seq}`);
    expect(after.body.map((m: any) => m.text)).toEqual(['task two', 'u1', 'dm1']);
    const group = await ctx.req('GET', `/api/messages?project=${pid}&thread=group`);
    expect(group.status).toBe(200);
    expect(group.body).toEqual([]);
    const dm = await ctx.req('GET', `/api/messages?thread=@${a.handle}`, undefined, ctx.captain.id);
    expect(dm.body.map((m: any) => m.text)).toEqual(['task one', 'u1', 'dm1']);
    const mine = await ctx.req('GET', `/api/messages?thread=@${a.handle}`, undefined, a.id); // own: from or to
    expect(mine.body.map((m: any) => m.text)).toEqual(['task one', 'u1', 'dm1']);
    const lim = await ctx.req('GET', `/api/messages?project=${pid}&limit=2`); // limit counts visible rows only
    expect(lim.body.map((m: any) => m.text)).toEqual(['u1', 'dm1']);
    const th = await ctx.req('GET', `/api/threads?project=${pid}`);
    expect(th.body.map((t: any) => t.thread)).not.toContain('group');
    expect(th.body.map((t: any) => t.label)).toEqual([`@captain ↔ @${a.handle}`, `@captain ↔ @${b.handle}`]);
    expect(th.body[0].count).toBe(3);
    expect(th.body[0].members.sort()).toEqual(['captain', a.handle].sort());
    expect(th.body[0].last.text).toBe('dm1');
    expect(th.body[1].last.text).toBe('task two');
  });

  test('bad JSON → 400; unknown endpoint → 404 JSON; identified-only endpoint without header → 401', async () => {
    const ctx = await setup();
    const res = await ctx.app.request('/api/hire', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sparrow-agent': ctx.captain.id }, body: '{nope' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('JSON');
    const nf = await ctx.req('GET', '/api/bogus');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toContain('No such endpoint');
    const un = await ctx.req('POST', '/api/send', { to: '@captain', text: 'x' });
    expect(un.status).toBe(401);
  });

  test('static: placeholder text when web/dist is missing', async () => {
    const ctx = await setup();
    const res = await ctx.app.request('/board');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sparrow server is running');
  });
});

describe('static web/dist', () => {
  test('serves files and falls back to index.html for SPA routes; /api 404 stays JSON', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'sp-dist-'));
    writeFileSync(join(dist, 'index.html'), '<html>SPARROW UI</html>');
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    const { app } = createApp({ spawner: new FakeSpawner(), settings: DEFAULT_SETTINGS, resumeDirs: [], webDist: dist });
    expect(await (await app.request('/')).text()).toContain('SPARROW UI');
    expect(await (await app.request('/agents/ag_1')).text()).toContain('SPARROW UI');
    expect(await (await app.request('/app.js')).text()).toBe('console.log(1)');
    expect(await (await app.request('/../../etc/passwd')).text()).toContain('SPARROW UI');
    const api404 = await app.request('/api/nope');
    expect(api404.status).toBe(404);
  });
});

describe('prompts + resumes', () => {
  const agent = {
    id: 'ag_1', project_id: 'plutus', handle: 'james', title: 'Builder', harness: 'claude', cwd: '/tmp/x',
    tmux_session: 'sparrow-plutus', tmux_window: 'james', can_hire: [], parent_id: 'ag_0',
  } as unknown as Agent;
  const project: Project = { id: 'plutus', name: 'plutus', root: '/tmp/x', created_at: 0 };
  const res: Resume = parseResume(resume('builder', 'claude', 'model: opus\ncan_hire: []  # none\n'), '/r/builder.md', DEFAULT_SETTINGS);

  test('renderSystemPrompt fills every template var from protocol.md, appends the role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-proto-'));
    const p = join(dir, 'protocol.md');
    writeFileSync(p, '{{handle}}|{{title}}|{{project}}|{{parent}}|{{cwd}}|{{harness}}|{{agent_id}}|{{can_hire}}|{{tmux}}|{{unknown}}');
    const out = renderSystemPrompt(agent, res, { handle: 'captain' } as Agent, project, p);
    expect(out).toBe('james|Builder|plutus|captain|/tmp/x|claude|ag_1|You may NOT hire anyone; never run `sparrow hire`.|sparrow-plutus:james|{{unknown}}\n\n# Your role\n\nYou are the builder.\n');
  });

  test('A2: can_hire sentence', () => {
    expect(canHireSentence([])).toBe('You may NOT hire anyone; never run `sparrow hire`.');
    expect(canHireSentence(['*'])).toBe('You may hire any resume, only via `sparrow hire`. Hire them with their configured model and effort; pass --model/--effort only if your task explicitly asks.');
    expect(canHireSentence(['builder', 'verifier'])).toBe('You may hire these resumes, only via `sparrow hire`: builder, verifier. Hire them with their configured model and effort; pass --model/--effort only if your task explicitly asks.');
  });

  test('renderSystemPrompt falls back to the built-in protocol', () => {
    const out = renderSystemPrompt(agent, res, null, project, '/nonexistent.md');
    expect(out).toContain('You are @james (Builder), an agent in project plutus');
    expect(out).toContain('# Your role');
  });

  test('envelope format', () => {
    const t = new Date('2026-10-13T14:02:00').getTime();
    const m: Message = { seq: 1, id: 'm1', project_id: 'plutus', thread: 'dm:a:b', from_id: 'ag_0', kind: 'task', text: 'Build it', mentions: ['ag_1'], card_id: 3, meta: {}, created_at: t };
    const env = renderEnvelope(agent, [m], () => 'captain');
    expect(env).toBe('[sparrow] 1 new message for @james (project plutus):\n\n── task from @captain · 14:02 · card #3 ──\nBuild it\n\nReport with the sparrow CLI: `sparrow update` as you go, then `sparrow done` (or `sparrow ask` if blocked).\n');
  });

  test('envelope groups by agent: a child\'s updates (timed lines) then its result; notices go under meta.about', () => {
    const t = new Date('2026-10-13T14:02:00').getTime();
    const base = { project_id: 'plutus', thread: 'dm:a:b', mentions: [], card_id: null, meta: {} };
    const ms: Message[] = [
      { ...base, seq: 7, id: 'r', from_id: 'ag_b', kind: 'result', text: '## Result\nok', meta: { status: 'ok', call_ms: 61_000 }, mentions: ['ag_1'], created_at: t + 120_000 },
      { ...base, seq: 2, id: 'u1', from_id: 'ag_b', kind: 'update', text: 'one\ntwo', card_id: 4, created_at: t + 5_000 },
      { ...base, seq: 3, id: 'n', from_id: 'system', kind: 'system', text: '@c crashed (exit 1); restarting', meta: { about: 'ag_c', fyi: true }, created_at: t + 6_000 },
      { ...base, seq: 4, id: 'u2', from_id: 'ag_b', kind: 'update', text: 'three', created_at: t + 61_000 },
      { ...base, seq: 5, id: 'u3', from_id: 'ag_c', kind: 'update', text: 'c back', created_at: t + 62_000 },
    ];
    const handles: Record<string, string> = { ag_b: 'bob', ag_c: 'cat' };
    const env = renderEnvelope({ ...agent, can_hire: ['builder'] }, ms, (id) => handles[id] ?? id);
    expect(env).toBe([
      '[sparrow] 5 new messages for @james (project plutus):',
      '',
      '── updates from @bob ──',
      '14:02:05  one',
      '          two (card #4)',
      '14:03:01  three',
      '',
      '── result from @bob (ok) · 14:04 ──',
      '## Result\nok',
      '',
      '── system notice · 14:02 ──',
      '@c crashed (exit 1); restarting',
      '',
      '── updates from @cat ──',
      '14:03:02  c back',
      '',
      'Report with the sparrow CLI: `sparrow update` as you go, `sparrow wait` while your hires work, then `sparrow done` (or `sparrow ask` if blocked).',
      '',
    ].join('\n'));
  });

  test('notice texts', () => {
    expect(NUDGE_REPORT).toContain('You stopped without reporting');
    expect(nudgeQuiet(15)).toBe('[sparrow] No progress update for 15 minutes. Post one line with `sparrow update "did X; next Y"`, then continue.');
    expect(crashResume(1, 'x')).toBe('[sparrow] Your previous session ended unexpectedly (exit 1). Continue your task from where you left off. Your last update was: «x».');
  });

  test('parseResume: frontmatter, defaults, limits', () => {
    expect(res).toMatchObject({ slug: 'builder', title: 'Builder', harness: 'claude', model: 'opus', effort: null, can_hire: [], limits: { quiet_minutes: 15, max_call_minutes: 90 } });
    const r2 = parseResume('---\nharness: codex\nlimits: { quiet_minutes: 5 }\ncan_hire: [builder, verifier]\n---\nbody', '/x/lead.md', DEFAULT_SETTINGS);
    expect(r2).toMatchObject({ slug: 'lead', title: 'lead', harness: 'codex', can_hire: ['builder', 'verifier'], limits: { quiet_minutes: 5, max_call_minutes: 90 } });
  });

  test('Resumes: user dir wins over assets dir for the same slug', () => {
    const user = mkdtempSync(join(tmpdir(), 'sp-u-'));
    const assets = mkdtempSync(join(tmpdir(), 'sp-a-'));
    writeFileSync(join(user, 'builder.md'), resume('builder', 'codex'));
    writeFileSync(join(assets, 'builder.md'), resume('builder', 'claude'));
    writeFileSync(join(assets, 'verifier.md'), resume('verifier', 'codex'));
    const r = new Resumes([user, assets], DEFAULT_SETTINGS);
    expect(r.list().map((x) => [x.slug, x.harness])).toEqual([['builder', 'codex'], ['verifier', 'codex']]);
    expect(r.get('verifier')!.harness).toBe('codex');
    expect(r.get('nope')).toBeNull();
  });

  test('the real assets/resumes parse (if T3 has written them)', () => {
    const r = new Resumes([join(import.meta.dir, '..', '..', 'assets', 'resumes')], DEFAULT_SETTINGS);
    for (const x of r.list()) {
      expect(['claude', 'codex', 'opencode', 'fake']).toContain(x.harness);
      expect(x.body.length).toBeGreaterThan(10);
    }
  });
});
