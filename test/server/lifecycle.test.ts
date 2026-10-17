import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../../src/shared/config';
import { Core } from '../../src/server/core';
import { EventBus } from '../../src/server/events';
import { NUDGE_REPORT } from '../../src/server/prompts';
import { Resumes } from '../../src/server/resumes';
import { agentOf, FakeClock, FakeSpawner, hire, makeResumesDir, setup } from './helpers';

const turnEnd = (ctx: any, a: any, body: any = {}) =>
  ctx.req('POST', '/api/hooks/turn-end', { harness: a.harness, ...body }, a.id, agentOf(ctx, a.id).call_id ?? 'call_old');

describe('turn-end (§3.7)', () => {
  test('claude: ended → allow', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const call = agentOf(ctx, a.id).call_id;
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, call);
    const r = await ctx.req('POST', '/api/hooks/turn-end', { harness: 'claude' }, a.id, call);
    expect(r.body).toEqual({ action: 'allow' });
  });

  test('claude: pending → block with envelope (marked delivered); hooks never piggyback', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'also add tests' }, ctx.captain.id);
    const r = await turnEnd(ctx, a);
    expect(r.body.action).toBe('block');
    expect(r.body.reason).toContain('also add tests');
    expect(r.body.reason).toContain('[sparrow] 1 new message');
    expect(r.body.inbox).toBeUndefined();
    expect(ctx.store.countPending(a.id)).toBe(0);
  });

  test('claude: no pending → block NUDGE until max_nudges, then allow + unreported + system message with last_message', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const r1 = await turnEnd(ctx, a, { session_id: 'sess-1' });
    expect(r1.body).toEqual({ action: 'block', reason: NUDGE_REPORT });
    const r2 = await turnEnd(ctx, a, { stop_hook_active: true });
    expect(r2.body).toEqual({ action: 'block', reason: NUDGE_REPORT });
    expect(ctx.store.callsFor(a.id)[0].nudges).toBe(2);
    const r3 = await turnEnd(ctx, a, { last_message: 'I think I am finished.' });
    expect(r3.body).toEqual({ action: 'allow' });
    const ag = agentOf(ctx, a.id);
    expect(ag.state).toBe('idle');
    expect(ag.last_end_reason).toBe('unreported');
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox.length).toBe(1);
    expect(inbox[0].kind).toBe('system');
    expect(inbox[0].text).toContain(`@${a.handle} stopped without reporting. Its last message: «I think I am finished.»`);
    expect(inbox[0].thread).toBe(ctx.store.listMessages({ thread: inbox[0].thread, limit: 1 })[0].thread);
    expect(inbox[0].thread_label).toBe(`dm @captain ↔ @${a.handle}`);
    await ctx.clock.advance(8000);
    expect(ctx.sp.stopsFor(a.id).length).toBe(1);
  });

  for (const slug of ['builder-codex', 'researcher', 'fake']) {
    test(`${slug}: action none + spawner.deliver(envelope / NUDGE) ~1 s later`, async () => {
      const ctx = await setup();
      const a = await hire(ctx, slug, 'x');
      await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'news' }, ctx.captain.id);
      const r = await turnEnd(ctx, a);
      expect(r.body).toEqual({ action: 'none' });
      expect(ctx.sp.delivers.length).toBe(0);
      await ctx.clock.advance(1000);
      expect(ctx.sp.delivers.length).toBe(1);
      expect(ctx.sp.delivers[0].text).toContain('news');
      const r2 = await turnEnd(ctx, a);
      expect(r2.body).toEqual({ action: 'none' });
      await ctx.clock.advance(1000);
      expect(ctx.sp.delivers[1].text).toBe(NUDGE_REPORT);
      await turnEnd(ctx, a);
      await ctx.clock.advance(1000);
      expect(ctx.sp.delivers[2].text).toBe(NUDGE_REPORT);
      const r4 = await turnEnd(ctx, a, { last_message: 'bye' });
      expect(r4.body.action).toBe('allow');
      expect(agentOf(ctx, a.id).last_end_reason).toBe('unreported');
    });
  }

  test('session id from turn-end is stored (codex learns its thread id late)', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder-codex', 'x');
    await turnEnd(ctx, a, { session_id: 'thread-abc' });
    expect(agentOf(ctx, a.id).session_id).toBe('thread-abc');
    const s = await ctx.req('POST', '/api/hooks/session', { session_id: 'thread-xyz' }, a.id, agentOf(ctx, a.id).call_id);
    expect(s.body).toEqual({ ok: true });
    expect(agentOf(ctx, a.id).session_id).toBe('thread-xyz'); // not a resumed call → updated
  });

  test('resumed call keeps its session id even if a hook reports another', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'more' }, ctx.captain.id);
    await turnEnd(ctx, a, { session_id: 'other' });
    expect(agentOf(ctx, a.id).session_id).toBe('sess-1');
  });
});

