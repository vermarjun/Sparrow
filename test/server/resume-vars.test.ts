// Resume template variables: {{harness}} {{model}} {{effort}} {{runtime}}. web/test/resumeVars.test.ts has the same vectors.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSystemPrompt } from '../../src/server/prompts';
import { renderResumeText, Resumes, templateRuntime } from '../../src/server/resumes';
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

describe('templateRuntime: hard-coded runtimes in old descriptions follow the settings', () => {
  const old: [string, string][] = [
    ['Implements one task end to end in the given folder (Claude Code, Sonnet). Writes the code.', 'Implements one task end to end in the given folder ({{runtime}}). Writes the code.'],
    ['Implements one task end to end on Codex (gpt-6-luna). Same job as builder.', 'Implements one task end to end ({{runtime}}). Same job as builder.'],
    ['Web + codebase research on OpenCode (Kimi K3). Answers a question.', 'Web + codebase research ({{runtime}}). Answers a question.'],
    ["Read-only, adversarial reviewer (OpenCode, DeepSeek V4.1 Flash). Checks someone else's work.", "Read-only, adversarial reviewer ({{runtime}}). Checks someone else's work."],
  ];
  test.each(old)('%s', (from, to) => expect(templateRuntime(from)).toBe(to));
  test('left alone: already templated, or a parenthetical that names no harness', () => {
    expect(templateRuntime('Builds things ({{model}}, Claude Code).')).toBe('Builds things ({{model}}, Claude Code).');
    expect(templateRuntime('Writes docs (markdown, HTML).')).toBe('Writes docs (markdown, HTML).');
  });

  test('server start rewrites only the description line of the user resumes; renders the live model after a change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resumes-rt-'));
    const body = '---\nname: researcher\ntitle: Researcher\ndescription: Web + codebase research on OpenCode (Kimi K3). Answers.\nharness: opencode\nmodel: opencode-go/kimi-k3\ncan_hire: []\n---\nRole body (Kimi K3 stays here)\n';
    writeFileSync(join(dir, 'researcher.md'), body);
    const resumes = new Resumes([dir], { quiet_minutes: 15, max_call_minutes: 60 });
    expect(resumes.templateRuntimeDescriptions()).toEqual(['researcher']);
    expect(readFileSync(join(dir, 'researcher.md'), 'utf8')).toBe(body.replace('description: Web + codebase research on OpenCode (Kimi K3). Answers.', 'description: "Web + codebase research ({{runtime}}). Answers."'));
    expect(resumes.templateRuntimeDescriptions()).toEqual([]);
    const r = resumes.get('researcher')!;
    resumes.write('researcher', { title: r.title, description: r.description, harness: 'opencode', model: 'opencode-go/deepseek-v4-pro', effort: 'high', can_hire: [], body: r.body, limits: r.limits } as any);
    const after = resumes.get('researcher')!;
    expect(renderResumeText(after.description, after)).toBe('Web + codebase research (opencode · opencode-go/deepseek-v4-pro · effort high). Answers.');
  });

  test('saving a resume with a hard-coded runtime stores ({{runtime}})', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resumes-rt-'));
    const resumes = new Resumes([dir], { quiet_minutes: 15, max_call_minutes: 60 });
    const r = resumes.write('b', { title: 'B', description: 'Builds (Claude Code, Opus).', harness: 'claude', model: 'opus', effort: null, can_hire: [], body: 'x', limits: { quiet_minutes: 15, max_call_minutes: 60 } } as any);
    expect(r.description).toBe('Builds ({{runtime}}).');
  });
});
