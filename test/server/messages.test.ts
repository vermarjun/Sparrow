import { describe, expect, test } from 'bun:test';
import { NUDGE_REPORT } from '../../src/server/prompts';
import { agentOf, hire, setup } from './helpers';

describe('send / update routing', () => {
  test('DM to a working agent: delivery pending (no new start); piggybacked on its next request', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'the API is at /v2' }, ctx.captain.id);
    expect(r.status).toBe(200);
    expect(r.body.message.kind).toBe('chat');
    expect(r.body.message.to_handles).toEqual([a.handle]);
    expect(ctx.sp.starts.length).toBe(1);
    expect(ctx.store.countPending(a.id)).toBe(1);
    const call = agentOf(ctx, a.id).call_id;
    const u = await ctx.req('POST', '/api/update', { text: 'did X; next Y' }, a.id, call);
    expect(u.body.inbox.length).toBe(1);
    expect(u.body.inbox[0].text).toBe('the API is at /v2');
    expect(ctx.store.deliveriesFor(r.body.message.id)[0]).toMatchObject({ state: 'delivered', call_id: call });
    const u2 = await ctx.req('POST', '/api/update', { text: 'again' }, a.id, call);
    expect(u2.body.inbox).toEqual([]);
  });

  test('send to group → 400 (group chat removed); nothing recorded, nobody woken', async () => {
    const ctx = await setup({ max_running: 10 });
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    const before = { starts: ctx.sp.starts.length, msgs: ctx.store.countMessages() };
    for (const to of ['group', '@group', 'GROUP']) {
      const r = await ctx.req('POST', '/api/send', { to, text: `@${a.handle} please check` }, ctx.captain.id);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('Group chat was removed. DM a teammate: sparrow send @<handle> "…"');
    }
    expect(ctx.sp.starts.length).toBe(before.starts);
    expect(ctx.store.countMessages()).toBe(before.msgs);
    expect(agentOf(ctx, a.id).state).toBe('idle');
    // 'group' stays reserved as a handle
    const h = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y', name: 'group' }, ctx.captain.id);
    expect(h.status).toBe(400);
  });

  test('update → DM thread with the parent, QUIET delivery; sets last_update, card note when card_id', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const card = (await ctx.req('POST', '/api/cards', { title: 't', assignee: `@${a.handle}` }, ctx.captain.id)).body.card;
    const r = await ctx.req('POST', '/api/update', { text: `progress @captain`, card_id: card.id }, a.id);
    expect(r.status).toBe(200);
    expect(r.body.message.thread).toBe(`dm:${[ctx.captain.id, a.id].sort().join(':')}`);
    expect(r.body.message.thread_label).toBe(`dm @captain ↔ @${a.handle}`);
    expect(r.body.message.kind).toBe('update');
    expect(r.body.message.mentions).toEqual([]); // quiet recipients are not "woken"
    expect(r.body.message.card_id).toBe(card.id);
    expect(ctx.store.deliveriesFor(r.body.message.id)).toMatchObject([{ to_id: ctx.captain.id, state: 'pending', wake: false }]);
    expect(ctx.store.countPending(ctx.captain.id)).toBe(1);
    expect(ctx.store.countWaking(ctx.captain.id)).toBe(0);
    expect(agentOf(ctx, a.id).last_update).toBe('progress @captain');
    expect(ctx.store.getCard(card.id)!.notes.at(-1)!.text).toBe('progress @captain');
    // The parent gets it on its next inbox read.
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox.map((m: any) => [m.kind, m.text])).toEqual([['update', 'progress @captain']]);
  });

  test('update from the human captain (no parent) → 400 pointing at card notes', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/update', { text: 'hello' }, ctx.captain.id);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('@captain has no parent; updates go to a parent. Use sparrow card note to annotate a card.');
    expect(ctx.store.countMessages()).toBe(0);
  });

  test('an update does not wake an idle or waiting sub-captain', async () => {
    const ctx = await setup({ max_running: 10 });
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const scCall = agentOf(ctx, sc.id).call_id;
    const b = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'build' }, sc.id, scCall)).body.agent;
    const c = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'test' }, sc.id, scCall)).body.agent;
    await ctx.req('POST', '/api/wait', { reason: 'builders' }, sc.id, scCall);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
    const starts = ctx.sp.starts.length;
    await ctx.req('POST', '/api/update', { text: 'schema done' }, b.id, agentOf(ctx, b.id).call_id);
    await ctx.clock.advance(1000);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
    expect(ctx.sp.starts.length).toBe(starts);
    // idle parent: same
    const sc2 = await hire(ctx, 'sub-captain', 'lead 2');
    const d = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'x' }, sc2.id, agentOf(ctx, sc2.id).call_id)).body.agent;
    await ctx.req('POST', '/api/done', { summary: 'handed off' }, sc2.id, agentOf(ctx, sc2.id).call_id);
    expect(agentOf(ctx, sc2.id).state).toBe('idle');
    const starts2 = ctx.sp.starts.length;
    await ctx.req('POST', '/api/update', { text: 'still going' }, d.id, agentOf(ctx, d.id).call_id);
    expect(agentOf(ctx, sc2.id).state).toBe('idle');
    expect(ctx.sp.starts.length).toBe(starts2);
    expect(ctx.store.countPending(sc2.id)).toBe(1);
    void c;
  });

  test('the next waking delivery hands the quiet ones over in seq order (call envelope, grouped per child)', async () => {
    const ctx = await setup({ max_running: 10 });
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const scCall = agentOf(ctx, sc.id).call_id;
    const b = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'build', name: 'bob' }, sc.id, scCall)).body.agent;
    const c = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'test', name: 'cat' }, sc.id, scCall)).body.agent;
    await ctx.req('POST', '/api/wait', { reason: 'builders' }, sc.id, scCall);
    const bCall = agentOf(ctx, b.id).call_id;
    await ctx.req('POST', '/api/update', { text: 'schema done; next API' }, b.id, bCall);
    await ctx.clock.advance(5000);
    await ctx.req('POST', '/api/update', { text: 'cat: fixtures ready' }, c.id, agentOf(ctx, c.id).call_id);
    await ctx.clock.advance(5000);
    await ctx.req('POST', '/api/update', { text: 'API done; tests next' }, b.id, bCall);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
    await ctx.clock.advance(5000);
    await ctx.req('POST', '/api/done', { summary: '## Result\nlogin built' }, b.id, bCall);
    expect(agentOf(ctx, sc.id).state).toBe('working');
    const wake = ctx.sp.starts.at(-1)!;
    expect(wake.agent.id).toBe(sc.id);
    // every pending delivery went into the envelope and is marked delivered with the new call
    expect(ctx.store.countPending(sc.id)).toBe(0);
    const calls = ctx.store.callsFor(sc.id);
    const delivered = ctx.store.listMessages({ project: sc.project_id, limit: 100 }).filter((m) => m.kind === 'update' && m.from_id !== sc.id);
    for (const m of delivered) expect(ctx.store.deliveriesFor(m.id)).toMatchObject([{ state: 'delivered', call_id: calls[0].id, wake: false }]);
    const t = (ms: number) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); };
    const t0 = new Date('2026-10-13T14:02:00').getTime();
    expect(wake.prompt).toContain([
      '[sparrow] 4 new messages for @' + sc.handle + ` (project ${sc.project_id}):`,
      '',
      '── updates from @bob ──',
      `${t(t0)}  schema done; next API`,
      `${t(t0 + 10_000)}  API done; tests next`,
      '',
      `── result from @bob (ok) · 14:02 ──`,
      '## Result\nlogin built',
      '',
      '── updates from @cat ──',
      `${t(t0 + 5000)}  cat: fixtures ready`,
    ].join('\n'));
  });

  test('A3: @mentions and handles are case-insensitive', async () => {
    const ctx = await setup({ max_running: 10 });
    const m = await hire(ctx, 'builder', 'x', { name: 'Maya' });
    expect(m.handle).toBe('maya');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, m.id, agentOf(ctx, m.id).call_id);
    const d = await ctx.req('POST', '/api/send', { to: '@Maya', text: 'dm' }, ctx.captain.id);
    expect(d.status).toBe(200);
    expect(d.body.message.to_handles).toEqual(['maya']);
    const dup = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y', name: 'MAYA' }, ctx.captain.id);
    expect(dup.status).toBe(409);
    const det = await ctx.req('GET', `/api/agents/@MAYA?project=${m.project_id}`);
    expect(det.body.agent.id).toBe(m.id);
    const rel = await ctx.req('POST', '/api/release', { agent: '@MaYa' }, ctx.captain.id);
    expect(rel.body.agent.state).toBe('retired');
  });

  test('unknown handle → 404 with roster; retired target → 409', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('POST', '/api/send', { to: '@nobody', text: 'hi' }, ctx.captain.id);
    expect(r.status).toBe(404);
    expect(r.body.error).toContain(`Roster: @captain, @${a.handle}`);
    await ctx.req('POST', '/api/release', { agent: `@${a.handle}` }, ctx.captain.id);
    const r2 = await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'hi' }, ctx.captain.id);
    expect(r2.status).toBe(409);
  });

  test('message to an idle agent with a session_id → start with resume:true', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'remember 42');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    expect(agentOf(ctx, a.id).state).toBe('idle');
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'what was the number?' }, ctx.captain.id);
    expect(ctx.sp.starts.length).toBe(2);
    expect(ctx.sp.starts[1].resume).toBe(true);
    expect(ctx.sp.starts[1].agent.session_id).toBe('sess-1');
    expect(ctx.sp.starts[1].prompt).toContain('DM from @captain');
    expect(ctx.sp.starts[1].prompt).toContain('what was the number?');
    expect(ctx.store.callsFor(a.id)[0].resumed).toBe(true);
  });

  test('message to an agent without session id → start with resume:false', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder-codex', 'x');
    expect(agentOf(ctx, a.id).session_id).toBeNull();
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'again' }, ctx.captain.id);
    expect(ctx.sp.starts[1].resume).toBe(false);
  });
});

