import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/main';
import { gitRoot } from '../../src/server/core';
import { agentOf, flush, hire, setup, type Ctx } from './helpers';

let ctx: Ctx;
afterEach(() => { ctx?.core.stop(); ctx?.store.close(); });

// Exercise the real CLI/client and Hono routes without launching subprocesses or models.
async function cli(args: string[], id = ctx.captain.id) {
  const env = { ...process.env };
  const fetch0 = globalThis.fetch;
  const stdout: string[] = [], stderr: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...s) => { stdout.push(s.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...s) => { stderr.push(s.join(' ')); });
  process.env.SPARROW_AGENT_ID = id;
  delete process.env.SPARROW_AGENT_URL;
  delete process.env.SPARROW_CALL_ID;
  globalThis.fetch = ((url: any, init: any) => ctx.app.request(new URL(String(url)).pathname + new URL(String(url)).search, init)) as typeof fetch;
  try { return { code: await main(args), stdout: stdout.join('\n'), stderr: stderr.join('\n') }; }
  finally { globalThis.fetch = fetch0; log.mockRestore(); error.mockRestore(); process.env = env; }
}

async function result() {
  const a = await hire(ctx, 'builder', 'child task');
  await ctx.req('POST', '/api/done', { summary: 'unique child result' }, a.id);
  return a;
}

test('send with stdout discarded leaves child result pending and stderr notices; inbox reads once', async () => {
  ctx = await setup();
  const a = await result();
  const sent = await cli(['send', '@' + a.handle, 'hi']);
  expect(sent.code).toBe(0);
  expect(sent.stderr).toContain('1 unread for @captain: @' + a.handle + ' result(ok)');
  expect(ctx.store.countPending(ctx.captain.id)).toBe(1);
  const read = await cli(['inbox']);
  expect(read.stdout).toContain('unique child result');
  expect(ctx.store.countPending(ctx.captain.id)).toBe(0);
  expect((await cli(['inbox'])).stdout).not.toContain('unique child result');
});

test('roster --json stays an array and leaves DM pending', async () => {
  ctx = await setup();
  const a = await hire(ctx, 'builder', 'task');
  await ctx.req('POST', '/api/send', { to: '@captain', text: 'unread DM' }, a.id);
  const res = await cli(['roster', '--json']);
  expect(Array.isArray(JSON.parse(res.stdout))).toBe(true);
  expect(res.stderr).toContain('1 unread');
  expect(ctx.store.countPending(ctx.captain.id)).toBe(1);
});

test('worker done refuses without consuming DM; explicit inbox permits done', async () => {
  ctx = await setup();
  const a = await hire(ctx, 'builder', 'task');
  await ctx.req('POST', '/api/send', { to: '@' + a.handle, text: 'read me' }, ctx.captain.id);
  const refused = await cli(['done', 'first', '--json'], a.id);
  expect(JSON.parse(refused.stdout).ended).toBe(false);
  expect(JSON.parse(refused.stdout).unread).toHaveLength(1);
  expect(ctx.store.countPending(a.id)).toBe(1);
  expect((await cli(['inbox'], a.id)).stdout).toContain('read me');
  expect(JSON.parse((await cli(['done', 'second', '--json'], a.id)).stdout).ended).toBe(true);
});

test('Claude aborted turn-end leaves DM pending; retry blocks with the DM', async () => {
  ctx = await setup();
  const a = await hire(ctx, 'builder', 'task');
  await ctx.req('POST', '/api/send', { to: '@' + a.handle, text: 'pending DM' }, ctx.captain.id);
  const abort = new AbortController();
  ctx.sp.capture = async () => { abort.abort(); return ''; };
  expect(await ctx.core.turnEnd(agentOf(ctx, a.id), null, { harness: 'claude' }, abort.signal)).toEqual({ action: 'allow' });
  expect(ctx.store.countPending(a.id)).toBe(1);
  const retry = await ctx.core.turnEnd(agentOf(ctx, a.id), null, { harness: 'claude', last_message: 'finished' });
  expect(retry.action).toBe('block');
  expect(retry.reason).toContain('pending DM');
  expect(ctx.store.countPending(a.id)).toBe(0);
});

test('Bun/Hono POST request signal aborts on client disconnect during turn-end', async () => {
  ctx = await setup();
  const a = await hire(ctx, 'builder', 'task');
  await ctx.req('POST', '/api/send', { to: '@' + a.handle, text: 'retry me' }, ctx.captain.id);
  let entered!: () => void, release!: () => void, finished!: () => void;
  const entering = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const finishing = new Promise<void>((r) => { finished = r; });
  ctx.sp.capture = async () => { entered(); await gate; return ''; };
  let signal: AbortSignal | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    signal = req.signal;
    try { return await ctx.app.fetch(req); } finally { finished(); }
  } });
  const abort = new AbortController();
  try {
    const request = fetch(new URL('/api/hooks/turn-end', server.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-sparrow-agent': a.id }, body: JSON.stringify({ harness: 'claude' }), signal: abort.signal }).catch(() => null);
    await entering;
    const aborted = new Promise<void>((r) => signal!.addEventListener('abort', () => r(), { once: true }));
    abort.abort();
    await Promise.race([aborted, Bun.sleep(1000).then(() => { throw new Error('POST signal did not abort'); })]);
    expect(signal!.aborted).toBe(true);
    release();
    await finishing;
    await request;
    expect(ctx.store.countPending(a.id)).toBe(1);
    const retry = await ctx.req('POST', '/api/hooks/turn-end', { harness: 'claude', last_message: 'done' }, a.id);
    expect(retry.body.reason).toContain('retry me');
  } finally { release(); server.stop(true); }
});

