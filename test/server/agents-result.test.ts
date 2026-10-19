// D5: the agents read API carries each agent's latest `done` (status + text) so the UI can show how a job ended.
import { describe, expect, test } from 'bun:test';
import { agentOf, hire, setup } from './helpers';

describe('agents carry last_result', () => {
  test('GET /api/agents and /api/agents/:id include the latest done (status + text); no done → null', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'x', { name: 'leo' });
    const b = await hire(ctx, 'fake', 'y', { name: 'maya' });
    const c = await hire(ctx, 'fake', 'z', { name: 'ravi' });
    await ctx.req('POST', '/api/done', { summary: '## Result\nfirst pass', status: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.req('POST', '/api/send', { to: '@leo', text: 'one more thing' }, ctx.captain.id);
    await ctx.clock.advance(1000);
    await ctx.req('POST', '/api/done', { summary: '## Result\nsecond pass blocked on creds', status: 'blocked' }, a.id, agentOf(ctx, a.id).call_id);
    await ctx.req('POST', '/api/done', { summary: 'could not build', status: 'failed' }, b.id, agentOf(ctx, b.id).call_id);

    const list = (await ctx.req('GET', `/api/agents?project=${ctx.captain.project_id}`)).body as any[];
    const by = (id: string) => list.find((x) => x.id === id);
    expect(by(a.id).last_result).toMatchObject({ status: 'blocked', text: '## Result\nsecond pass blocked on creds' });
    expect(by(b.id).last_result).toMatchObject({ status: 'failed', text: 'could not build' });
    expect(by(c.id).last_result).toBeNull();                    // still working, never reported
    expect(by(a.id).last_end_reason).toBe('done');
    const detail = (await ctx.req('GET', `/api/agents/${a.id}`)).body;
    expect(detail.agent.last_result.status).toBe('blocked');
  });
});
