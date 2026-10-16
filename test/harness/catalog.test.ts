// Catalog parsing against output captured from the real CLIs (test/fixtures/catalog, 17 Oct 2026:
// claude 2.1.302, codex 0.163.0, opencode 1.19.0) + the cheapest-model rule + the spawn environment.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cheapestModel, claudeSeeds, initModel, parseClaudeEfforts, parseCodexModels, parseOpencodeModels, spawnEnv,
} from '../../src/harness/catalog';
import type { HarnessCatalog } from '../../src/shared/types';

const fx = (f: string) => readFileSync(join(import.meta.dir, '..', 'fixtures', 'catalog', f), 'utf8');
const cat = (harness: HarnessCatalog['harness'], models: HarnessCatalog['models']): HarnessCatalog =>
  ({ harness, ok: true, error: null, version: '1', binary: '/x', models, fetched_at: 1 });

describe('claude', () => {
  test('efforts come from the --effort entry of --help (wrapped onto the next line)', () => {
    expect(parseClaudeEfforts(fx('claude-help.txt'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parseClaudeEfforts('  --effort <level>   Effort level\n        (low, high)\n')).toEqual(['low', 'high']);
    expect(parseClaudeEfforts('no such flag')).toEqual([]);
  });

  test('seeds = four aliases + additionalModelOptionsCache from ~/.claude.json', () => {
    const s = claudeSeeds(fx('claude.json'));
    expect(s.map((x) => x.alias)).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1[1m]']);
    expect(s[4].label).toBe('Fable');
    expect(claudeSeeds(null).length).toBe(4);
    expect(claudeSeeds('{not json').length).toBe(4);
  });

  test('init line → resolved model id; other lines → null', () => {
    expect(initModel(fx('claude-init.jsonl').trim())).toBe('claude-sonnet-5-5');
    expect(initModel('{"type":"system","subtype":"hook_started"}')).toBeNull();
    expect(initModel('garbage "init"')).toBeNull();
  });

  test('cheapest = haiku (alias, else any model resolving to a haiku id)', () => {
    const m = (id: string, to: string) => ({ id, label: id, efforts: ['low', 'max'], default_effort: null, hidden: false, cost: null, resolves_to: to, description: null });
    expect(cheapestModel(cat('claude', [m('opus', 'claude-opus-5-5'), m('haiku', 'claude-haiku-5-5')]))).toEqual({ model: 'haiku', effort: 'low' });
    expect(cheapestModel(cat('claude', [m('opus', 'claude-opus-5-5'), m('small', 'claude-haiku-5-5')]))).toEqual({ model: 'small', effort: 'low' });
    expect(cheapestModel(cat('claude', [m('opus', 'claude-opus-5-5')]), { claude: 'opus' })).toEqual({ model: 'opus', effort: 'low' });
  });
});

describe('codex', () => {
  const models = parseCodexModels(fx('codex-models.json'));

  test('debug models → per-model efforts, default, hidden last, priority order', () => {
    expect(models.length).toBe(9);
    const sol = models.find((m) => m.id === 'gpt-6.1-sol')!;
    expect(sol.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(sol.default_effort).toBe('low');
    expect(sol.label).toBe('GPT-6.1-Sol');
    expect(models.find((m) => m.id === 'gpt-6-luna')!.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(models.filter((m) => m.hidden).map((m) => m.id)).toEqual(['gpt-reserve', 'codex-auto-review']);
    expect(models.slice(-2).every((m) => m.hidden)).toBe(true);
    expect(models[0].id).toBe('gpt-6.1-sol');
  });

  test('cheapest = visible "affordable" model, lowest priority first, lowest effort', () => {
    expect(cheapestModel(cat('codex', models))).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    // no "affordable": fall back to fast|efficient
    const noAff = models.map((m) => ({ ...m, description: (m.description ?? '').replace(/affordable/gi, 'cheap') }));
    expect(cheapestModel(cat('codex', noAff))).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(() => parseCodexModels('{"nope":1}')).toThrow(/models/);
  });
});

describe('opencode', () => {
  const models = parseOpencodeModels(fx('opencode-models-verbose.txt'));

  test('models --verbose → 40 models with cost and effort variants (lowest first)', () => {
    expect(models.length).toBe(40);
    const kimi = models.find((m) => m.id === 'opencode-go/kimi-k3')!;
    expect(kimi.cost).toEqual({ input: 3, output: 15 });
    expect(kimi.efforts).toEqual(['max']);
    expect(models.find((m) => m.id === 'opencode-go/glm-5.3')!.efforts).toEqual(['low', 'high', 'max']);
    expect(models.find((m) => m.id === 'opencode-go/kimi-k2.7-code')!.efforts).toEqual([]);
    expect(models.find((m) => m.id === 'opencode-go/gpt-6-luna')!.efforts[0]).toBe('none');
    expect(models.some((m) => m.id === 'opencode-go/deepseek-v4-flash')).toBe(false); // the dead id from the acceptance runs
  });

  test('cheapest = active, paid (cost > 0), lowest input+output, no preview ids', () => {
    const c = cheapestModel(cat('opencode', models))!;
    expect(c.model).toBe('opencode-go/muse-spark-1.2-contributor');
    expect(c.effort).toBe('minimal');
    const m = (id: string, i: number, o: number, extra = {}) => ({ id, label: id, efforts: [], default_effort: null, hidden: false, cost: { input: i, output: o }, resolves_to: null, description: null, ...extra });
    expect(cheapestModel(cat('opencode', [m('a/free', 0, 0), m('a/x-preview', 0.01, 0.01), m('a/old', 0.01, 0.01, { hidden: true }), m('a/ok', 1, 1)]))).toEqual({ model: 'a/ok', effort: null });
  });

  test('ANSI and noise lines are ignored', () => {
    const out = parseOpencodeModels('\x1b[0mwarning\nprov/m1\n{"name":"M1","status":"active","cost":{"input":1,"output":2},"variants":{"high":{},"low":{}}}\n');
    expect(out).toEqual([{ id: 'prov/m1', label: 'M1', efforts: ['low', 'high'], default_effort: null, hidden: false, cost: { input: 1, output: 2 }, resolves_to: null, description: null }]);
  });
});

test('failed catalogs have no cheapest model', () => {
  expect(cheapestModel({ ...cat('codex', []), ok: false })).toBeNull();
});

test('spawnEnv scrubs session identity and harness vars, keeps config homes, sets OPENCODE_CONFIG_DIR', () => {
  const env = spawnEnv('opencode', {
    PATH: '/usr/bin', HOME: '/h', CLAUDECODE: '1', CODEX_SANDBOX: 'x', CODEX_HOME: '/ch', OPENCODE_SERVER: 'y', SPARROW_AGENT_ID: 'ag_1', SPARROW_CALL_ID: 'c',
  });
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CODEX_SANDBOX).toBeUndefined();
  expect(env.OPENCODE_SERVER).toBeUndefined();
  expect(env.SPARROW_AGENT_ID).toBeUndefined();
  expect(env.SPARROW_CALL_ID).toBeUndefined();
  expect(env.CODEX_HOME).toBe('/ch');
  expect(env.OPENCODE_CONFIG_DIR).toMatch(/\/opencode$/);
  expect(env.PATH.endsWith(':/usr/bin')).toBe(true);
  expect(env.PATH.split(':')[0]).toMatch(/\/bin$/);
});
