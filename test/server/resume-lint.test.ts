// D1: Doctor warns when a resume description names a harness or model that differs from the resume's own settings.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeDescriptionsCheck } from '../../src/server/doctor';
import { descriptionDrift, resumeDescriptionDrift } from '../../src/server/resume-lint';
import type { CatalogModel, HarnessCatalog } from '../../src/shared/types';
import { setup } from './helpers';

const model = (id: string, label = id, extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ id, label, efforts: ['low', 'high'], default_effort: 'low', hidden: false, cost: null, resolves_to: null, description: null, ...extra });
const cat = (harness: HarnessCatalog['harness'], models: CatalogModel[]): HarnessCatalog =>
  ({ harness, ok: true, error: null, version: '1', binary: `/bin/${harness}`, models, fetched_at: 0 });
const CATALOGS = [
  cat('claude', [model('opus', 'Opus', { resolves_to: 'claude-opus-5-5' }), model('sonnet', 'Sonnet', { resolves_to: 'claude-sonnet-5-5' }), model('haiku', 'Haiku')]),
  cat('codex', [model('gpt-6.1-sol', 'GPT-6.1 Sol'), model('gpt-6-luna', 'GPT-6 Luna'), model('plain', 'Plain')]),
  cat('opencode', [model('opencode-go/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'), model('opencode-go/kimi-k3', 'Kimi K3')]),
];
const r = (slug: string, harness: any, model: string | null, description: string) => ({ slug, harness, model, description });

describe('descriptionDrift: the three drifts found in the dogfood run', () => {
  test('builder says Claude Code, Opus but runs sonnet', () => {
    const p = descriptionDrift(r('builder', 'claude', 'sonnet', 'Implements one task end to end (Claude Code, Opus).'), CATALOGS);
    expect(p).toEqual(['names model opus but the resume runs sonnet']);
  });
  test('builder-codex names gpt-6.1-sol but runs gpt-6-luna', () => {
    const p = descriptionDrift(r('builder-codex', 'codex', 'gpt-6-luna', 'Same job as builder (Codex, gpt-6.1-sol, high effort).'), CATALOGS);
    expect(p).toEqual(['names model gpt-6.1-sol but the resume runs gpt-6-luna']);
  });
  test('verifier says Codex but runs OpenCode deepseek', () => {
    const p = descriptionDrift(r('verifier', 'opencode', 'opencode-go/deepseek-v4.1-flash', 'Read-only, adversarial reviewer (Codex).'), CATALOGS);
    expect(p).toEqual(['names Codex but runs on OpenCode']);
  });
  test('wrong harness and wrong model are both reported', () => {
    const p = descriptionDrift(r('x', 'codex', 'gpt-6-luna', 'A Claude Code Opus reviewer.'), CATALOGS);
    expect(p.length).toBe(2);
  });
});

describe('descriptionDrift: conservative', () => {
  const ok = (resume: ReturnType<typeof r>) => expect(descriptionDrift(resume, CATALOGS)).toEqual([]);
  test('{{runtime}} / {{model}} / {{harness}} templates are never drift', () => {
    ok(r('a', 'claude', 'sonnet', 'Implements one task ({{runtime}}).'));
    ok(r('b', 'codex', 'gpt-6-luna', 'Runs on {{harness}} with {{model}}.'));
  });
  test('naming its own harness or model (id, label, alias target) is fine', () => {
    ok(r('a', 'claude', 'opus', 'An Opus builder on Claude Code.'));
    ok(r('a', 'claude', 'opus', 'Runs claude-opus-5-5.'));
    ok(r('b', 'opencode', 'opencode-go/kimi-k3', 'Researcher on OpenCode using Kimi K3.'));
    ok(r('c', 'codex', 'gpt-6-luna', 'Mentions GPT-6 Luna and Codex.'));
  });
  test('mentioning own harness alongside another is fine (e.g. a comparison)', () => {
    ok(r('a', 'claude', 'sonnet', 'Like the Codex builder, but on Claude.'));
  });
  test('a resume with no pinned model is not compared to models; plain words and unknown names are ignored', () => {
    ok(r('a', 'claude', null, 'A builder, Opus-level quality.'));
    ok(r('b', 'codex', 'gpt-6-luna', 'Plain, simple jobs. Uses automatic judgement.')); // catalog id "plain" is not distinctive
    ok(r('c', 'claude', 'sonnet', 'Compatible with gpt-9-mystery style work.'));        // unknown model name
    ok(r('d', 'claude', 'sonnet', 'Uses the sonnetized pipeline.'));                      // not a word match
    ok(r('e', 'fake', 'x', 'Claude Opus codex'));                                         // the fake harness is never linted
  });
  test('resumeDescriptionDrift lists only the drifting slugs', () => {
    const list = resumeDescriptionDrift([r('good', 'claude', 'sonnet', '{{runtime}}'), r('bad', 'claude', 'sonnet', 'Opus builder')], CATALOGS);
    expect(list).toEqual([{ slug: 'bad', problems: ['names model opus but the resume runs sonnet'] }]);
  });
});

describe('the Doctor check', () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'sparrow-d1-res-'));
    const w = (slug: string, harness: string, model: string, desc: string) =>
      writeFileSync(join(d, `${slug}.md`), `---\nname: ${slug}\ntitle: ${slug}\ndescription: ${desc}\nharness: ${harness}\nmodel: ${model}\n---\nbody\n`);
    w('builder', 'claude', 'sonnet', 'Implements one task (Claude Code, Opus).');
    w('verifier', 'opencode', 'opencode-go/deepseek-v4.1-flash', 'Read-only reviewer (Codex).');
    w('tidy', 'claude', 'opus', 'Tidy ({{runtime}}).');
    return d;
  };

  test('warns with the drifting resumes and the {{runtime}} fix; passes when nothing drifts', async () => {
    const ctx = await setup({}, { resumeDirs: [dir()] });
    for (const c of CATALOGS) ctx.catalogs.put(c);
    const check = resumeDescriptionsCheck(ctx.core, ctx.catalogs);
    expect(check.id).toBe('resume-descriptions');
    const res = await check.run();
    expect(res.status).toBe('warn');
    expect(res.detail).toBe('builder: names model opus but the resume runs sonnet\nverifier: names Codex but runs on OpenCode');
    expect(res.fix).toContain('{{runtime}}');
    expect(res.fix).toContain('builder, verifier');
    expect(res.fix).not.toContain('tidy');

    const clean = await setup({}, { resumeDirs: [dir()] });
    for (const c of CATALOGS) clean.catalogs.put(c);
    clean.core.resumes.write('builder', { title: 'b', description: 'Implements ({{runtime}})', harness: 'claude', model: 'sonnet', effort: null, can_hire: [], limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: 'x' });
    clean.core.resumes.write('verifier', { title: 'v', description: 'Reviewer ({{runtime}})', harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: null, can_hire: [], limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: 'x' });
    expect((await resumeDescriptionsCheck(clean.core, clean.catalogs).run()).status).toBe('pass');
  });
});
