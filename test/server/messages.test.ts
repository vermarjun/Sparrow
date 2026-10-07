import { describe, expect, test } from 'bun:test';
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

  test('group: only mentioned agents get deliveries; sender excluded; unknown @words ignored; no mention wakes nobody', async () => {
    const ctx = await setup({ max_running: 10 });
    const a = await hire(ctx, 'builder', 'x');
    const b = await hire(ctx, 'builder', 'y');
    // End both calls so a delivery would start a new call (wake is observable).
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.req('POST', '/api/done', { summary: 'ok' }, b.id, agentOf(ctx, b.id).call_id);
    const before = ctx.sp.starts.length;
    const none = await ctx.req('POST', '/api/send', { to: 'group', text: 'hello all, ping me@example.com' }, ctx.captain.id);
    expect(none.body.message.mentions).toEqual([]);
    expect(ctx.sp.starts.length).toBe(before);
    const r = await ctx.req('POST', '/api/send', { to: 'group', text: `@${b.handle} please check, cc @ghost @captain` }, ctx.captain.id);
    expect(r.body.message.mentions).toEqual([b.id]);
    expect(ctx.sp.starts.length).toBe(before + 1);
    expect(ctx.sp.starts.at(-1)!.agent.id).toBe(b.id);
    expect(ctx.sp.starts.at(-1)!.prompt).toContain('group from @captain (@mention)');
    expect(agentOf(ctx, a.id).state).toBe('idle');
    // Agent mentions the captain in group → captain gets a delivery (piggyback), sender excluded.
    const bc = agentOf(ctx, b.id).call_id;
    const g = await ctx.req('POST', '/api/send', { to: 'group', text: `@captain @${b.handle} done soon` }, b.id, bc);
    expect(g.body.message.mentions).toEqual([ctx.captain.id]);
  });

  test('update → group, no deliveries, sets last_update, card note when card_id', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const card = (await ctx.req('POST', '/api/cards', { title: 't', assignee: `@${a.handle}` }, ctx.captain.id)).body.card;
    const r = await ctx.req('POST', '/api/update', { text: `progress @captain`, card_id: card.id }, a.id);
    expect(r.body.message.thread).toBe('group');
    expect(r.body.message.kind).toBe('update');
    expect(r.body.message.mentions).toEqual([]);
    expect(ctx.store.deliveriesFor(r.body.message.id)).toEqual([]);
    expect(agentOf(ctx, a.id).last_update).toBe('progress @captain');
    expect(ctx.store.getCard(card.id)!.notes.at(-1)!.text).toBe('progress @captain');
  });

  test('A3: @mentions and handles are case-insensitive', async () => {
    const ctx = await setup({ max_running: 10 });
    const m = await hire(ctx, 'builder', 'x', { name: 'Maya' });
    expect(m.handle).toBe('maya');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, m.id, agentOf(ctx, m.id).call_id);
    const before = ctx.sp.starts.length;
    const g = await ctx.req('POST', '/api/send', { to: 'GROUP', text: 'hey @MAYA, and @Maya- again' }, ctx.captain.id);
    expect(g.status).toBe(200);
    expect(g.body.message.mentions).toEqual([m.id]);
    expect(ctx.sp.starts.length).toBe(before + 1);
    const call = agentOf(ctx, m.id).call_id;
    await ctx.req('POST', '/api/done', { summary: 'ok' }, m.id, call);
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

  test('wait → group update "waiting: …", no delivery, state waiting', async () => {
    const ctx = await setup();
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const r = await ctx.req('POST', '/api/wait', { reason: 'builders working' }, sc.id, agentOf(ctx, sc.id).call_id);
    expect(r.body.ended).toBe(true);
    expect(r.body.message.text).toBe('waiting: builders working');
    expect(r.body.message.thread).toBe('group');
    expect(ctx.store.deliveriesFor(r.body.message.id)).toEqual([]);
    expect(agentOf(ctx, sc.id).state).toBe('waiting');
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
    expect(inbox.map((m: any) => [m.from_handle, m.kind])).toEqual([[sc.handle, 'result']]);
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
