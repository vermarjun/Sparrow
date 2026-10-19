// D2: provider errors are classified, never nudged, announced once, counted per harness+provider; N in a row degrade it
// until a later success. Surfaces: GET /api/resumes (provider_health), GET /api/doctor (providers), SSE, `sparrow resumes`.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumesDirectory } from '../../src/cli/format';
import { classifyProviderError, ProviderTracker, providerOf } from '../../src/server/provider';
import type { ProviderHealth, ResumeView } from '../../src/shared/types';
import { agentOf, hire, makeResumesDir, resume, setup, type Ctx } from './helpers';

describe('classifyProviderError', () => {
  test('recognises the provider error screens of each harness', () => {
    const hits: [string, string][] = [
      ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'API Error: 500'],
      ['  ⎿  API Error: Connection error.', 'API Error: Connection error.'],
      ['Internal Server Error [retrying in 3s attempt #5]', 'Internal Server Error'],
      ['Error: Internal Server Error', 'Error: Internal Server Error'],
      ['Error: This API key has expired. Create a new API key in OpenCode Console.', 'This API key has expired'],
      ["You've hit your usage limit. Try again at 9:14 PM.", 'usage limit'],
      ['usage limit reached · resets 9:14 PM', 'usage limit reached'],
      ['Rate limit exceeded, retry later', 'Rate limit exceeded'],
      ['stream disconnected before completion: error sending request', 'stream disconnected'],
      ['unexpected status 401 Unauthorized: Invalid API key', 'unexpected status 401'],
      ['AI_APICallError: Internal Server Error', 'AI_APICallError'],
    ];
    for (const [text, part] of hits) expect([text, classifyProviderError(text)?.includes(part)]).toEqual([text, true]);
  });

  test('takes the error from the bottom of a screen, not from older output', () => {
    const screen = ['● Bash(bun test)', '  ⎿ 12 pass', ...Array(20).fill('doing things'), 'API Error: 529 overloaded_error', '❯ '].join('\n');
    expect(classifyProviderError(screen, 'screen')).toBe('API Error: 529 overloaded_error');
    const old = ['API Error: 500', ...Array(20).fill('recovered, all fine')].join('\n');
    expect(classifyProviderError(old, 'screen')).toBeNull();
  });

  test('ordinary prose and long final messages are not provider errors', () => {
    const prose = [
      'Added retries when it gets rate limited. Should I also add jitter?',
      'This maps 429 Too Many Requests to a RateLimitError.',
      'Internal Server Error was caused by a null deref; fixed it.',
      'Next I\'ll handle the `overloaded_error` type.',
      'API Error handling is done; want me to proceed?',
      'The error line `API Error: 500` should be parsed by the hook.',
      'Our toast says `AI_APICallError` for rate limits.',
      'Document `stream disconnected before completion` handling.',
      'A future OpenCode `API is overloaded` toast would retry.',
      'The `unexpected status 401` case returns a structured error.',
      'I added rate limiting to the login route and a test for the 429 path.',
      'Handled API errors and Internal Server Error responses in the client.',
      'Error: Internal Server Error keeps happening in the integration test, I added a retry.',
      'Rate limit exceeded, so I added exponential backoff with jitter.',
      "You've hit your usage limit, so I paused the crawl until tomorrow.",
      'unexpected status 500 came back from the endpoint, so I switched to the fallback.',
      'stream disconnected before completion, so I re-ran the request.',
      'AI_APICallError was the cause; I rotated the key and it worked.',
      '429 Too Many Requests, so I throttled the client.',
      'usage limit reached, so I trimmed the query.',
      'Error: Invalid API key, so I regenerated it in the console.',
      'exceeded retry limit, so I gave up on that batch and moved on.',
      'AI_APICallError: I will catch that in the wrapper next.',
      'unexpected status 500: the endpoint is flaky in CI.',
      'stream disconnected before completion: my websocket test is flaky.',
      '429 Too Many Requests: this is the fallback message we show.',
      'exceeded retry limit: I bumped the budget and re-ran.',
      'Error: Internal Server Error: reproduced on the staging box.',
      '- Error: Internal Server Error: see the logs for the full stack.',
      'API Error: 500 {this is not JSON}',
    ];
    for (const message of prose) expect([message, classifyProviderError(message)]).toEqual([message, null]);
    expect(classifyProviderError('API Error: boom\n' + 'x'.repeat(700))).toBeNull(); // long message = the agent's own prose
    expect(classifyProviderError('API Error: 500\nI recovered and continued.')).toBeNull(); // last_message must be one error line
    expect(classifyProviderError('')).toBeNull();
    expect(classifyProviderError(undefined)).toBeNull();
  });
});