for (const mode of ['reject', 'invalidated'] as const) test(`Codex delayed paste ${mode} rolls deliveries back to pending`, async () => {
  ctx = await setup();
  const a = await hire(ctx, 'builder-codex', 'task');
  await ctx.req('POST', '/api/send', { to: '@' + a.handle, text: 'paste me' }, ctx.captain.id);
  await ctx.core.turnEnd(agentOf(ctx, a.id), null, { harness: 'codex', last_message: 'stopping' });
  expect(ctx.store.countPending(a.id)).toBe(0);
  if (mode === 'reject') ctx.sp.deliver = async () => { throw new Error('paste failed'); };
  else await ctx.req('POST', '/api/done', { summary: 'done before timer' }, a.id);
  if (mode === 'invalidated') ctx.core.settings.max_running = 0; // observe rollback before the retry envelope starts
  await ctx.clock.advance(1000);
  expect(ctx.store.countPending(a.id)).toBe(1);
  if (mode === 'reject') expect(ctx.logs.some((l) => l.includes('paste failed'))).toBe(true);
  else {
    expect(agentOf(ctx, a.id).state).toBe('queued');
    ctx.core.settings.max_running = 6;
    ctx.core.settingsChanged();
    await flush();
    expect(ctx.sp.startsFor(a.id).at(-1)!.prompt).toContain('paste me');
    expect(ctx.store.countPending(a.id)).toBe(0);
  }
});

test('spawn failure restores task; next DM envelope contains original task and DM', async () => {
  ctx = await setup();
  ctx.sp.failStart = 'launch failed';
  const a = await hire(ctx, 'builder', 'original task');
  expect(agentOf(ctx, a.id).state).toBe('crashed');
  expect(ctx.store.countPending(a.id)).toBe(1);
  ctx.sp.failStart = null;
  await ctx.req('POST', '/api/send', { to: '@' + a.handle, text: 'retry DM' }, ctx.captain.id);
  await flush();
  expect(ctx.sp.startsFor(a.id)[1].prompt).toContain('original task');
  expect(ctx.sp.startsFor(a.id)[1].prompt).toContain('retry DM');
  expect(ctx.store.countPending(a.id)).toBe(0);
});

test('captain registration leaves result unread; loop takes once; foreground send does not steal from wait', async () => {
  ctx = await setup();
  const a = await result();
  const reg = await ctx.req('POST', '/api/captains/register', { cwd: ctx.root });
  expect(reg.body.inbox).toEqual([]);
  expect(reg.body.unread).toHaveLength(1);
  const first = await ctx.req('GET', '/api/inbox?wait=30', undefined, ctx.captain.id);
  expect(first.body.inbox[0].text).toBe('unique child result');
  expect((await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox).toEqual([]);
  const waiting = ctx.req('GET', '/api/inbox?wait=30', undefined, ctx.captain.id);
  await ctx.req('POST', '/api/send', { to: '@' + a.handle, text: 'followup' }, ctx.captain.id);
  await flush();
  await ctx.req('POST', '/api/done', { summary: 'second result' }, a.id);
  expect((await waiting).body.inbox[0].text).toBe('second result');
  expect(ctx.store.countPending(ctx.captain.id)).toBe(0);
});

test('registered ancestor yields to unrelated git worktree but retains same-repo and non-git roots', async () => {
  ctx = await setup({}, { detectRoot: gitRoot });
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'sp-ancestor-')));
  const home = join(temp, 'home'), b = join(temp, 'code', 'b'), wt = join(home, 'trees', 'b-feat');
  mkdirSync(home, { recursive: true }); mkdirSync(b, { recursive: true });
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe' });
    if (r.exitCode) throw new Error(r.stderr.toString());
  };
  for (const root of [home, b]) {
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  await ctx.req('POST', '/api/captains/register', { cwd: home });
  git(b, 'worktree', 'add', '-q', '-b', 'feat', wt);
  mkdirSync(join(wt, 'sub')); mkdirSync(join(home, 'own'));
  expect(ctx.core.projectRootFor(wt)).toBe(b);
  expect(ctx.core.projectRootFor(join(wt, 'sub'))).toBe(b);
  expect(ctx.core.projectRootFor(join(home, 'own'))).toBe(home);
  // A more specific registered directory inside A remains the chosen project.
  ctx.store.insertProject({ id: 'own', name: 'own', root: join(home, 'own'), created_at: Date.now() });
  mkdirSync(join(home, 'own', 'sub'));
  expect(ctx.core.projectRootFor(join(home, 'own', 'sub'))).toBe(join(home, 'own'));
  mkdirSync(join(ctx.root, 'plain'));
  expect(ctx.core.projectRootFor(join(ctx.root, 'plain'))).toBe(ctx.root);
});
