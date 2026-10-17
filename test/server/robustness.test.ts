// V1 fixes: tmux window id reuse / ownership, input validation, crash-restart slot re-check, health.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../../src/shared/config';
import { Core } from '../../src/server/core';
import { EventBus } from '../../src/server/events';
import { Resumes } from '../../src/server/resumes';
import { agentOf, FakeClock, FakeSpawner, hire, makeResumesDir, setup } from './helpers';

describe('tmux window ids are never trusted after the window died (V1 #1)', () => {
  test('exit 0: window id forgotten at once; a reused id owned by another agent is never closed', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x', { name: 'ea' });
    expect(agentOf(ctx, a.id).tmux_window_id).toBe('@1');
    await ctx.req('POST', '/api/hooks/exit', { code: 0 }, a.id, agentOf(ctx, a.id).call_id);
    expect(agentOf(ctx, a.id).last_end_reason).toBe('unreported');
    expect(agentOf(ctx, a.id).tmux_window_id).toBeNull();
    ctx.sp.alive.set('@1', false); // the window closed itself; tmux server exits
    ctx.sp.reuse.push('@1');       // next tmux server hands out @1 again
    const b = await hire(ctx, 'fake', 'y', { name: 'eb' });
    expect(agentOf(ctx, b.id).tmux_window_id).toBe('@1');
    await ctx.clock.advance(20_000);
    expect(ctx.sp.stops).toEqual([]);
    expect(ctx.sp.refused).toEqual([]);
    expect(agentOf(ctx, b.id).state).toBe('working');
    expect(await ctx.sp.isAlive(agentOf(ctx, b.id))).toBe(true);
  });

  test('crash with restarts used up: window id forgotten at once, no close scheduled', async () => {
    const ctx = await setup({ max_restarts: 0 });
    const a = await hire(ctx, 'fake', 'x');
    await ctx.req('POST', '/api/hooks/exit', { code: 5 }, a.id, agentOf(ctx, a.id).call_id);
    const ag = agentOf(ctx, a.id);
    expect(ag.state).toBe('crashed');
    expect(ag.tmux_window_id).toBeNull();
    await ctx.clock.advance(20_000);
    expect(ctx.sp.stops).toEqual([]);
  });

  test('watchdog crash → restart does not stop the dead window by id', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x');
    ctx.sp.alive.set('@1', false);
    ctx.sp.owner.set('@1', 'ag_SOMEONE_ELSE'); // id already reused
    await ctx.core.watchdogTick();
    await ctx.core.watchdogTick();
    expect(ctx.sp.starts.length).toBe(2);
    expect(ctx.sp.stops).toEqual([]);
    expect(ctx.sp.refused).toEqual([]);
    expect(agentOf(ctx, a.id).tmux_window_id).toBe('@2');
  });

  test('grace close of a window whose id now belongs to someone else: no stop, id forgotten', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    ctx.sp.owner.set('@1', 'ag_OTHER'); // T2 ownership tag says: not ours
    await ctx.clock.advance(8000);
    expect(ctx.sp.stops).toEqual([]);
    expect(ctx.sp.refused).toEqual([]);
    expect(agentOf(ctx, a.id).tmux_window_id).toBeNull();
  });

  test('exit hook after done forgets the window id and cancels the grace close', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x');
    const call = agentOf(ctx, a.id).call_id;
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, call);
    await ctx.req('POST', '/api/hooks/exit', { code: 0 }, a.id, call);
    expect(agentOf(ctx, a.id).tmux_window_id).toBeNull();
    expect(agentOf(ctx, a.id).state).toBe('idle');
    await ctx.clock.advance(20_000);
    expect(ctx.sp.stops).toEqual([]);
  });

  test('boot recovery: an id that is "not ours" counts as dead and is never stopped', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x');
    const sp2 = new FakeSpawner();
    sp2.alive.set('@1', true);
    sp2.owner.set('@1', 'ag_SOMEBODY'); // the user's own window got id @1 after a reboot
    const core2 = new Core({
      store: ctx.store, spawner: sp2, settings: DEFAULT_SETTINGS, resumes: new Resumes([makeResumesDir()], DEFAULT_SETTINGS),
      events: new EventBus(), clock: new FakeClock(), tmuxPrefix: 'sptest-', protocolPath: '/nonexistent',
    });
    await core2.recover();
    const ag = ctx.store.getAgent(a.id)!;
    expect(ag.state).toBe('crashed');
    expect(ag.last_end_reason).toBe('server_restart');
    expect(ag.tmux_window_id).toBeNull();
    expect(sp2.stops).toEqual([]);
    expect(sp2.refused).toEqual([]);
    expect(sp2.delivers).toEqual([]);
  });
});