describe('providerOf', () => {
  test('model prefix, else the harness', () => {
    expect(providerOf('opencode', 'opencode-go/kimi-k3')).toBe('opencode-go');
    expect(providerOf('opencode', 'anthropic/claude-x')).toBe('anthropic');
    expect(providerOf('opencode', null)).toBe('opencode');
    expect(providerOf('claude', 'sonnet')).toBe('claude');
    expect(providerOf('codex', 'gpt-6-luna')).toBe('codex');
  });
});

describe('ProviderTracker', () => {
  const min = 60_000;
  const mk = () => new ProviderTracker(() => 3, () => 15 * min);

  test('N consecutive errors inside the window degrade; one success recovers', () => {
    const t = mk();
    expect(t.error('opencode', 'opencode-go', 'e1', 0).health.degraded).toBe(false);
    expect(t.error('opencode', 'opencode-go', 'e2', 1 * min).health.degraded).toBe(false);
    const third = t.error('opencode', 'opencode-go', 'e3', 2 * min);
    expect(third.health).toMatchObject({ degraded: true, errors: 3, last_error: 'e3', degraded_since: 2 * min });
    expect(third.newlyDegraded).toBe(true);
    expect(t.error('opencode', 'opencode-go', 'e4', 3 * min).newlyDegraded).toBe(false);
    const ok = t.ok('opencode', 'opencode-go', 4 * min)!;
    expect(ok.recovered).toBe(true);
    expect(ok.health).toMatchObject({ degraded: false, errors: 0, degraded_since: null, last_ok_at: 4 * min });
    expect(t.ok('opencode', 'opencode-go', 5 * min)).toBeNull(); // nothing left to clear
  });

  test('errors older than the window do not count; a success in between resets the streak', () => {
    const t = mk();
    t.error('claude', 'claude', 'a', 0);
    t.error('claude', 'claude', 'b', 1 * min);
    expect(t.error('claude', 'claude', 'c', 30 * min).health).toMatchObject({ degraded: false, errors: 1 });
    t.error('claude', 'claude', 'd', 31 * min);
    t.ok('claude', 'claude', 32 * min);
    t.error('claude', 'claude', 'e', 33 * min);
    expect(t.error('claude', 'claude', 'f', 34 * min).health.degraded).toBe(false);
  });

  test('each harness+provider has its own streak', () => {
    const t = mk();
    for (let i = 0; i < 3; i++) t.error('opencode', 'opencode-go', 'x', i);
    expect(t.get('opencode', 'opencode-go')?.degraded).toBe(true);
    expect(t.get('opencode', 'anthropic')).toBeNull();
    expect(t.list().map((p) => p.provider)).toEqual(['opencode-go']);
  });
});

// ---------------------------------------------------------------- server

async function withModelResume() {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-d2-res-'));
  writeFileSync(join(dir, 'ocgo.md'), resume('ocgo', 'opencode', 'model: opencode-go/kimi-k3\n'));
  writeFileSync(join(dir, 'ocplain.md'), resume('ocplain', 'opencode'));
  return setup({}, { resumeDirs: [dir, makeResumesDir()] });
}
const turnEnd = (ctx: Ctx, id: string, body: Record<string, unknown> = {}) =>
  ctx.req('POST', '/api/hooks/turn-end', { harness: agentOf(ctx, id).harness, ...body }, id, agentOf(ctx, id).call_id);
const notices = (ctx: Ctx) => ctx.store.listMessages({ limit: 500 }).filter((m) => m.kind === 'system');