describe('exit / crash (§3.8)', () => {
  test('exit 0 without done → unreported (no restart), system message uses the screen tail', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    ctx.sp.screens.set(a.id, 'line1\nlast words on screen');
    const r = await ctx.req('POST', '/api/hooks/exit', { code: 0 }, a.id, agentOf(ctx, a.id).call_id);
    expect(r.body).toEqual({ ok: true });
    expect(agentOf(ctx, a.id).last_end_reason).toBe('unreported');
    expect(ctx.sp.starts.length).toBe(1);
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox[0].text).toContain('last words on screen');
  });

  test('non-zero → restart once with resume:true + CRASH_RESUME; second crash → crashed + snapshot tail', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/update', { text: 'half way' }, a.id);
    await ctx.clock.advance(60_000); // older than fresh_fallback_ms (first call was not a resume anyway)
    const c1 = agentOf(ctx, a.id).call_id;
    await ctx.req('POST', '/api/hooks/exit', { code: 137 }, a.id, c1);
    expect(ctx.sp.starts.length).toBe(2);
    const s2 = ctx.sp.starts[1];
    expect(s2.resume).toBe(true);
    expect(s2.prompt).toContain('[sparrow] Your previous session ended unexpectedly (exit 137)');
    expect(s2.prompt).toContain('«half way»');
    const calls = ctx.store.callsFor(a.id);
    expect(calls[0].restarts).toBe(1);
    expect(calls[1]).toMatchObject({ end_reason: 'crashed', exit_code: 137 });
    expect(agentOf(ctx, a.id).state).toBe('working');
    const fyi = ctx.store.listMessages({ project: a.project_id, limit: 100 }).filter((m) => m.kind === 'system');
    expect(fyi.map((m) => m.text)).toEqual([`@${a.handle} crashed (exit 137); restarting on the same session.`]);
    expect(fyi[0].mentions).toEqual([]);
    expect(fyi[0].thread).toBe(`dm:${[ctx.captain.id, a.id].sort().join(':')}`);
    // A5: FYI = quiet delivery to the parent (wakes nobody); any inbox read hands it over with the quiet update.
    expect(ctx.store.deliveriesFor(fyi[0].id)).toMatchObject([{ to_id: ctx.captain.id, state: 'pending', wake: false }]);
    expect(ctx.store.countWaking(ctx.captain.id)).toBe(0);
    let inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox.map((m: any) => [m.kind, m.text])).toEqual([['update', 'half way'], ['system', fyi[0].text]]);
    // second crash, long after start so not the fresh fallback
    await ctx.clock.advance(60_000);
    ctx.sp.screens.set(a.id, Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n'));
    await ctx.req('POST', '/api/hooks/exit', { code: 1 }, a.id, agentOf(ctx, a.id).call_id);
    expect(ctx.sp.starts.length).toBe(2);
    const ag = agentOf(ctx, a.id);
    expect(ag.state).toBe('crashed');
    inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox[0].text).toContain('crashed (exit 1)');
    expect(inbox[0].text).toContain('row 29');
    expect(inbox[0].text).toContain('row 10');
    expect(inbox[0].text).not.toContain('row 9\n');
    expect(inbox[0].meta.exit_code).toBe(1);
    // restarts reset: a message resumes it with a fresh chain
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'resume please' }, ctx.captain.id);
    expect(agentOf(ctx, a.id).state).toBe('working');
    expect(ctx.store.callsFor(a.id)[0].restarts).toBe(0);
  });

  test('resumed call dying within fresh_fallback_ms → restart FRESH with replay, session cleared', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'Build the parser');
    await ctx.req('POST', '/api/update', { text: 'parser 50%' }, a.id);
    await ctx.req('POST', '/api/done', { summary: 'first part ok' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'now the lexer' }, ctx.captain.id);
    expect(ctx.sp.starts[1].resume).toBe(true);
    await ctx.clock.advance(5000);
    await ctx.req('POST', '/api/hooks/exit', { code: 1 }, a.id, agentOf(ctx, a.id).call_id);
    const s3 = ctx.sp.starts[2];
    expect(s3.resume).toBe(false);
    expect(s3.agent.session_id).toBeNull();
    expect(s3.prompt).toContain('FRESH session');
    expect(s3.prompt).toContain('Build the parser');
    expect(s3.prompt).toContain('now the lexer');
    expect(s3.prompt).toContain('first part ok');
    expect(s3.prompt).toContain('«parser 50%»');
    expect(agentOf(ctx, a.id).session_id).toBe('sess-3'); // the new session from the spawner
  });

  test('crash in the first turn with no known session → discoverSession, else fresh', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder-codex', 'x');
    ctx.sp.discovered = 'rollout-123';
    await ctx.req('POST', '/api/hooks/exit', { code: 2 }, a.id, agentOf(ctx, a.id).call_id);
    expect(ctx.sp.starts[1].resume).toBe(true);
    expect(ctx.sp.starts[1].agent.session_id).toBe('rollout-123');
  });

  test('stale call id → ignored', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('POST', '/api/hooks/exit', { code: 1 }, a.id, 'call_STALE');
    expect(r.body).toEqual({ ok: true });
    expect(agentOf(ctx, a.id).state).toBe('working');
    expect(ctx.sp.starts.length).toBe(1);
  });

  test('exit after done (window closing on purpose) → ignored', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const call = agentOf(ctx, a.id).call_id;
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, call);
    await ctx.req('POST', '/api/hooks/exit', { code: 143 }, a.id, call);
    expect(agentOf(ctx, a.id).state).toBe('idle');
    expect(ctx.sp.starts.length).toBe(1);
  });
});

