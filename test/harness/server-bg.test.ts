// T2 fix round 2 (I1 bug 4): the minimal server change in src/server/core.ts — a Claude turn end with running
// background tasks is allowed without a nudge and without counting one; pending messages are still delivered.
import { describe, expect, test } from 'bun:test';
import { agentOf, hire, setup } from '../server/helpers';

const turnEnd = (ctx: any, a: any, body: any = {}) =>
  ctx.req('POST', '/api/hooks/turn-end', { harness: 'claude', ...body }, a.id, agentOf(ctx, a.id).call_id);

describe('turn-end with background_tasks_running', () => {
  test('allow, no nudge counted, agent stays working; pending still delivered', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    for (let i = 0; i < 5; i++) {
      const r = await turnEnd(ctx, a, { background_tasks_running: 1 });
      expect(r.body).toEqual({ action: 'allow' });
    }
    const ag = agentOf(ctx, a.id);
    expect(ag.state).toBe('working');
    expect(ctx.store.getCall(ag.call_id!)!.nudges).toBe(0);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'new info' }, ctx.captain.id);
    const r = await turnEnd(ctx, a, { background_tasks_running: 1 });
    expect(r.body.action).toBe('block');
    expect(r.body.reason).toContain('new info');
    // without the flag the normal nudge path still applies
    const n = await turnEnd(ctx, a);
    expect(n.body.action).toBe('block');
    expect(ctx.store.getCall(agentOf(ctx, a.id).call_id!)!.nudges).toBe(1);
  });
});
