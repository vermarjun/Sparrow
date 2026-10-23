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

  test('v2 fields round-trip through shared validation and normalization', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('POST', '/api/propose', {
      title: '  Add a useful limit  ', context: 'Asked in triage', problem: 'Observed: no cap. Expected: a cap.',
      approach: 'Use plain English.', details: 'old details', category: ' Board ', checks: ['  Limit is enforced  ', { text: 'Invalid limit returns 400', done: true }, '   '],
      tags: [' UI ', 'api', 'ui'], urgent: true, impact: 'H', effort: 'lo', estimate_min: '1h30m', blocked_on: ' IT access ', later: true,
    }, a.id);
    expect(r.status).toBe(200);
    expect(r.body.card).toMatchObject({
      title: 'Add a useful limit', context: 'Asked in triage', problem: 'Observed: no cap. Expected: a cap.', approach: 'Use plain English.',
      details: 'old details', category: 'board', checks: [{ text: 'Limit is enforced', done: false }, { text: 'Invalid limit returns 400', done: true }],
      tags: ['ui', 'api'], urgent: true, impact: 'high', effort: 'low', estimate_min: 90, blocked_on: 'IT access', later_at: ctx.clock.t, blocked_at: ctx.clock.t,
    });
    expect(r.body.card.history).toEqual([{ at: ctx.clock.t, by: a.handle, from: null, to: 'proposed' }]);
    const bad = await ctx.req('PATCH', `/api/cards/${r.body.card.id}`, { estimate_min: 'next week' }, ctx.captain.id);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('estimate_min');
  });

  test('v2 validation errors name the field and its allowed value', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const invalid: [Record<string, unknown>, string][] = [
      [{ title: '  ' }, 'title'], [{ title: 'x'.repeat(201) }, 'title'], [{ title: 'x', context: 'x'.repeat(20_001) }, 'context'],
      [{ title: 'x', checks: Array(31).fill('check') }, 'checks'], [{ title: 'x', checks: ['x'.repeat(501)] }, 'checks[0]'],
      [{ title: 'x', tags: ['bad,tag'] }, 'tags[0]'], [{ title: 'x', impact: 'critical' }, 'impact'],
      [{ title: 'x', estimate_min: 'tomorrow' }, 'estimate_min'], [{ title: 'x', urgent: 'yes' }, 'urgent'],
    ];
    for (const [body, field] of invalid) {
      const r = await ctx.req('POST', '/api/propose', body, a.id);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(field);
    }
    const createBad = await ctx.req('POST', '/api/cards', { title: 'x', effort: 'huge' }, ctx.captain.id);
    expect(createBad.status).toBe(400);
    expect(createBad.body.error).toContain('effort');
  });

  test('caps estimates and blocked text, and bounds card positions', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const atCaps = await ctx.req('POST', '/api/propose', {
      title: 'At field caps', estimate_min: 30 * 480, blocked_on: 'x'.repeat(500),
    }, a.id);
    expect(atCaps.status).toBe(200);
    expect(atCaps.body.card).toMatchObject({ estimate_min: 14_400, blocked_on: 'x'.repeat(500) });

    for (const [body, field] of [
      [{ title: 'Too long estimate', estimate_min: 14_401 }, 'estimate_min'],
      [{ title: 'Too long block', blocked_on: 'x'.repeat(501) }, 'blocked_on'],
    ]) {
      const invalid = await ctx.req('POST', '/api/propose', body, a.id);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain(field);
    }

    for (const position of [1_000_000_001, -1_000_000_001, 'Infinity']) {
      const invalid = await ctx.req('PATCH', `/api/cards/${atCaps.body.card.id}`, { position }, ctx.captain.id);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain('position');
    }
    for (const position of [1_000_000_000, -1_000_000_000]) {
      const valid = await ctx.req('PATCH', `/api/cards/${atCaps.body.card.id}`, { position }, ctx.captain.id);
      expect(valid.status).toBe(200);
      expect(valid.body.card.position).toBe(position);
    }
    const tooLongPatch = await ctx.req('PATCH', `/api/cards/${atCaps.body.card.id}`, { blocked_on: 'x'.repeat(501) }, ctx.captain.id);
    expect(tooLongPatch.status).toBe(400);
    expect(tooLongPatch.body.error).toContain('blocked_on');
  });

  test('assignee permission matrix allows only comments, review, checks, and blocked_on', async () => {
    const ctx = await setup({ max_running: 5 });
    const a = await hire(ctx, 'builder', 'x');
    const b = await hire(ctx, 'builder', 'y');
    const card = (await ctx.req('POST', '/api/cards', { title: 'Login', state: 'in_progress', assignee: `@${a.handle}`, checks: ['Login works'] }, ctx.captain.id)).body.card;
    const allowed = await ctx.req('PATCH', `/api/cards/${card.id}`, { note: 'Started', check: { index: 0, done: true }, blocked_on: 'IT access' }, a.id);
    expect(allowed.status).toBe(200);
    expect(allowed.body.card.checks[0].done).toBe(true);
    expect(allowed.body.card.notes.map((n: any) => n.kind)).toEqual(['comment', 'event', 'event']);
    expect(allowed.body.card.notes.at(-1).text).toBe('checked "Login works"');
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { blocked_on: null }, a.id)).status).toBe(200);
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { state: 'review' }, a.id)).status).toBe(200);
    for (const patch of [{ title: 'Changed' }, { state: 'done' }, { urgent: true }, { later: true }, { assignee: 'none' }]) {
      expect((await ctx.req('PATCH', `/api/cards/${card.id}`, patch, a.id)).status).toBe(403);
    }
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { note: 'not assigned' }, b.id)).status).toBe(403);
    const proposed = await ctx.req('POST', '/api/propose', { title: 'Agent ticket', context: 'from a', impact: 'high', effort: 'low', estimate_min: '2h' }, a.id);
    expect(proposed.body.card).toMatchObject({ state: 'proposed', context: 'from a', impact: 'high', effort: 'low', estimate_min: 120, assignee_id: null });
    expect((await ctx.req('POST', '/api/propose', { title: 'bad', state: 'todo' }, a.id)).status).toBe(400);
  });

  test('state changes record history and timeline; Later and Blocked clear by rule', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const card = (await ctx.req('POST', '/api/cards', { title: 'Ticket', blocked_on: 'IT', later: true }, ctx.captain.id)).body.card;
    const moved = await ctx.req('PATCH', `/api/cards/${card.id}`, { state: 'in_progress', urgent: true, context: 'context', approach: 'plan' }, ctx.captain.id);
    expect(moved.body.card).toMatchObject({ state: 'in_progress', later_at: null, blocked_on: 'IT', urgent: true });
    expect(moved.body.card.history.at(-1)).toMatchObject({ by: 'captain', from: 'todo', to: 'in_progress' });
    expect(moved.body.card.notes.map((n: any) => n.text)).toEqual([
      'moved todo → in_progress', 'marked urgent', 'back from Later', 'edited context, approach',
    ]);
    const done = await ctx.req('PATCH', `/api/cards/${card.id}`, { state: 'done' }, ctx.captain.id);
    expect(done.body.card.blocked_on).toBeNull();
    expect(done.body.card.history.at(-1)).toMatchObject({ from: 'in_progress', to: 'done' });
    expect(done.body.card.notes.at(-1).text).toMatch(/^unblocked after /);
    const update = await ctx.req('POST', '/api/update', { text: 'progress note', card_id: card.id }, a.id, agentOf(ctx, a.id).call_id);
    expect(update.status).toBe(200);
    expect(ctx.store.getCard(card.id)!.notes.at(-1)).toMatchObject({ kind: 'comment', text: 'progress note', by: a.handle });
  });

  test('auto-review runs only for the caller after done ok; blocked and failed only add events', async () => {
    const ctx = await setup({ max_running: 5 });
    const okAgent = await hire(ctx, 'builder', 'x');
    const blockedAgent = await hire(ctx, 'builder', 'y');
    const okCard = (await ctx.req('POST', '/api/cards', { title: 'ok work', state: 'in_progress', assignee: `@${okAgent.handle}` }, ctx.captain.id)).body.card;
    const blockedCard = (await ctx.req('POST', '/api/cards', { title: 'blocked work', state: 'in_progress', assignee: `@${blockedAgent.handle}` }, ctx.captain.id)).body.card;
    const failedCard = (await ctx.req('POST', '/api/cards', { title: 'failed work', state: 'in_progress', assignee: `@${blockedAgent.handle}` }, ctx.captain.id)).body.card;
    await ctx.req('POST', '/api/done', { summary: 'built it', status: 'ok' }, okAgent.id, agentOf(ctx, okAgent.id).call_id);
    expect(ctx.store.getCard(okCard.id)!.state).toBe('review');
    expect(ctx.store.getCard(okCard.id)!.history.at(-1)).toMatchObject({ by: okAgent.handle, from: 'in_progress', to: 'review' });
    expect(ctx.store.getCard(okCard.id)!.notes.at(-1)!.text).toBe(`@${okAgent.handle} reported done → review`);
    const summary = 'X'.repeat(240);
    await ctx.req('POST', '/api/done', { summary, status: 'blocked' }, blockedAgent.id, agentOf(ctx, blockedAgent.id).call_id);
    for (const id of [blockedCard.id, failedCard.id]) {
      const c = ctx.store.getCard(id)!;
      expect(c.state).toBe('in_progress');
      expect(c.history).toHaveLength(1);
      expect(c.notes.at(-1)!.kind).toBe('event');
      expect(c.notes.at(-1)!.text).toBe(`@${blockedAgent.handle} reported blocked: ${summary.slice(0, 200)}`);
    }
  });

  test('GET /api/cards/:id accepts project keys and hides cards from other agent projects', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    const card = (await ctx.req('POST', '/api/cards', { title: 'Visible' }, ctx.captain.id)).body.card;
    const got = await ctx.req('GET', `/api/cards/TOR-${card.id}`, undefined, a.id);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(card.id);
    const missing = await ctx.req('GET', '/api/cards/TOR-999', undefined, a.id);
    expect(missing.status).toBe(404);
    ctx.store.insertProject({ id: 'other', name: 'other', root: `${ctx.root}/other`, created_at: ctx.clock.t });
    const elsewhere = (await ctx.req('POST', '/api/cards', { title: 'Private', project: 'other' })).body.card;
    const hidden = await ctx.req('GET', `/api/cards/${elsewhere.id}`, undefined, a.id);
    expect(hidden.status).toBe(404);
  });

  test('legacy v1 card rows receive safe v2 defaults', async () => {
    const ctx = await setup();
    const now = ctx.clock.t;
    const result = ctx.store.db.query(`INSERT INTO cards (project_id, title, details, category, state, position, assignee_id, created_by, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ctx.captain.project_id, 'Old ticket', '', null, 'todo', 1, null, ctx.captain.id, '[{"at":1,"by":"captain","text":"old comment"}]', now, now);
    const card = ctx.store.getCard(Number(result.lastInsertRowid))!;
    expect(card).toMatchObject({ context: '', problem: '', approach: '', checks: [], tags: [], urgent: false, impact: null, effort: null, estimate_min: null, blocked_on: null, blocked_at: null, later_at: null, history: [] });
    expect(card.notes[0].kind).toBeUndefined();
  });
});