describe('turn end on a provider error', () => {
  for (const slug of ['builder', 'builder-codex', 'researcher', 'fake']) {
    test(`${slug}: "API Error" last message → no nudge, call ends provider_error, one notice to the parent`, async () => {
      const ctx = await setup();
      const a = await hire(ctx, slug, 'x', { name: 'iris' });
      const r = await turnEnd(ctx, a.id, { last_message: 'API Error: 500 Internal Server Error' });
      expect(r.body).toEqual({ action: 'allow' });
      await ctx.clock.advance(5000);
      expect(ctx.sp.delivers).toEqual([]);                       // nothing typed into the window
      expect(ctx.store.callsFor(a.id)[0].nudges).toBe(0);
      expect(agentOf(ctx, a.id)).toMatchObject({ state: 'idle', last_end_reason: 'provider_error' });
      const n = notices(ctx);
      expect(n.length).toBe(1);
      expect(n[0].text).toContain(`@iris: model provider error (${agentOf(ctx, a.id).harness} API Error: 500 Internal Server Error); message it to retry.`);
      expect(ctx.store.countWaking(ctx.captain.id)).toBe(1);
    });
  }

  test('the same turn without an error is still nudged (no regression)', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    expect((await turnEnd(ctx, a.id, { last_message: 'thinking out loud about rate limiting' })).body).toEqual({ action: 'block', reason: expect.stringContaining('You stopped without reporting') });
    expect(notices(ctx)).toEqual([]);
  });

  test('error screen with no assistant message is found on the live screen', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder-codex', 'x');
    ctx.sp.screens.set(a.id, ['▌ working', '■ unexpected status 401 Unauthorized: Invalid API key', ''].join('\n'));
    const r = await turnEnd(ctx, a.id, {});
    expect(r.body).toEqual({ action: 'allow' });
    expect(agentOf(ctx, a.id).last_end_reason).toBe('provider_error');
    expect(notices(ctx)[0].text).toContain('unexpected status 401');
  });

  test('assistant text prevents provider classification from falling back to an error screen', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder-codex', 'x');
    ctx.sp.screens.set(a.id, ['▌ working', '■ API Error: 500', ''].join('\n'));
    const r = await turnEnd(ctx, a.id, { last_message: 'API Error: 500\nRecovered; moving on.' });
    expect(r.body).toEqual({ action: 'none' });
    expect(ctx.store.callsFor(a.id)[0].nudges).toBe(1);
    expect(agentOf(ctx, a.id)).toMatchObject({ state: 'working', last_end_reason: null });
    expect(notices(ctx)).toEqual([]);
  });

  test('plugin-reported error (hook) then the turn end: counted and announced once, not nudged', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'researcher', 'x', { name: 'iris', model: 'opencode-go/kimi-k3' });
    const h1 = await ctx.req('POST', '/api/hooks/provider-error', { harness: 'opencode', message: 'HTTP 500 Internal Server Error' }, a.id, agentOf(ctx, a.id).call_id);
    expect(h1.body).toEqual({ ok: true });
    await ctx.req('POST', '/api/hooks/provider-error', { harness: 'opencode', message: 'HTTP 500 Internal Server Error' }, a.id, agentOf(ctx, a.id).call_id); // OpenCode repeats it
    expect(agentOf(ctx, a.id).state).toBe('working'); // the call stays open until the turn ends
    const r = await turnEnd(ctx, a.id, {});
    await ctx.clock.advance(5000);
    expect(r.body).toEqual({ action: 'allow' });
    expect(ctx.sp.delivers).toEqual([]);
    expect(agentOf(ctx, a.id).last_end_reason).toBe('provider_error');
    expect(notices(ctx).map((m) => m.text)).toEqual(['@iris: model provider error (opencode-go HTTP 500 Internal Server Error); message it to retry.']);
    expect(ctx.core.providers.get('opencode', 'opencode-go')?.errors).toBe(1);
  });

  test('a parent message waiting at the error turn is delivered (that is the retry), not dropped', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'try again please' }, ctx.captain.id);
    const r = await turnEnd(ctx, a.id, { last_message: 'API Error: 500' });
    expect(r.body.action).toBe('block');
    expect(r.body.reason).toContain('try again please');
    expect(agentOf(ctx, a.id).state).toBe('working');
  });

  test('a message to the errored agent starts a new call on the same session (retry works)', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x');
    await turnEnd(ctx, a.id, { session_id: 'sess-1', last_message: 'API Error: 500' });
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'retry' }, ctx.captain.id);
    await ctx.clock.advance(1000);
    expect(agentOf(ctx, a.id).state).toBe('working');
    expect(ctx.sp.startsFor(a.id).length).toBe(2);
  });
});