describe('watchdog, quiet, boot recovery (§3.5, §3.9)', () => {
  test('isAlive false twice → crash path with code -1 (restart)', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    ctx.sp.alive.set('@1', false);
    await ctx.core.watchdogTick();
    expect(agentOf(ctx, a.id).state).toBe('working');
    expect(ctx.sp.starts.length).toBe(1);
    await ctx.core.watchdogTick();
    expect(ctx.sp.starts.length).toBe(2);
    expect(ctx.store.callsFor(a.id)[1]).toMatchObject({ end_reason: 'crashed', exit_code: -1 });
    expect(ctx.sp.starts[1].prompt).toContain('exit -1');
  });

  test('dead then alive resets the counter', async () => {
    const ctx = await setup();
    await hire(ctx, 'builder', 'x');
    ctx.sp.alive.set('@1', false);
    await ctx.core.watchdogTick();
    ctx.sp.alive.set('@1', true);
    await ctx.core.watchdogTick();
    ctx.sp.alive.set('@1', false);
    await ctx.core.watchdogTick();
    expect(ctx.sp.starts.length).toBe(1);
  });

  test('quiet nudge once after quiet_minutes; max_call_minutes → one system message to parent', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x'); // fake resume: quiet 1 min, max_call 3 min
    await ctx.clock.advance(59_000);
    await ctx.core.watchdogTick();
    expect(ctx.sp.delivers.length).toBe(0);
    await ctx.clock.advance(1_000);
    await ctx.core.watchdogTick();
    expect(ctx.sp.delivers.length).toBe(1);
    expect(ctx.sp.delivers[0].text).toContain('No progress update for 1 minutes');
    await ctx.clock.advance(30_000);
    await ctx.core.watchdogTick();
    expect(ctx.sp.delivers.length).toBe(1); // still the same quiet stretch → no second nudge
    await ctx.clock.advance(150_000);
    await ctx.core.watchdogTick();
    await ctx.core.watchdogTick();
    expect(ctx.sp.delivers.length).toBe(1);
    expect(ctx.store.countWaking(ctx.captain.id)).toBe(1); // max_call notice wakes; the quiet-nudge note is FYI (quiet)
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox.length).toBe(2); // handed over together, in seq order
    expect(inbox[0].text).toBe(`@${a.handle} posted nothing for 1 min; nudged it to post a progress update.`);
    expect(inbox[1].text).toContain(`@${a.handle} has been working 4 min`);
    const notes = ctx.store.listMessages({ project: a.project_id, limit: 100 }).filter((m) => m.kind === 'system');
    expect(notes.map((m) => m.text)).toEqual([
      `@${a.handle} posted nothing for 1 min; nudged it to post a progress update.`,
      expect.stringContaining('has been working 4 min'),
    ]);
    expect(notes[0].mentions).toEqual([]);
    expect(agentOf(ctx, a.id).state).toBe('working'); // never auto-killed
  });

  test('boot recovery: alive window re-adopted; dead → server_restart, crashed, parent notified; queued re-evaluated', async () => {
    const ctx = await setup({ max_running: 2 });
    const a = await hire(ctx, 'builder', 'x');
    const b = await hire(ctx, 'builder', 'y');
    // simulate a restart: a new Core over the same store with a spawner where only a's window lives
    const sp2 = new FakeSpawner();
    sp2.alive.set('@1', true);
    // and one queued agent left over
    const queuedId = (await hire(ctx, 'builder', 'z')).id; // queued (max 2)
    expect(agentOf(ctx, queuedId).state).toBe('queued');
    const core2 = new Core({
      store: ctx.store, spawner: sp2, settings: { ...DEFAULT_SETTINGS, max_running: 2 },
      resumes: new Resumes([makeResumesDir()], DEFAULT_SETTINGS), events: new EventBus(), clock: new FakeClock(),
      tmuxPrefix: 'sptest-', protocolPath: '/nonexistent',
    });
    await core2.recover();
    expect(ctx.store.getAgent(a.id)!.state).toBe('working');
    const bb = ctx.store.getAgent(b.id)!;
    expect(bb.state).toBe('crashed');
    expect(bb.last_end_reason).toBe('server_restart');
    expect(ctx.store.getAgent(queuedId)!.state).toBe('working');
    expect(sp2.starts.map((s) => s.agent.id)).toEqual([queuedId]);
    const pend = ctx.store.pendingFor(ctx.captain.id);
    expect(pend.at(-1)!.text).toContain('interrupted by a server restart');
  });
});

