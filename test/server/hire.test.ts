import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitRoot } from '../../src/server/core';
import { cardKey } from '../../src/shared/cards';
import { agentOf, flush, hire, setup } from './helpers';

describe('register captain', () => {
  test('idempotent per project root; same basename different root gets -2', async () => {
    const ctx = await setup();
    const again = await ctx.req('POST', '/api/captains/register', { cwd: ctx.root });
    expect(again.status).toBe(200);
    expect(again.body.agent.id).toBe(ctx.captain.id);
    expect(again.body.agent.kind).toBe('human');
    expect(again.body.agent.handle).toBe('captain');
    expect(again.body.agent.can_hire).toEqual(['*']);
    expect(again.body.inbox).toEqual([]);
    const a = mkdtempSync(join(tmpdir(), 'sp-a-'));
    const b = mkdtempSync(join(tmpdir(), 'sp-b-'));
    mkdirSync(join(a, 'plutus')); mkdirSync(join(b, 'plutus'));
    const p1 = await ctx.req('POST', '/api/captains/register', { cwd: join(a, 'plutus') });
    const p2 = await ctx.req('POST', '/api/captains/register', { cwd: join(b, 'plutus') });
    expect(p1.body.project.id).toBe('plutus');
    expect(p2.body.project.id).toBe('plutus-2');
    expect(p1.body.agent.id).not.toBe(p2.body.agent.id);
  });

  test('gitRoot finds the repo toplevel; a linked worktree belongs to the main checkout (real git)', () => {
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    };
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'sp-git-')));
    git(main, 'init', '-q');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(join(main, 'src', 'deep'), { recursive: true });
    expect(gitRoot(join(main, 'src', 'deep'))).toBe(main);
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), 'sp-wt-'))), 'feat1');
    git(main, 'worktree', 'add', '-q', '-b', 'feat1', wt);
    mkdirSync(join(wt, 'src'), { recursive: true });
    expect(gitRoot(wt)).toBe(main);
    expect(gitRoot(join(wt, 'src'))).toBe(main);
    const plain = mkdtempSync(join(tmpdir(), 'sp-nogit-'));
    expect(gitRoot(plain)).toBe(plain);
  });

  test('unknown agent id → 401', async () => {
    const ctx = await setup();
    const r = await ctx.req('GET', '/api/whoami', undefined, 'ag_NOPE');
    expect(r.status).toBe(401);
    expect(r.body.error).toContain('Unknown agent id');
  });
});

describe('hire guards', () => {
  test('agent without can_hire gets 403 with the exact message', async () => {
    const ctx = await setup();
    const b = await hire(ctx, 'builder', 'x');
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y' }, b.id);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(`@${b.handle} (builder) may not hire builder: can_hire = []`);
  });

  test('human captain may hire anything; sub-captain only its can_hire', async () => {
    const ctx = await setup();
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const bad = await ctx.req('POST', '/api/hire', { resume: 'researcher', task: 'y' }, sc.id);
    expect(bad.status).toBe(403);
    expect(bad.body.error).toContain('can_hire = [builder, fake]');
    const ok = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y' }, sc.id);
    expect(ok.status).toBe(200);
    expect(ok.body.agent.depth).toBe(2);
    expect(ok.body.agent.parent_id).toBe(sc.id);
  });

  test('depth > max_depth refused', async () => {
    const ctx = await setup({ max_depth: 1 });
    const sc = await hire(ctx, 'sub-captain', 'lead');
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y' }, sc.id);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('max_depth is 1');
  });

  test('unknown resume → 404 listing slugs', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/hire', { resume: 'wizard', task: 'y' }, ctx.captain.id);
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('builder, builder-codex, fake, researcher, sub-captain');
  });

  test('duplicate name → 409; invalid name → 400; reserved → 400', async () => {
    const ctx = await setup();
    await hire(ctx, 'builder', 'x', { name: 'Bob' });
    const dup = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y', name: 'bob' }, ctx.captain.id);
    expect(dup.status).toBe(409);
    const bad = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y', name: '9lives' }, ctx.captain.id);
    expect(bad.status).toBe(400);
    const res = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y', name: 'group' }, ctx.captain.id);
    expect(res.status).toBe(400);
  });

  test('auto-names follow the friendly list, skipping used ones', async () => {
    const ctx = await setup({ max_running: 10 });
    const a = await hire(ctx, 'builder', 'x');
    await hire(ctx, 'builder', 'x', { name: 'leo' });
    const b = await hire(ctx, 'builder', 'x');
    const c = await hire(ctx, 'builder', 'x');
    expect([a.handle, b.handle, c.handle]).toEqual(['james', 'maya', 'iris']);
  });

  test('missing cwd → 400', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'y', cwd: '/definitely/not/here' }, ctx.captain.id);
    expect(r.status).toBe(400);
  });
});