describe('degraded harness + provider', () => {
  const fail = async (ctx: Ctx, slug: string, extra: Record<string, unknown> = {}) => {
    const a = await hire(ctx, slug, 'x', extra);
    await turnEnd(ctx, a.id, { last_message: 'API Error: 500 Internal Server Error' });
    return a;
  };

  test('3 errors in a row degrade opencode-go (resume view, doctor, notice, SSE); an update from a success recovers it', async () => {
    const ctx = await withModelResume();
    const view = async (slug: string) => (await ctx.req('GET', `/api/resumes/${slug}`)).body as ResumeView;
    expect((await view('ocgo')).provider).toBe('opencode-go');
    expect((await view('ocgo')).provider_health).toBeNull();

    await fail(ctx, 'ocgo'); await fail(ctx, 'ocgo');
    expect((await view('ocgo')).provider_health).toBeNull();
    const third = await fail(ctx, 'ocgo');

    const ph = (await view('ocgo')).provider_health!;
    expect(ph).toMatchObject({ harness: 'opencode', provider: 'opencode-go', degraded: true, errors: 3, last_error: 'API Error: 500 Internal Server Error' });
    expect((await view('ocplain')).provider_health).toBeNull();      // another provider of the same harness is unaffected
    expect((await view('builder')).provider_health).toBeNull();      // another harness is unaffected
    const doc = (await ctx.req('GET', '/api/doctor')).body;
    expect(doc.providers).toEqual([expect.objectContaining({ harness: 'opencode', provider: 'opencode-go', degraded: true })]);
    expect(notices(ctx).at(-1)!.text).toContain('opencode/opencode-go is now marked degraded');
    expect(notices(ctx).slice(0, 2).every((m) => !m.text.includes('degraded'))).toBe(true);
    expect(ctx.events.some((e) => e.type === 'provider.updated' && e.providers[0]?.degraded)).toBe(true);
    expect(ctx.events.some((e) => e.type === 'resume.updated' && e.resume.slug === 'ocgo' && e.resume.provider_health?.degraded)).toBe(true);

    // Hiring is not blocked; a later successful call (any agent on that provider) recovers it.
    const ok = await hire(ctx, 'ocgo', 'y');
    await ctx.req('POST', '/api/update', { text: 'working fine' }, ok.id, agentOf(ctx, ok.id).call_id);
    expect((await view('ocgo')).provider_health).toBeNull();
    expect((await ctx.req('GET', '/api/doctor')).body.providers[0]).toMatchObject({ degraded: false, errors: 0 });
    expect(third.id).not.toBe(ok.id);
  });

  test('a clean turn end and a done also count as success', async () => {
    const ctx = await withModelResume();
    for (const how of ['turn-end', 'done']) {
      for (let i = 0; i < 3; i++) await fail(ctx, 'ocgo');
      expect(ctx.core.providers.get('opencode', 'opencode-go')?.degraded).toBe(true);
      const a = await hire(ctx, 'ocgo', 'y');
      if (how === 'turn-end') await turnEnd(ctx, a.id, { last_message: 'all good, carrying on' });
      else await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, agentOf(ctx, a.id).call_id);
      expect([how, ctx.core.providers.get('opencode', 'opencode-go')?.degraded]).toEqual([how, false]);
    }
  });

  test('errors spread over more than the window never degrade; the thresholds come from settings', async () => {
    const ctx = await withModelResume();
    await fail(ctx, 'ocgo');
    await ctx.clock.advance(16 * 60_000);
    await fail(ctx, 'ocgo'); await fail(ctx, 'ocgo');
    expect(ctx.core.providers.get('opencode', 'opencode-go')).toMatchObject({ degraded: false, errors: 2 });
    const strict = await setup({ provider_error_threshold: 1 });
    await fail(strict, 'builder');
    expect(strict.core.providers.get('claude', 'claude')?.degraded).toBe(true);
  });
});

describe('`sparrow resumes` status line', () => {
  const base = { slug: 'researcher', title: 'Researcher', description: 'Finds things.', harness: 'opencode', model: 'opencode-go/kimi-k3', effort: 'low', can_hire: [], status: 'ok', status_detail: null, resolved_model: null } as unknown as ResumeView;
  test('shows DEGRADED with the provider, error count and last error; a healthy resume is unchanged', () => {
    const ph: ProviderHealth = { harness: 'opencode', provider: 'opencode-go', degraded: true, errors: 3, last_error: 'This API key has expired.', last_error_at: Date.now() - 120_000, last_ok_at: null, degraded_since: Date.now() - 120_000 };
    const text = resumesDirectory([{ ...base, provider: 'opencode-go', provider_health: ph }]);
    expect(text).toContain('status: ok · DEGRADED: 3 provider errors in a row on opencode-go (last: This API key has expired., 2m ago)');
    expect(resumesDirectory([{ ...base, provider: 'opencode-go', provider_health: null }])).not.toContain('DEGRADED');
    expect(resumesDirectory([base])).not.toContain('DEGRADED'); // an older server without the field
  });
});