describe('FYI vs action-needed notices', () => {
  test('a waiting sub-captain is NOT woken by a child crash-restart or quiet nudge, but IS woken by unreported', async () => {
    const ctx = await setup();
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const scCall = agentOf(ctx, sc.id).call_id;
    const b = (await ctx.req('POST', '/api/hire', { resume: 'fake', task: 't' }, sc.id, scCall)).body.agent;
    await ctx.req('POST', '/api/wait', { reason: 'child' }, sc.id, scCall);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
    const starts = ctx.sp.starts.length;
    await ctx.clock.advance(60_000);
    await ctx.req('POST', '/api/hooks/exit', { code: 9 }, b.id, agentOf(ctx, b.id).call_id); // crash → restart (FYI)
    expect(ctx.sp.starts.length).toBe(starts + 1);
    expect(ctx.sp.starts.at(-1)!.agent.id).toBe(b.id);
    await ctx.clock.advance(60_000);
    await ctx.core.watchdogTick(); // quiet nudge (FYI)
    expect(ctx.sp.delivers.length).toBe(1);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
    expect(ctx.store.countWaking(sc.id)).toBe(0);
    expect(ctx.store.countPending(sc.id)).toBe(2); // both FYI notices wait, quietly
    // unreported is action-needed → delivered → sub-captain wakes
    const bb = agentOf(ctx, b.id);
    for (let i = 0; i < 3; i++) await ctx.req('POST', '/api/hooks/turn-end', { harness: 'fake' }, b.id, bb.call_id);
    expect(agentOf(ctx, b.id).last_end_reason).toBe('unreported');
    expect(agentOf(ctx, sc.id).state).toBe('working');
    expect(ctx.sp.starts.at(-1)!.agent.id).toBe(sc.id);
    const prompt = ctx.sp.starts.at(-1)!.prompt;
    expect(prompt).toContain('stopped without reporting');
    // The quiet FYI notices ride along with the waking one, in seq order.
    expect(prompt).toContain('[sparrow] 3 new messages');
    expect(prompt.indexOf(`@${b.handle} crashed (exit 9); restarting`)).toBeGreaterThan(-1);
    expect(prompt.indexOf('posted nothing for 1 min')).toBeGreaterThan(prompt.indexOf(`@${b.handle} crashed (exit 9); restarting`));
    expect(prompt.indexOf('stopped without reporting')).toBeGreaterThan(prompt.indexOf('posted nothing for 1 min'));
  });
});