describe('done / ask / wait', () => {
  test('done with pending → ended:false + inbox; without → ended:true, idle, window stopped after grace', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const call = agentOf(ctx, a.id).call_id;
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'one more thing' }, ctx.captain.id);
    const msgsBefore = ctx.store.countMessages();
    const r1 = await ctx.req('POST', '/api/done', { summary: 'first try' }, a.id, call);
    expect(r1.body.ended).toBe(false);
    expect(r1.body.message).toBeNull(); // A1: nothing recorded
    expect(ctx.store.countMessages()).toBe(msgsBefore);
    expect(r1.body.inbox.map((m: any) => m.text)).toEqual(['one more thing']);
    expect(agentOf(ctx, a.id).state).toBe('working');
    const r2 = await ctx.req('POST', '/api/done', { summary: '## Result\nall good', status: 'ok' }, a.id, call);
    expect(r2.body.ended).toBe(true);
    expect(r2.body.message.kind).toBe('result');
    expect(r2.body.message.meta.status).toBe('ok');
    const ag = agentOf(ctx, a.id);
    expect(ag.state).toBe('idle');
    expect(ag.call_id).toBeNull();
    expect(ag.last_end_reason).toBe('done');
    expect(ag.tmux_window_id).toBe('@1');
    expect(ctx.store.callsFor(a.id)[0]).toMatchObject({ end_reason: 'done' });
    expect(ctx.sp.stops.length).toBe(0);
    await ctx.clock.advance(7999);
    expect(ctx.sp.stops.length).toBe(0);
    await ctx.clock.advance(1);
    expect(ctx.sp.stopsFor(a.id).length).toBe(1);
    expect(agentOf(ctx, a.id).tmux_window_id).toBeNull();
    // The parent got both results.
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox.map((m: any) => [m.kind, m.text])).toEqual([['result', '## Result\nall good']]); // A1: one result only
  });

  test('window not stopped by the old grace timer if a new call started meanwhile', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.clock.advance(3000);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'more' }, ctx.captain.id);
    // the new call closed the lingering old window itself before starting
    expect(ctx.sp.stops).toEqual([{ id: a.id, window: '@1' }]);
    const ag = agentOf(ctx, a.id);
    expect(ag.state).toBe('working');
    expect(ag.tmux_window_id).toBe('@2');
    await ctx.clock.advance(20_000);
    expect(ctx.sp.stops.length).toBe(1);
    expect(agentOf(ctx, a.id).tmux_window_id).toBe('@2');
  });

  test('A1: ask / wait with pending record nothing and do not end', async () => {
    const ctx = await setup();
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const call = agentOf(ctx, sc.id).call_id;
    await ctx.req('POST', '/api/send', { to: `@${sc.handle}`, text: 'first m' }, ctx.captain.id);
    const n0 = ctx.store.countMessages();
    const a1 = await ctx.req('POST', '/api/ask', { question: 'q?' }, sc.id, call);
    expect(a1.body).toMatchObject({ ended: false, message: null });
    expect(a1.body.inbox.map((m: any) => m.text)).toEqual(['first m']);
    await ctx.req('POST', '/api/send', { to: `@${sc.handle}`, text: 'second m' }, ctx.captain.id);
    const n1 = ctx.store.countMessages();
    const w1 = await ctx.req('POST', '/api/wait', { reason: 'r' }, sc.id, call);
    expect(w1.body).toMatchObject({ ended: false, message: null });
    expect(ctx.store.countMessages()).toBe(n1);
    expect(n1).toBe(n0 + 1);
    expect(agentOf(ctx, sc.id).last_update).toBeNull();
    expect(agentOf(ctx, sc.id).state).toBe('working');
    const w2 = await ctx.req('POST', '/api/wait', { reason: 'r' }, sc.id, call);
    expect(w2.body.ended).toBe(true);
    expect(w2.body.message.text).toBe('waiting: r');
  });

  test('ask → question to parent, waiting; parent answer resumes it', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('POST', '/api/ask', { question: 'which db?' }, a.id, agentOf(ctx, a.id).call_id);
    expect(r.body.ended).toBe(true);
    expect(r.body.message.kind).toBe('question');
    expect(agentOf(ctx, a.id).state).toBe('waiting');
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox[0].text).toBe('which db?');
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'sqlite' }, ctx.captain.id);
    expect(agentOf(ctx, a.id).state).toBe('working');
    expect(ctx.sp.starts.at(-1)!.resume).toBe(true);
  });

  test('wait → update "waiting: …" in the DM thread with the parent, quiet delivery, state waiting', async () => {
    const ctx = await setup();
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const r = await ctx.req('POST', '/api/wait', { reason: 'builders working' }, sc.id, agentOf(ctx, sc.id).call_id);
    expect(r.body.ended).toBe(true);
    expect(r.body.message.text).toBe('waiting: builders working');
    expect(r.body.message.kind).toBe('update');
    expect(r.body.message.thread).toBe(`dm:${[ctx.captain.id, sc.id].sort().join(':')}`);
    expect(r.body.message.mentions).toEqual([]);
    expect(ctx.store.deliveriesFor(r.body.message.id)).toMatchObject([{ to_id: ctx.captain.id, state: 'pending', wake: false }]);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
    expect(agentOf(ctx, sc.id).last_update).toBe('waiting: builders working');
  });

  test('done / ask / wait succeed with only quiet deliveries pending; those stay pending for the next call', async () => {
    const ctx = await setup({ max_running: 10 });
    for (const kind of ['done', 'ask', 'wait'] as const) {
      const sc = await hire(ctx, 'sub-captain', `lead ${kind}`);
      const scCall = agentOf(ctx, sc.id).call_id;
      const b = (await ctx.req('POST', '/api/hire', { resume: 'fake', task: 't' }, sc.id, scCall)).body.agent;
      await ctx.req('POST', '/api/update', { text: 'child progress' }, b.id, agentOf(ctx, b.id).call_id);
      expect(ctx.store.countPending(sc.id)).toBe(1);
      expect(ctx.store.countWaking(sc.id)).toBe(0);
      const body = kind === 'done' ? { summary: 'r' } : kind === 'ask' ? { question: 'q?' } : { reason: 'child' };
      const r = await ctx.req('POST', `/api/${kind}`, body, sc.id, scCall);
      expect(r.body.ended).toBe(true);
      expect(r.body.message).not.toBeNull();
      expect(r.body.inbox).toEqual([]); // the call is over: quiet ones wait for the next envelope
      expect(ctx.store.countPending(sc.id)).toBe(1);
      expect(agentOf(ctx, sc.id).state).toBe(kind === 'done' ? 'idle' : 'waiting');
    }
  });

  test('human captain: wait with only quiet pending ends and records nothing; piggyback hands the quiet ones over', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/update', { text: 'quarter way' }, a.id, agentOf(ctx, a.id).call_id);
    const n = ctx.store.countMessages();
    const w = await ctx.req('POST', '/api/wait', { reason: 'hires' }, ctx.captain.id);
    expect(w.body).toMatchObject({ ended: true, message: null });
    expect(ctx.store.countMessages()).toBe(n);
    expect(agentOf(ctx, ctx.captain.id).last_update).toBe('waiting: hires');
    expect(w.body.inbox.map((m: any) => m.text)).toEqual(['quarter way']);
  });

  test('A8: sub-captain hires a builder, waits, is woken by the result, then reports done to the human', async () => {
    const ctx = await setup();
    const sc = await hire(ctx, 'sub-captain', 'lead the login work');
    const scCall = agentOf(ctx, sc.id).call_id;
    const h = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'build login' }, sc.id, scCall);
    const b = h.body.agent;
    await ctx.req('POST', '/api/wait', { reason: 'builder' }, sc.id, scCall);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
    await ctx.req('POST', '/api/done', { summary: 'login built' }, b.id, agentOf(ctx, b.id).call_id);
    const scNow = agentOf(ctx, sc.id);
    expect(scNow.state).toBe('working');
    const wake = ctx.sp.starts.at(-1)!;
    expect(wake.agent.id).toBe(sc.id);
    expect(wake.resume).toBe(true);
    expect(wake.prompt).toContain(`result from @${b.handle} (ok)`);
    expect(wake.prompt).toContain('login built');
    expect(wake.prompt).toContain('sparrow wait'); // captain footer
    const d = await ctx.req('POST', '/api/done', { summary: 'all done' }, sc.id, scNow.call_id);
    expect(d.body.ended).toBe(true);
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    // its "waiting: builder" update reached the human only now, bundled with the result
    expect(inbox.map((m: any) => [m.from_handle, m.kind, m.text])).toEqual([[sc.handle, 'update', 'waiting: builder'], [sc.handle, 'result', 'all done']]);
  });

  test('done from a call that already ended is accepted silently (no duplicate result)', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const call = agentOf(ctx, a.id).call_id;
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, call);
    const again = await ctx.req('POST', '/api/done', { summary: 'ok again' }, a.id, call);
    expect(again.body).toMatchObject({ ended: true, message: null });
    const inbox = (await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox;
    expect(inbox.length).toBe(1);
  });

  test('human captain done → 400 (no parent); human wait works', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/done', { summary: 'x' }, ctx.captain.id);
    expect(r.status).toBe(400);
    const w = await ctx.req('POST', '/api/wait', { reason: 'hires' }, ctx.captain.id);
    expect(w.body.ended).toBe(true);
  });
});

