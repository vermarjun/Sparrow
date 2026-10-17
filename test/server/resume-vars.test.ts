// Resume template variables: {{harness}} {{model}} {{effort}} {{runtime}}. web/test/resumeVars.test.ts has the same vectors.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSystemPrompt } from '../../src/server/prompts';
import { renderResumeText } from '../../src/server/resumes';
import type { Agent, Project } from '../../src/shared/types';
import { flush, hire, setup } from './helpers';

describe('renderResumeText', () => {
  test('all variables', () => {
    expect(renderResumeText('{{harness}}|{{model}}|{{effort}}|{{runtime}}', { harness: 'claude', model: 'sonnet', effort: 'high' }))
      .toBe('claude|sonnet|high|claude · sonnet · effort high');
  });
  test('null model and effort fall back', () => {
    expect(renderResumeText('{{model}}/{{effort}} ({{runtime}})', { harness: 'codex', model: null, effort: null }))
      .toBe('harness default/default (codex · harness default · effort default)');
  });
  test('unknown variables are kept, whitespace inside braces allowed', () => {
    expect(renderResumeText('{{ harness }} {{nope}} {{constructor}}', { harness: 'opencode' })).toBe('opencode {{nope}} {{constructor}}');
  });
});

const resumeWithVars = (model: string) =>
  `---\nname: vars\ntitle: Vars\ndescription: d\nharness: claude\nmodel: ${model}\neffort: low\ncan_hire: []\n---\nYou run as {{runtime}}. Unknown {{nope}}.\n`;

async function varsCtx(model = 'haiku') {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-vars-res-'));
  writeFileSync(join(dir, 'vars.md'), resumeWithVars(model));
  return setup({}, { resumeDirs: [dir] });
}

describe('system prompt', () => {
  test('role body is rendered with the agent\'s actual harness/model/effort', async () => {
    const ctx = await varsCtx();
    await hire(ctx, 'vars', 'task');
    await flush();
    const sys = ctx.sp.starts[0].system_prompt;
    expect(sys).toContain('You run as claude · haiku · effort low. Unknown {{nope}}.');
    expect(sys).toContain('Harness: claude · model haiku · effort low.');
  });

  test('hire --model/--effort override wins over the resume', async () => {
    const ctx = await varsCtx();
    await hire(ctx, 'vars', 'task', { model: 'opus', effort: 'max' });
    await flush();
    const sys = ctx.sp.starts[0].system_prompt;
    expect(sys).toContain('You run as claude · opus · effort max.');
    expect(sys).not.toContain('haiku');
  });

  test('null model/effort render as defaults; shipped protocol.md header carries model and effort', () => {
    const agent = {
      id: 'ag_1', handle: 'james', title: 'Vars', harness: 'codex', model: null, effort: null, cwd: '/x',
      tmux_session: 's', tmux_window: 'james', can_hire: [], parent_id: null,
    } as unknown as Agent;
    const project: Project = { id: 'p', name: 'p', root: '/x', created_at: 0 };
    const res = { title: 'Vars', body: 'On {{harness}}: {{runtime}}\n' } as any;
    const out = renderSystemPrompt(agent, res, null, project);
    expect(out).toContain('harness codex · model harness default · effort default · folder `/x`');
    expect(out).toContain('On codex: codex · harness default · effort default');
  });

  test('applyResume note renders the new body with the resume\'s new settings', async () => {
    const ctx = await varsCtx();
    const a = await hire(ctx, 'vars', 'first');
    await flush();
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, ctx.store.getAgent(a.id)!.call_id);
    await ctx.clock.advance(10_000);
    const body = { title: 'Vars', description: 'd', harness: 'claude', model: 'opus', effort: 'high', can_hire: [], limits: { quiet_minutes: 10, max_call_minutes: 60 }, body: 'Now {{runtime}}.\n' };
    expect((await ctx.req('PUT', '/api/resumes/vars', body)).status).toBe(200);
    expect((await ctx.req('POST', '/api/resumes/vars/apply')).status).toBe(200);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'second' }, ctx.captain.id);
    await flush();
    expect(ctx.sp.startsFor(a.id).at(-1)!.prompt).toContain('Your role from now on:\n\nNow claude · opus · effort high.');
  });
});