describe('release (§3.10)', () => {
  test('only parent or human captain; stops window; drops pending; retired', async () => {
    const ctx = await setup();
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const b = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 't' }, sc.id)).body.agent;
    const other = await hire(ctx, 'builder', 'x');
    const denied = await ctx.req('POST', '/api/release', { agent: `@${b.handle}` }, other.id);
    expect(denied.status).toBe(403);
    await ctx.req('POST', '/api/send', { to: `@${b.handle}`, text: 'pending one' }, ctx.captain.id);
    expect(ctx.store.countPending(b.id)).toBe(1);
    const r = await ctx.req('POST', '/api/release', { agent: `@${b.handle}` }, sc.id);
    expect(r.status).toBe(200);
    expect(r.body.agent.state).toBe('retired');
    expect(r.body.agent.tmux_window_id).toBeNull();
    expect(ctx.sp.stopsFor(b.id).length).toBe(1);
    expect(ctx.store.countPending(b.id)).toBe(0);
    expect(ctx.store.callsFor(b.id)[0].end_reason).toBe('released');
    const r2 = await ctx.req('POST', '/api/release', { agent: other.id }, ctx.captain.id);
    expect(r2.body.agent.state).toBe('retired');
  });

  test('release frees a slot for a queued agent', async () => {
    const ctx = await setup({ max_running: 1 });
    const a = await hire(ctx, 'builder', 'x');
    const b = await hire(ctx, 'builder', 'y');
    expect(b.state).toBe('queued');
    await ctx.req('POST', '/api/release', { agent: `@${a.handle}` }, ctx.captain.id);
    expect(agentOf(ctx, b.id).state).toBe('working');
  });
});

describe('screen', () => {
  test('live capture when working, else last snapshot', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    ctx.sp.screens.set(a.id, 'LIVE TUI');
    const r = await ctx.req('GET', `/api/agents/${a.id}/screen?lines=50`);
    expect(r.body).toMatchObject({ text: 'LIVE TUI', live: true });
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    ctx.sp.screens.set(a.id, 'FINAL');
    await ctx.clock.advance(8000); // close captures a final snapshot
    ctx.sp.screens.set(a.id, 'SHOULD NOT SEE');
    const r2 = await ctx.req('GET', `/api/agents/${a.id}/screen`);
    expect(r2.body).toMatchObject({ text: 'FINAL', live: false });
    const r3 = await ctx.req('GET', `/api/agents/@${a.handle}/screen?project=${a.project_id}`);
    expect(r3.body.text).toBe('FINAL');
  });

  test('snapshotTick stores captures of working agents', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    ctx.sp.screens.set(a.id, 'snap 1');
    await ctx.core.snapshotTick();
    ctx.store.patchAgent(a.id, { state: 'idle' }, 0); // pretend closed
    const r = await ctx.req('GET', `/api/agents/${a.id}/screen`);
    expect(r.body).toMatchObject({ text: 'snap 1', live: false });
  });
});