describe('crash restart re-checks max_running (V1 #5)', () => {
  test('no free slot → queued with the restart envelope pending; starts when a slot frees', async () => {
    const ctx = await setup({ max_running: 1 });
    const a = await hire(ctx, 'builder-codex', 'first task'); // codex: no session id yet → discoverSession awaits
    let bId = '';
    ctx.sp.discovered = 'rollout-a';
    ctx.sp.onDiscover = async () => {
      ctx.sp.onDiscover = null;
      bId = (await hire(ctx, 'fake', 'sneaks in')).id; // takes the freed slot during the await
    };
    await ctx.req('POST', '/api/hooks/exit', { code: 3 }, a.id, agentOf(ctx, a.id).call_id);
    expect(agentOf(ctx, bId).state).toBe('working');
    expect(agentOf(ctx, a.id).state).toBe('queued');
    expect(ctx.store.countWorking()).toBe(1);
    expect(ctx.store.countPending(a.id)).toBe(1);
    expect(ctx.store.countWaking(ctx.captain.id)).toBe(0); // FYI "restart queued" notice is quiet (A5)
    expect(ctx.store.pendingFor(ctx.captain.id).map((m) => m.text)).toEqual([expect.stringContaining('restart queued')]);
    await ctx.req('POST', '/api/done', { summary: 'b done' }, bId, agentOf(ctx, bId).call_id);
    const ag = agentOf(ctx, a.id);
    expect(ag.state).toBe('working');
    const s = ctx.sp.starts.at(-1)!;
    expect(s.agent.id).toBe(a.id);
    expect(s.resume).toBe(true);
    expect(s.agent.session_id).toBe('rollout-a');
    expect(s.prompt).toContain('ended unexpectedly (exit 3)');
    expect(ctx.store.callsFor(a.id)[0].restarts).toBe(1); // the chain counter survives the queue
  });
});

describe('input validation (V1 #2, #3, #4, #6)', () => {
  test('tmux_session / tmux_window must match [A-Za-z0-9_-]{1,40}', async () => {
    const ctx = await setup();
    for (const bad of [{ tmux_session: 'my.sess:x' }, { tmux_window: 'a b' }, { tmux_window: 'x'.repeat(41) }, { tmux_session: 'a:b' }]) {
      const r = await ctx.req('POST', '/api/hire', { resume: 'fake', task: 't', ...bad }, ctx.captain.id);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('Invalid tmux_');
    }
    const ok = await ctx.req('POST', '/api/hire', { resume: 'fake', task: 't', tmux_session: 'My_Sess-1', tmux_window: 'w-1' }, ctx.captain.id);
    expect(ok.status).toBe(200);
    expect(ctx.sp.starts.length).toBe(1);
  });

  test('non-string fields → 400, never 500', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x');
    const cases: [string, string, unknown, string][] = [
      ['POST', '/api/hire', { resume: 'fake', task: 123 }, ctx.captain.id],
      ['POST', '/api/hire', { resume: 7, task: 'x' }, ctx.captain.id],
      ['POST', '/api/hire', { resume: 'fake', task: 'x', cwd: 5 }, ctx.captain.id],
      ['POST', '/api/hire', { resume: 'fake', task: 'x', model: ['m'] }, ctx.captain.id],
      ['POST', '/api/send', { to: '@x', text: 123 }, ctx.captain.id],
      ['POST', '/api/send', { to: 5, text: 'x' }, ctx.captain.id],
      ['POST', '/api/update', { text: { a: 1 } }, a.id],
      ['POST', '/api/done', { summary: 1 }, a.id],
      ['POST', '/api/ask', { question: true }, a.id],
      ['POST', '/api/propose', { title: 3 }, a.id],
      ['POST', '/api/propose', { title: 't', details: 4 }, a.id],
      ['POST', '/api/cards', { title: [] }, ctx.captain.id],
      ['POST', '/api/release', { agent: 9 }, ctx.captain.id],
      ['POST', '/api/hooks/session', { session_id: 1 }, a.id],
      ['POST', '/api/hooks/exit', { code: 'boom' }, a.id],
    ];
    for (const [m, p, b, as] of cases) {
      const r = await ctx.req(m, p, b, as);
      if (r.status !== 400) throw new Error(`${p} ${JSON.stringify(b)} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    const c = (await ctx.req('POST', '/api/cards', { title: 'c' }, ctx.captain.id)).body.card;
    for (const b of [{ title: 1 }, { details: 2 }, { note: 3 }, { assignee: 4 }, { position: 'x' }]) {
      const r = await ctx.req('PATCH', `/api/cards/${c.id}`, b, ctx.captain.id);
      expect(r.status).toBe(400);
    }
    expect(agentOf(ctx, a.id).state).toBe('working');
  });

  test('body null / array / scalar is treated as {} → 400 with field message, not 500; exit hook without code does not crash the agent', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x');
    const call = agentOf(ctx, a.id).call_id;
    for (const raw of ['null', '[]', '42', '"s"']) {
      for (const [path, as] of [['/api/hooks/exit', a.id], ['/api/release', ctx.captain.id], ['/api/hooks/session', a.id], ['/api/send', ctx.captain.id]] as const) {
        const res = await ctx.app.request(path, { method: 'POST', headers: { 'x-sparrow-agent': as, 'x-sparrow-call': call! }, body: raw });
        expect(res.status).toBe(400);
      }
    }
    const te = await ctx.app.request('/api/hooks/turn-end', { method: 'POST', headers: { 'x-sparrow-agent': a.id, 'x-sparrow-call': call! }, body: 'null' });
    expect(te.status).toBe(200);
    expect(agentOf(ctx, a.id).state).toBe('working');
    expect(ctx.sp.starts.length).toBe(1);
  });

  test('GET /api/health ignores an unknown x-sparrow-agent header', async () => {
    const ctx = await setup();
    const r = await ctx.req('GET', '/api/health', undefined, 'ag_UNKNOWN');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.inbox).toBeUndefined();
  });
});