describe('hire → start call', () => {
  test('different model and effort overrides are recorded in task metadata and server log', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/hire', {
      resume: 'builder', task: 'Build it', model: 'opus', effort: 'high',
    }, ctx.captain.id);
    expect(r.status).toBe(200);
    expect(r.body.message.meta.override).toEqual({
      model: { resume: 'haiku', used: 'opus' },
      effort: { resume: 'low', used: 'high' },
    });
    expect(ctx.logs.some((line) => line.includes('OVERRIDE model haiku→opus (resume builder)'))).toBe(true);
    expect(ctx.logs.some((line) => line.includes('OVERRIDE effort low→high (resume builder)'))).toBe(true);
  });

  test('an explicitly passed resume model does not count as an override', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'Build it', model: 'haiku' }, ctx.captain.id);
    expect(r.status).toBe(200);
    expect(r.body.message.meta).not.toHaveProperty('override');
    expect(ctx.logs.some((line) => line.includes('OVERRIDE'))).toBe(false);
  });

  test('omitting model and effort does not count as an override', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'Build it' }, ctx.captain.id);
    expect(r.status).toBe(200);
    expect(r.body.message.meta).not.toHaveProperty('override');
    expect(ctx.logs.some((line) => line.includes('OVERRIDE'))).toBe(false);
  });

  test('free slot: start once, resume:false, envelope has the task, working, call row, delivery delivered', async () => {
    const ctx = await setup();
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'Build the login page' }, ctx.captain.id);
    expect(r.status).toBe(200);
    expect(r.body.agent.state).toBe('working'); // slot reserved before the response; the window opens in the background
    await flush();
    const a = agentOf(ctx, r.body.agent.id);
    expect(a.state).toBe('working');
    expect(a.tmux_session).toBe(`sptest-${ctx.store.getProject(a.project_id)!.id}`);
    expect(a.tmux_window).toBe(a.handle);
    expect(a.tmux_window_id).toBe('@1');
    expect(a.session_id).toBe('sess-1');
    expect(a.model).toBe('haiku');
    expect(ctx.sp.starts.length).toBe(1);
    const s = ctx.sp.starts[0];
    expect(s.resume).toBe(false);
    expect(s.prompt).toContain('Build the login page');
    expect(s.prompt).toContain(`[sparrow] 1 new message for @${a.handle}`);
    expect(s.prompt).toContain('── task from @captain · 14:02 ──');
    expect(s.system_prompt).toContain('# Your role');
    expect(s.system_prompt).toContain('You are the builder.');
    expect(s.system_prompt).toContain(`@${a.handle}`);
    const calls = ctx.store.callsFor(a.id);
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe(a.call_id!);
    expect(calls[0].prompt).toBe(s.prompt);
    const d = ctx.store.deliveriesFor(r.body.message.id);
    expect(d).toEqual([expect.objectContaining({ to_id: a.id, state: 'delivered', call_id: a.call_id })]);
    expect(r.body.message.kind).toBe('task');
    expect(r.body.message.thread_label).toBe(`dm @captain ↔ @${a.handle}`);
  });

  test('--cwd, --tmux-session, --tmux-window honoured and reused on respawn', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'builder', 'x', { cwd: join(ctx.root, 'sub'), tmux_session: 'mysess', tmux_window: 'mywin' });
    expect(a.cwd).toBe(join(ctx.root, 'sub'));
    expect(ctx.sp.starts[0].agent.tmux_session).toBe('mysess');
    expect(ctx.sp.starts[0].agent.tmux_window).toBe('mywin');
    await ctx.req('POST', '/api/done', { summary: 'ok' }, a.id, a.call_id);
    await ctx.req('POST', '/api/send', { to: `@${a.handle}`, text: 'again' }, ctx.captain.id);
    const s2 = ctx.sp.starts[1];
    expect(s2.resume).toBe(true);
    expect(s2.agent.cwd).toBe(join(ctx.root, 'sub'));
    expect(s2.agent.tmux_session).toBe('mysess');
    expect(s2.agent.tmux_window).toBe('mywin');
  });

  test('max_running reached → queued; oldest queued starts when a call ends', async () => {
    const ctx = await setup({ max_running: 1 });
    const a = await hire(ctx, 'builder', 'first');
    const b = await hire(ctx, 'builder', 'second');
    const c = await hire(ctx, 'builder', 'third');
    expect(agentOf(ctx, a.id).state).toBe('working');
    expect(b.state).toBe('queued');
    expect(c.state).toBe('queued');
    expect(ctx.sp.starts.length).toBe(1);
    const r = await ctx.req('POST', '/api/done', { summary: 'done 1' }, a.id, agentOf(ctx, a.id).call_id);
    expect(r.body.ended).toBe(true);
    expect(agentOf(ctx, b.id).state).toBe('working');
    expect(agentOf(ctx, c.id).state).toBe('queued');
    expect(ctx.sp.starts.length).toBe(2);
    expect(ctx.sp.starts[1].prompt).toContain('second');
  });

  test('card_id on hire assigns and moves the card, records history, and appends the brief', async () => {
    const ctx = await setup();
    const card = (await ctx.req('POST', '/api/cards', { title: 'Login page', context: 'Asked in triage', checks: ['Login works'], later: true }, ctx.captain.id)).body.card;
    const hired = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'do it', card_id: card.id }, ctx.captain.id);
    const a = hired.body.agent;
    const c = ctx.store.getCard(card.id)!;
    expect(c.assignee_id).toBe(a.id);
    expect(c.state).toBe('in_progress');
    expect(c.notes.some((n: any) => n.text === `assigned to @${a.handle}` && n.kind === 'event')).toBe(true);
    expect(c.notes.at(-1)!.text).toBe('back from Later');
    expect(c.later_at).toBeNull();
    expect(c.history.at(-1)).toMatchObject({ from: 'todo', to: 'in_progress', by: 'captain' });
    expect(hired.body.message.card_id).toBe(card.id);
    expect(hired.body.message.text).toContain(`# ${cardKey(card)} · Login page`);
    expect(hired.body.message.text).toContain('Asked in triage');
    expect(hired.body.message.text).toContain('1. [ ] Login works');
    expect(ctx.sp.starts[0].prompt).toContain(`card #${card.id}`);
  });

  test('spawner.start failure → crashed + system message to parent', async () => {
    const ctx = await setup();
    ctx.sp.failStart = 'tmux exploded';
    const r = await ctx.req('POST', '/api/hire', { resume: 'builder', task: 'x' }, ctx.captain.id);
    await flush();
    const a = agentOf(ctx, r.body.agent.id);
    expect(a.state).toBe('crashed');
    // The notice is piggybacked on the hire response when start() fails fast, else on the next request.
    const inbox = [...r.body.inbox, ...(await ctx.req('GET', '/api/inbox', undefined, ctx.captain.id)).body.inbox];
    expect(inbox.length).toBe(1);
    expect(inbox[0].kind).toBe('system');
    expect(inbox[0].text).toContain('tmux exploded');
    expect(inbox[0].meta.about).toBe(a.id);
    expect(ctx.store.countWorking()).toBe(0);
  });
});
