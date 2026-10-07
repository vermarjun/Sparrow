import { describe, expect, test } from 'bun:test';
import { agentOf, hire, setup } from './helpers';

describe('cards (tracking only)', () => {
  test('propose (any agent) → proposed, created_by agent, piggyback inbox', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('POST', '/api/propose', { title: 'Add rate limiting', details: 'login endpoint', category: 'security' }, a.id);
    expect(r.status).toBe(200);
    expect(r.body.card).toMatchObject({ state: 'proposed', title: 'Add rate limiting', category: 'security', created_by: a.id });
    expect(r.body.inbox).toEqual([]);
    const r2 = await ctx.req('POST', '/api/propose', { title: 'Second' }, a.id);
    expect(r2.body.card.position).toBeGreaterThan(r.body.card.position);
  });

  test('captain create/move/assign/note; non-captain create → 403', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const denied = await ctx.req('POST', '/api/cards', { title: 'nope' }, a.id);
    expect(denied.status).toBe(403);
    const c = (await ctx.req('POST', '/api/cards', { title: 'Login', assignee: `@${a.handle}` }, ctx.captain.id)).body.card;
    expect(c.state).toBe('todo');
    expect(c.assignee_id).toBe(a.id);
    expect(c.created_by).toBe(ctx.captain.id);
    const m = await ctx.req('PATCH', `/api/cards/${c.id}`, { state: 'in_progress' }, ctx.captain.id);
    expect(m.body.card.state).toBe('in_progress');
    expect(m.body.card.notes.at(-1).text).toBe('moved todo → in_progress');
    const un = await ctx.req('PATCH', `/api/cards/${c.id}`, { assignee: 'none' }, ctx.captain.id);
    expect(un.body.card.assignee_id).toBeNull();
    const n = await ctx.req('PATCH', `/api/cards/${c.id}`, { note: 'looks good' }, ctx.captain.id);
    expect(n.body.card.notes.at(-1)).toMatchObject({ by: 'captain', text: 'looks good' });
    const bad = await ctx.req('PATCH', `/api/cards/${c.id}`, { state: 'banana' }, ctx.captain.id);
    expect(bad.status).toBe(400);
    const missing = await ctx.req('PATCH', `/api/cards/999`, { state: 'done' }, ctx.captain.id);
    expect(missing.status).toBe(404);
  });

  test('assignee may move its own card to review and add notes, nothing else', async () => {
    const ctx = await setup({ max_running: 5 });
    const a = await hire(ctx, 'builder', 'x');
    const b = await hire(ctx, 'builder', 'y');
    const c = (await ctx.req('POST', '/api/cards', { title: 'Login', assignee: `@${a.handle}`, state: 'in_progress' }, ctx.captain.id)).body.card;
    const ok = await ctx.req('PATCH', `/api/cards/${c.id}`, { state: 'review', note: 'ready' }, a.id);
    expect(ok.status).toBe(200);
    expect(ok.body.card.state).toBe('review');
    expect(ok.body.card.notes.map((x: any) => x.text)).toEqual(['ready', 'moved in_progress → review']);
    const done = await ctx.req('PATCH', `/api/cards/${c.id}`, { state: 'done' }, a.id);
    expect(done.status).toBe(403);
    const other = await ctx.req('PATCH', `/api/cards/${c.id}`, { note: 'hi' }, b.id);
    expect(other.status).toBe(403);
  });

  test('UI (no header) can create and patch; PATCH never calls the spawner nor creates messages', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.clock.advance(10_000);
    const noProj = await ctx.req('POST', '/api/cards', { title: 'UI card' });
    expect(noProj.status).toBe(400);
    const c = (await ctx.req('POST', '/api/cards', { title: 'UI card', project: a.project_id })).body.card;
    expect(c.created_by).toBe('user');
    const spawnerCalls = ctx.sp.calls;
    const msgs = ctx.store.countMessages();
    const events0 = ctx.events.length;
    for (const patch of [{ state: 'in_progress', position: 0.5 }, { assignee: `@${a.handle}` }, { state: 'review' }, { state: 'done', position: 3 }, { note: 'from UI' }]) {
      const r = await ctx.req('PATCH', `/api/cards/${c.id}`, patch);
      expect(r.status).toBe(200);
      expect(r.body.inbox).toBeUndefined();
    }
    expect(ctx.sp.calls).toBe(spawnerCalls);
    expect(ctx.store.countMessages()).toBe(msgs);
    expect(agentOf(ctx, a.id).state).toBe('idle');
    expect(ctx.events.slice(events0).every((e) => e.type === 'card.updated')).toBe(true);
    const final = ctx.store.getCard(c.id)!;
    expect(final).toMatchObject({ state: 'done', position: 3, assignee_id: a.id });
    expect(final.notes.at(-1)).toMatchObject({ by: 'user', text: 'from UI' });
  });

  test('GET /api/cards?project= lists the project cards', async () => {
    const ctx = await setup();
    const pid = ctx.captain.project_id;
    await ctx.req('POST', '/api/cards', { title: 'one' }, ctx.captain.id);
    await ctx.req('POST', '/api/cards', { title: 'two', state: 'done' }, ctx.captain.id);
    const r = await ctx.req('GET', `/api/cards?project=${pid}`);
    expect(r.body.map((c: any) => c.title).sort()).toEqual(['one', 'two']);
  });
});