describe('inbox long-poll', () => {
  test('GET /api/inbox?wait= returns as soon as a delivery arrives', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const t0 = Date.now();
    const p = ctx.req('GET', '/api/inbox?wait=30', undefined, ctx.captain.id);
    setTimeout(() => { void ctx.req('POST', '/api/done', { summary: 'finished' }, a.id, agentOf(ctx, a.id).call_id); }, 100);
    const r = await p;
    const dt = Date.now() - t0;
    expect(r.body.inbox.length).toBe(1);
    expect(r.body.inbox[0].text).toBe('finished');
    expect(dt).toBeLessThan(2000);
    expect(dt).toBeGreaterThanOrEqual(90);
  });

  test('times out with an empty inbox', async () => {
    const ctx = await setup();
    const t0 = Date.now();
    const r = await ctx.req('GET', '/api/inbox?wait=1', undefined, ctx.captain.id);
    expect(r.body.inbox).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });
});

describe('quiet deliveries (A5): long-poll, team digest, piggyback, turn-end', () => {
  test('an update does not end an inbox long-poll early; it comes back at the timer', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const t0 = Date.now();
    const p = ctx.req('GET', '/api/inbox?wait=1', undefined, ctx.captain.id);
    setTimeout(() => { void ctx.req('POST', '/api/update', { text: 'progress' }, a.id, agentOf(ctx, a.id).call_id); }, 100);
    const r = await p;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(r.body.inbox.map((m: any) => [m.kind, m.text])).toEqual([['update', 'progress']]);
  });

  test('a waking delivery ends the long-poll and brings the earlier quiet ones, in seq order', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const call = agentOf(ctx, a.id).call_id;
    await ctx.req('POST', '/api/update', { text: 'step 1' }, a.id, call);
    await ctx.req('POST', '/api/update', { text: 'step 2' }, a.id, call);
    const t0 = Date.now();
    const p = ctx.req('GET', '/api/inbox?wait=30', undefined, ctx.captain.id);
    setTimeout(() => { void ctx.req('POST', '/api/done', { summary: 'finished' }, a.id, call); }, 100);
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.body.inbox.map((m: any) => [m.kind, m.text])).toEqual([['update', 'step 1'], ['update', 'step 2'], ['result', 'finished']]);
    expect(r.body.inbox.map((m: any) => m.seq)).toEqual([...r.body.inbox.map((m: any) => m.seq)].sort((x: number, y: number) => x - y));
    expect(r.body.inbox[2].meta).toEqual({ status: 'ok', call_ms: 0 });
  });

  test('/api/inbox returns team: non-retired, non-idle children only; other endpoints carry no team', async () => {
    const ctx = await setup({ max_running: 10 });
    const w = await hire(ctx, 'builder', 'works', { name: 'wendy' });
    const startedAt = ctx.clock.now();
    await ctx.clock.advance(60_000);
    await ctx.req('POST', '/api/update', { text: 'wiring the API' }, w.id, agentOf(ctx, w.id).call_id);
    const q = await hire(ctx, 'builder', 'asks', { name: 'quinn' });
    await ctx.req('POST', '/api/ask', { question: 'which port?' }, q.id, agentOf(ctx, q.id).call_id);
    const i = await hire(ctx, 'builder', 'idles', { name: 'ivy' });
    await ctx.req('POST', '/api/done', { summary: 'ok' }, i.id, agentOf(ctx, i.id).call_id);
    const r = await hire(ctx, 'builder', 'released', { name: 'rex' });
    await ctx.req('POST', '/api/release', { agent: '@rex' }, ctx.captain.id);
    const sc = await hire(ctx, 'sub-captain', 'lead', { name: 'sam' });
    await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'grandchild', name: 'gus' }, sc.id, agentOf(ctx, sc.id).call_id);
    const res = await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id);
    expect(res.status).toBe(200);
    expect(res.body.team).toEqual([
      { handle: 'wendy', resume: 'builder', harness: 'claude', state: 'working', call_started_at: startedAt, last_update: 'wiring the API', last_update_at: startedAt + 60_000 },
      { handle: 'quinn', resume: 'builder', harness: 'claude', state: 'waiting', call_started_at: null, last_update: null, last_update_at: null },
      { handle: 'sam', resume: 'sub-captain', harness: 'claude', state: 'working', call_started_at: startedAt + 60_000, last_update: null, last_update_at: null },
    ]);
    // the sub-captain sees its own child, not its siblings
    const scInbox = await ctx.req('GET', '/api/inbox', undefined, sc.id, agentOf(ctx, sc.id).call_id);
    expect(scInbox.body.team.map((t: any) => t.handle)).toEqual(['gus']);
    const u = await ctx.req('POST', '/api/update', { text: 'x' }, w.id, agentOf(ctx, w.id).call_id);
    expect(u.body.team).toBeUndefined();
    const who = await ctx.req('GET', '/api/whoami', undefined, ctx.captain.id);
    expect(who.body.team).toBeUndefined();
    void r;
  });

  test('piggyback on any response hands quiet ones to a working parent', async () => {
    const ctx = await setup({ max_running: 10 });
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const scCall = agentOf(ctx, sc.id).call_id;
    const b = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 't' }, sc.id, scCall)).body.agent;
    await ctx.req('POST', '/api/update', { text: 'child step' }, b.id, agentOf(ctx, b.id).call_id);
    const r = await ctx.req('GET', '/api/whoami', undefined, sc.id, scCall);
    expect(r.body.inbox.map((m: any) => [m.from_handle, m.kind, m.text])).toEqual([[b.handle, 'update', 'child step']]);
    expect(ctx.store.countPending(sc.id)).toBe(0);
  });

  test('turn-end: quiet-only pending → nudge (not delivered); a waking one → delivered together, seq order', async () => {
    const ctx = await setup({ max_running: 10 });
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const scCall = agentOf(ctx, sc.id).call_id;
    const b = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 't' }, sc.id, scCall)).body.agent;
    await ctx.req('POST', '/api/update', { text: 'child step' }, b.id, agentOf(ctx, b.id).call_id);
    const r1 = await ctx.req('POST', '/api/hooks/turn-end', { harness: 'claude' }, sc.id, scCall);
    expect(r1.body).toEqual({ action: 'block', reason: NUDGE_REPORT });
    expect(ctx.store.countPending(sc.id)).toBe(1);
    await ctx.req('POST', '/api/send', { to: `@${sc.handle}`, text: 'status?' }, ctx.captain.id);
    const r2 = await ctx.req('POST', '/api/hooks/turn-end', { harness: 'claude' }, sc.id, scCall);
    expect(r2.body.action).toBe('block');
    expect(r2.body.reason).toContain('[sparrow] 2 new messages');
    expect(r2.body.reason.indexOf('child step')).toBeGreaterThan(-1);
    expect(r2.body.reason.indexOf('status?')).toBeGreaterThan(r2.body.reason.indexOf('child step'));
    expect(ctx.store.countPending(sc.id)).toBe(0);
  });

  test('release drops quiet pending deliveries too; updates to a retired parent create none', async () => {
    const ctx = await setup({ max_running: 10 });
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const scCall = agentOf(ctx, sc.id).call_id;
    const b = (await ctx.req('POST', '/api/hire', { resume: 'builder', task: 't' }, sc.id, scCall)).body.agent;
    const u = await ctx.req('POST', '/api/update', { text: 'child step' }, b.id, agentOf(ctx, b.id).call_id);
    await ctx.req('POST', '/api/release', { agent: `@${sc.handle}` }, ctx.captain.id);
    expect(ctx.store.deliveriesFor(u.body.message.id)).toMatchObject([{ state: 'dropped', wake: false }]);
    const u2 = await ctx.req('POST', '/api/update', { text: 'after release' }, b.id, agentOf(ctx, b.id).call_id);
    expect(u2.status).toBe(200);
    expect(ctx.store.deliveriesFor(u2.body.message.id)).toEqual([]);
  });
});

describe('piggyback rules', () => {
  test('a non-working agent (call ended) does not consume deliveries via piggyback', async () => {
    const ctx = await setup({ max_running: 1 });
    const a = await hire(ctx, 'builder', 'x');
    const call = agentOf(ctx, a.id).call_id;
    const blocker = await hire(ctx, 'builder', 'y'); // queued
    expect(blocker.state).toBe('queued');
    const r = await ctx.req('POST', '/api/whoami', undefined, blocker.id);
    expect(r.status).toBe(404); // whoami is GET only
    const w = await ctx.req('GET', '/api/whoami', undefined, blocker.id);
    expect(w.body.inbox).toEqual([]);
    expect(ctx.store.countPending(blocker.id)).toBe(1);
    expect(w.body.agent.handle).toBe(blocker.handle);
    expect(w.body.parent.handle).toBe('captain');
    void call;
  });
});
