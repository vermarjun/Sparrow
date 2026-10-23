// Multi-captain, server side (docs/DESIGN.md). Sandboxed like every server test.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachLine, captainWindowOpen, launchCaptain } from '../../src/harness/captain';
import { killWindow } from '../../src/harness/tmux';
import { gitBranch } from '../../src/server/core';
import { Store } from '../../src/server/db';
import { resumeCommand } from '../../src/server/captains';
import type { Agent, CaptainStartReq, CaptainStartRes, CaptainSummary } from '../../src/shared/types';
import { agentOf, flush, hire, setup, type Ctx } from './helpers';

const uuid = (): string => crypto.randomUUID();

/** A context with no initial captain: each test registers the sessions it needs. */
const bare = (settings = {}, extra = {}) => setup(settings, extra, { register: false });

async function reg(ctx: Ctx, body: Record<string, unknown> = {}, as?: string) {
  const r = await ctx.req('POST', '/api/captains/register', { cwd: ctx.root, ...body }, as);
  return r;
}
async function captainOf(ctx: Ctx, session_id: string = uuid(), extra: Record<string, unknown> = {}): Promise<Agent> {
  const r = await reg(ctx, { session_id, harness: 'claude', ...extra });
  if (r.status !== 200) throw new Error(`register ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.agent as Agent;
}
const doneAs = (ctx: Ctx, a: Agent, summary = 'ok', status: 'ok' | 'blocked' | 'failed' = 'ok') =>
  ctx.req('POST', '/api/done', { summary, status }, a.id, agentOf(ctx, a.id).call_id);
const summaries = async (ctx: Ctx, qs = ''): Promise<CaptainSummary[]> =>
  (await ctx.req('GET', `/api/captains?project=${ctx.store.listProjects()[0].id}${qs}`)).body;

describe('1–2 identity: one row per session', () => {
  test('1. two sessions → two captains: `captain` then cap-<star>, own fleets', async () => {
    const ctx = await bare();
    const a = await reg(ctx, { session_id: uuid(), harness: 'claude' });
    const b = await reg(ctx, { session_id: uuid(), harness: 'codex' });
    expect(a.body.created).toBe(true);
    expect(b.body.created).toBe(true);
    expect(a.body.agent.handle).toBe('captain');
    expect(b.body.agent.handle).toBe('cap-orion');
    expect(a.body.agent.fleet_id).toBe(a.body.agent.id);
    expect(b.body.agent.fleet_id).toBe(b.body.agent.id);
    expect(a.body.agent.fleet_id).not.toBe(b.body.agent.fleet_id);
    expect(a.body.agent).toMatchObject({ kind: 'human', depth: 0, can_hire: ['*'], parent_id: null, captain: { title: null, harness: 'claude', origin: 'terminal', archived_at: null } });
    expect(b.body.agent.captain.harness).toBe('codex');
    expect(a.body.project.id).toBe(b.body.project.id);
    const c = await reg(ctx, { session_id: uuid() });
    expect(c.body.agent.handle).toBe('cap-vega');
    expect(c.body.agent.captain.harness).toBe('unknown');
  });

  test('1b. --name picks the handle when valid and free; otherwise the default rules apply', async () => {
    const ctx = await bare();
    expect((await reg(ctx, { session_id: uuid(), name: 'login' })).body.agent.handle).toBe('login');
    expect((await reg(ctx, { session_id: uuid(), name: 'login' })).body.agent.handle).toBe('captain');
    expect((await reg(ctx, { session_id: uuid(), name: 'Bad Name!' })).body.agent.handle).toBe('cap-orion');
  });

  test('2. the same session again → same row; cwd and branch refresh, session id unchanged; branch is read only when needed', async () => {
    let branch: string | null = 'main';
    let calls = 0;
    const ctx = await bare({}, { detectBranch: () => { calls++; return branch; } });
    const sid = uuid();
    const first = await captainOf(ctx, sid);
    expect(first.captain!.branch).toBe('main');
    expect(calls).toBe(1);
    const again = await reg(ctx, { session_id: sid, harness: 'claude' });
    expect(again.body.created).toBeUndefined();
    expect(again.body.agent.id).toBe(first.id);
    expect(calls).toBe(1); // same cwd, branch known: no git call
    const sub = join(ctx.root, 'sub');
    branch = 'feat/login';
    const moved = await reg(ctx, { session_id: sid, cwd: sub, harness: 'claude' });
    expect(moved.body.agent.id).toBe(first.id);
    expect(moved.body.agent.cwd).toBe(sub);
    expect(moved.body.agent.captain.branch).toBe('feat/login');
    expect(moved.body.agent.session_id).toBe(sid);
    expect(calls).toBe(2);
    expect(ctx.store.listCaptains(first.project_id).length).toBe(1);
    // a null branch (non-git folder) is looked up again next time
    branch = null;
    await reg(ctx, { session_id: sid, cwd: ctx.root });
    expect(calls).toBe(3);
    await reg(ctx, { session_id: sid, cwd: ctx.root });
    expect(calls).toBe(4);
  });

  test('2b. gitBranch: branch name, null when detached or outside a repo (real git)', () => {
    const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(['git', '-C', cwd, ...a], { stdout: 'pipe', stderr: 'pipe' }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sp-br-')));
    git(repo, 'init', '-q', '-b', 'trunk');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    expect(gitBranch(repo)).toBe('trunk');
    git(repo, 'checkout', '-q', '--detach');
    expect(gitBranch(repo)).toBeNull();
    expect(gitBranch(mkdtempSync(join(tmpdir(), 'sp-nobr-')))).toBeNull();
  });

  test('7 (race). two first commands of one new session at once → one row, one `created`, never a 500', async () => {
    const ctx = await bare();
    const sid = uuid();
    const rs = await Promise.all([reg(ctx, { session_id: sid }), reg(ctx, { session_id: sid }), reg(ctx, { session_id: sid })]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(rs.map((r) => r.body.agent.id)).size).toBe(1);
    expect(rs.filter((r) => r.body.created).length).toBe(1);
    expect(ctx.store.listCaptains(rs[0].body.agent.project_id).length).toBe(1);
  });

  test('7 (index). losing the unique-index race re-reads the winner instead of failing', async () => {
    const ctx = await bare();
    const sid = uuid();
    const winner = await captainOf(ctx, sid);
    const real = ctx.store.getCaptainBySession.bind(ctx.store);
    let first = true;
    ctx.store.getCaptainBySession = (p, s) => { if (first) { first = false; return null; } return real(p, s); }; // the lookup missed the row...
    const r = await reg(ctx, { session_id: sid }); // ...so the insert hits agents_captain_session
    expect(r.status).toBe(200);
    expect(r.body.agent.id).toBe(winner.id);
    expect(r.body.created).toBeUndefined();
    expect(ctx.store.listCaptains(winner.project_id).length).toBe(1);
  });
});

describe('3–5 the fleet wall', () => {
  async function two() {
    const ctx = await bare({ max_running: 50 });
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    const a1 = await hire(ctx, 'fake', 'task a1', { name: 'amy' }, A.id);
    const b1 = await hire(ctx, 'fake', 'task b1', { name: 'bob' }, B.id);
    await flush();
    return { ctx, A, B, a1, b1 };
  }

  test('hires inherit the fleet; A and B have separate tmux sessions', async () => {
    const { ctx, A, B, a1, b1 } = await two();
    expect(a1.fleet_id).toBe(A.id);
    expect(b1.fleet_id).toBe(B.id);
    expect(a1.tmux_session).toBe('sptest-' + A.project_id);               // root handle `captain`
    expect(b1.tmux_session).toBe(`sptest-${B.project_id}-${B.handle}`);   // any other captain: its own session
    expect(agentOf(ctx, a1.id).captain).toBeNull();
  });

  test('3. results reach only the hirer; B\'s long-poll is not superseded by A\'s', async () => {
    const { ctx, A, B, a1, b1 } = await two();
    const pa = ctx.core.waitForPending(A.id, 30);
    const pb = ctx.core.waitForPending(B.id, 30);
    let bSettled = false;
    pb.then(() => { bSettled = true; });
    await doneAs(ctx, a1, 'A is done');
    expect(await pa).toBe('ready');
    await flush();
    expect(bSettled).toBe(false);
    const aInbox = ctx.core.takeInbox(A.id);
    expect(aInbox.map((m) => m.text)).toEqual(['A is done']);
    expect(ctx.core.takeInbox(B.id)).toEqual([]);
    await doneAs(ctx, b1, 'B is done');
    expect(await pb).toBe('ready');
    expect(ctx.core.takeInbox(B.id).map((m) => m.text)).toEqual(['B is done']);
    expect(ctx.core.takeInbox(A.id)).toEqual([]);
  });

  test('4. sends and releases never cross fleets; the captain releases its own grandchild', async () => {
    const { ctx, A, B, a1, b1 } = await two();
    const s1 = await ctx.req('POST', '/api/send', { to: `@${a1.handle}`, text: 'hi' }, B.id);
    expect(s1.status).toBe(403);
    expect(s1.body.error).toBe(`@amy is on @captain's team; @${B.handle} can only message its own team (sparrow roster).`);
    expect((await ctx.req('POST', '/api/send', { to: `@${a1.handle}`, text: 'hi' }, b1.id)).status).toBe(403);
    expect((await ctx.req('POST', '/api/send', { to: `@${b1.handle}`, text: 'hi' }, a1.id)).status).toBe(403);
    expect((await ctx.req('POST', '/api/send', { to: `@${A.handle}`, text: 'a question?' }, a1.id)).status).toBe(200);
    expect((await ctx.req('POST', '/api/send', { to: `@${b1.handle}`, text: 'go on' }, B.id)).status).toBe(200);
    // releases
    expect((await ctx.req('POST', '/api/release', { agent: `@${a1.handle}` }, B.id)).status).toBe(403);
    expect((await ctx.req('POST', '/api/release', { agent: `@${a1.handle}` }, b1.id)).status).toBe(403);
    expect(agentOf(ctx, a1.id).state).not.toBe('retired');
    const sc = await hire(ctx, 'sub-captain', 'lead', { name: 'lead' }, A.id);
    const grand = await hire(ctx, 'fake', 'deep', { name: 'deep' }, sc.id);
    expect(grand.fleet_id).toBe(A.id);
    const rel = await ctx.req('POST', '/api/release', { agent: '@deep' }, A.id);
    expect(rel.status).toBe(200);
    expect(agentOf(ctx, grand.id).state).toBe('retired');
  });

  test('4b. roster, threads and messages of an identified caller are its own fleet; the UI sees everything', async () => {
    const { ctx, A, B, a1 } = await two();
    const rosterB = (await ctx.req('GET', `/api/agents?project=${A.project_id}`, undefined, B.id)).body.map((x: Agent) => x.handle).sort();
    expect(rosterB).toEqual([B.handle, 'bob'].sort());
    const ui = (await ctx.req('GET', `/api/agents?project=${A.project_id}`)).body.map((x: Agent) => x.handle);
    expect(ui).toEqual(expect.arrayContaining(['captain', B.handle, 'amy', 'bob']));
    const msgsB = (await ctx.req('GET', `/api/messages?project=${A.project_id}`, undefined, B.id)).body;
    expect(msgsB.length).toBeGreaterThan(0);
    expect(msgsB.every((m: any) => m.text.includes('b1'))).toBe(true);
    expect((await ctx.req('GET', `/api/messages?project=${A.project_id}&fleet=${A.id}`, undefined, B.id)).status).toBe(403);
    const threadsB = (await ctx.req('GET', '/api/threads', undefined, B.id)).body;
    expect(threadsB.map((t: any) => t.members.join())).not.toContain(expect.stringContaining('amy'));
    // unknown target: the roster in the error is the caller's own team
    const nf = await ctx.req('POST', '/api/send', { to: '@nobody', text: 'x' }, B.id);
    expect(nf.status).toBe(404);
    expect(nf.body.error).not.toContain('@amy');
    expect(a1.fleet_id).toBe(A.id);
  });

  test('4c. GET /api/messages?fleet= returns the messages whose thread has a fleet member on either side', async () => {
    const { ctx, A, B, a1, b1 } = await two();
    await doneAs(ctx, a1, 'A result');
    await doneAs(ctx, b1, 'B result');
    const fa = (await ctx.req('GET', `/api/messages?project=${A.project_id}&fleet=${A.id}`)).body;
    expect(fa.map((m: any) => m.text)).toEqual(['task a1', 'A result']);
    const fb = (await ctx.req('GET', `/api/messages?project=${A.project_id}&fleet=${B.handle}`)).body;
    expect(fb.map((m: any) => m.text)).toEqual(['task b1', 'B result']);
    expect((await ctx.req('GET', `/api/messages?project=${A.project_id}`)).body.length).toBe(4);
  });

  test('5. a sub-captain\'s hires are in the hirer\'s fleet; their results go to the sub-captain', async () => {
    const ctx = await bare({ max_running: 50 });
    const A = await captainOf(ctx);
    const sc = await hire(ctx, 'sub-captain', 'lead the work', { name: 'lead' }, A.id);
    const w = await hire(ctx, 'fake', 'part 1', { name: 'worker' }, sc.id);
    await flush();
    expect(sc.fleet_id).toBe(A.id);
    expect(w.fleet_id).toBe(A.id);
    expect(w.parent_id).toBe(sc.id);
    await doneAs(ctx, w, 'part 1 done');
    expect(ctx.core.takeInbox(A.id).map((m) => m.text)).toEqual([]);
    expect(ctx.store.pendingFor(sc.id).map((m) => m.text)).toEqual(['part 1 done']);
    // the sub-captain may talk to the captain and the worker, and the worker to its parent
    expect((await ctx.req('POST', '/api/send', { to: '@worker', text: 'next' }, sc.id)).status).toBe(200);
    expect((await ctx.req('POST', '/api/send', { to: `@${A.handle}`, text: 'status' }, sc.id)).status).toBe(200);
  });
});

describe('6–7 no session id, captain_id, adopt', () => {
  test('6. no session: none → creates `captain`; one → reused; two → 409 naming both', async () => {
    const ctx = await bare();
    const made = await reg(ctx);
    expect(made.body.created).toBe(true);
    expect(made.body.agent.handle).toBe('captain');
    expect(made.body.agent.session_id).toBeNull();
    const reuse = await reg(ctx);
    expect(reuse.body.agent.id).toBe(made.body.agent.id);
    expect(reuse.body.created).toBeUndefined();
    const other = await captainOf(ctx); // a session shows up: it is a new captain
    expect(other.handle).toBe('cap-orion');
    const amb = await reg(ctx);
    expect(amb.status).toBe(409);
    expect(amb.body.error).toBe(`2 captains in ${made.body.project.id}: @captain, @cap-orion. Run from the captain's own session, or set SPARROW_CAPTAIN_ID=<id|handle>.`);
  });

  test('6b. captain_id (id or handle) wins; it refreshes the session id; unknown → 404', async () => {
    const ctx = await bare();
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    const byId = await reg(ctx, { captain_id: B.id });
    expect(byId.body.agent.id).toBe(B.id);
    const byHandle = await reg(ctx, { captain_id: 'cap-orion', session_id: A.session_id }); // a session that is A's: captain_id still wins
    expect(byHandle.body.agent.id).toBe(B.id);
    expect(byHandle.body.agent.session_id).toBe(B.session_id);        // A owns that session: not stolen
    const fresh = uuid();
    const refreshed = await reg(ctx, { captain_id: `@${B.handle}`, session_id: fresh }); // /clear → new session id
    expect(refreshed.body.agent.id).toBe(B.id);
    expect(refreshed.body.agent.session_id).toBe(fresh);
    expect(ctx.store.getCaptainBySession(B.project_id, fresh)!.id).toBe(B.id);
    const missing = await reg(ctx, { captain_id: 'nobody' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('SPARROW_CAPTAIN_ID=nobody');
    expect((await reg(ctx, { captain_id: 'ag_NOPE' })).status).toBe(404);
    const agentRow = await hire(ctx, 'fake', 'x', {}, A.id);
    expect((await reg(ctx, { captain_id: agentRow.id })).status).toBe(404); // only captains
  });

  test('7. adopt moves the session; the empty previous row is archived; a row with a team → 409', async () => {
    const ctx = await bare({ max_running: 50 });
    const A = await captainOf(ctx);
    const old = A.session_id!;
    const fresh = uuid();
    // this new session (after /clear in a terminal) registered as its own, empty captain first
    const stray = await captainOf(ctx, fresh);
    expect(stray.id).not.toBe(A.id);
    const adopted = await reg(ctx, { session_id: fresh, adopt: 'captain' });
    expect(adopted.status).toBe(200);
    expect(adopted.body.agent.id).toBe(A.id);
    expect(adopted.body.agent.session_id).toBe(fresh);
    expect(adopted.body.created).toBeUndefined();
    const strayNow = agentOf(ctx, stray.id);
    expect(strayNow.session_id).toBeNull();
    expect(strayNow.captain!.archived_at).not.toBeNull();
    expect(ctx.store.getCaptainBySession(A.project_id, old)).toBeNull();
    // same again: idempotent
    expect((await reg(ctx, { session_id: fresh, adopt: '@captain' })).body.agent.id).toBe(A.id);

    // a previous row WITH a team is never merged
    const B = await captainOf(ctx);
    await hire(ctx, 'fake', 'work', {}, B.id);
    const refused = await reg(ctx, { session_id: B.session_id, adopt: 'captain' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(`already captain @${B.handle}`);
    expect(agentOf(ctx, B.id).session_id).toBe(B.session_id);
    expect(agentOf(ctx, A.id).session_id).toBe(fresh);

    expect((await reg(ctx, { session_id: uuid(), adopt: 'nobody' })).status).toBe(404);
    expect((await reg(ctx, { adopt: 'captain' })).status).toBe(400); // needs a session id
  });

  test('A3. /clear: a session id nobody knows but a pid we saw recently re-attaches; stale or other pids do not', async () => {
    const ctx = await bare();
    const sid1 = uuid();
    const A = await captainOf(ctx, sid1, { pid: 4242 });
    const sid2 = uuid();
    const back = await reg(ctx, { session_id: sid2, harness: 'claude', pid: 4242 });
    expect(back.body.created).toBeUndefined();
    expect(back.body.agent.id).toBe(A.id);
    expect(back.body.agent.session_id).toBe(sid2);
    expect(ctx.store.getCaptainBySession(A.project_id, sid1)).toBeNull();
    const other = await reg(ctx, { session_id: uuid(), pid: 5151 });
    expect(other.body.created).toBe(true);
    await ctx.clock.advance(25 * 3600_000);
    const stale = await reg(ctx, { session_id: uuid(), pid: 4242 });
    expect(stale.body.created).toBe(true);
    expect(stale.body.agent.id).not.toBe(A.id);
    expect(ctx.store.listCaptains(A.project_id).length).toBe(3);
  });
});

describe('8 migration', () => {
  function v4db(path: string) {
    const db = new Database(path);
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (4);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, handle TEXT NOT NULL, kind TEXT NOT NULL, resume TEXT NOT NULL,
        title TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, effort TEXT, can_hire TEXT NOT NULL DEFAULT '[]', parent_id TEXT,
        depth INTEGER NOT NULL, cwd TEXT NOT NULL, tmux_session TEXT NOT NULL, tmux_window TEXT NOT NULL, tmux_window_id TEXT,
        session_id TEXT, state TEXT NOT NULL, call_id TEXT, last_end_reason TEXT, last_update TEXT, last_update_at INTEGER,
        last_seen_at INTEGER, queued_at INTEGER, resume_hash TEXT, last_run TEXT, resume_note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (project_id, handle));
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, thread TEXT NOT NULL,
        from_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', card_id INTEGER,
        meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      INSERT INTO projects VALUES ('p', 'p', '/x/p', 1), ('q', 'q', '/x/q', 1);`);
    const ins = db.query("INSERT INTO agents (id, project_id, handle, kind, resume, title, harness, can_hire, parent_id, depth, cwd, tmux_session, tmux_window, session_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'r', 'T', ?, '[]', ?, ?, '/x', 's', 'w', ?, 'idle', 1, 1)");
    ins.run('ag_cap', 'p', 'captain', 'human', 'human', null, 0, '7f3a1c2e-9b4d-4e6f-8a10-123456789abc');
    ins.run('ag_sub', 'p', 'lead', 'agent', 'claude', 'ag_cap', 1, null);
    ins.run('ag_w', 'p', 'worker', 'agent', 'claude', 'ag_sub', 2, null);
    ins.run('ag_orphan', 'p', 'stray', 'agent', 'claude', 'ag_gone', 1, null);
    ins.run('ag_cap2', 'q', 'captain', 'human', 'human', null, 0, 'opencode-session-1');
    ins.run('ag_h2', 'q', 'james', 'agent', 'claude', 'ag_cap2', 1, null);
    const msg = db.query("INSERT INTO messages (id, project_id, thread, from_id, kind, text, created_at) VALUES (?, ?, ?, ?, 'task', 't', 1)");
    msg.run('msg_1', 'p', 'dm:ag_cap:ag_sub', 'ag_cap');
    msg.run('msg_2', 'p', 'dm:ag_sub:ag_w', 'ag_sub');
    msg.run('msg_3', 'q', 'dm:ag_cap2:ag_h2', 'ag_cap2');
    msg.run('msg_g', 'p', 'group', 'ag_cap');
    db.close();
  }

  test('8. a v4 database: fleets, captain info, messages and the unique index; a backup is kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparrow-v4-'));
    const path = join(dir, 'sparrow.db');
    v4db(path);
    const s = new Store(path);
    expect(s.schemaVersion()).toBe(5);
    const fleet = (id: string) => s.getAgent(id)!.fleet_id;
    expect(fleet('ag_cap')).toBe('ag_cap');
    expect(fleet('ag_sub')).toBe('ag_cap');
    expect(fleet('ag_w')).toBe('ag_cap');       // grandchild: root ancestor
    expect(fleet('ag_orphan')).toBe('ag_orphan'); // missing parent: its own
    expect(fleet('ag_cap2')).toBe('ag_cap2');
    expect(fleet('ag_h2')).toBe('ag_cap2');
    expect(s.getAgent('ag_cap')!.captain).toEqual({ title: null, branch: null, harness: 'claude', origin: 'terminal', archived_at: null });
    expect(s.getAgent('ag_cap2')!.captain!.harness).toBe('unknown');
    expect(s.getAgent('ag_sub')!.captain).toBeNull();
    const fm = (thread: string) => (s.db.query('SELECT fleet_id FROM messages WHERE thread = ?').get(thread) as any).fleet_id;
    expect(fm('dm:ag_sub:ag_w')).toBe('ag_cap');
    expect(fm('dm:ag_cap2:ag_h2')).toBe('ag_cap2');
    expect(s.fleetMembers('ag_cap').map((a) => a.id)).toEqual(['ag_cap', 'ag_sub', 'ag_w']);
    const idx = s.db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'agents_captain_session'").get() as any;
    expect(idx.sql).toContain('UNIQUE');
    expect(idx.sql).toContain("kind = 'human'");
    // two humans cannot share a session in a project; the same session in another project is fine
    expect(() => s.db.query("INSERT INTO agents (id, project_id, handle, kind, resume, title, harness, depth, cwd, tmux_session, tmux_window, session_id, state, created_at, updated_at) VALUES ('ag_dup','p','dup','human','r','T','human',0,'/x','s','w','7f3a1c2e-9b4d-4e6f-8a10-123456789abc','idle',1,1)").run()).toThrow(/UNIQUE/);
    s.close();
    expect(readdirSync(dir).some((f) => f.startsWith('sparrow.db.bak-v4-'))).toBe(true);
    // a second open changes nothing and makes no second backup
    const again = new Store(path);
    expect(again.getAgent('ag_w')!.fleet_id).toBe('ag_cap');
    again.close();
    expect(readdirSync(dir).filter((f) => f.includes('.bak-')).length).toBe(1);
  });

  test('8b. A7: a row an older server inserts later (NULL fleet_id) is placed in its fleet on read and on the next open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparrow-v4b-'));
    const path = join(dir, 'sparrow.db');
    v4db(path);
    const s = new Store(path);
    s.close();
    const raw = new Database(path);
    raw.exec(`INSERT INTO agents (id, project_id, handle, kind, resume, title, harness, can_hire, parent_id, depth, cwd, tmux_session, tmux_window, state, created_at, updated_at)
      VALUES ('ag_late', 'p', 'late', 'agent', 'r', 'T', 'claude', '[]', 'ag_sub', 2, '/x', 's', 'w', 'idle', 5, 5);
      INSERT INTO agents (id, project_id, handle, kind, resume, title, harness, can_hire, parent_id, depth, cwd, tmux_session, tmux_window, session_id, state, created_at, updated_at)
      VALUES ('ag_capnew', 'p', 'cap-new', 'human', 'r', 'T', 'human', '["*"]', NULL, 0, '/x', 's', 'w', NULL, 'idle', 5, 5);
      INSERT INTO messages (id, project_id, thread, from_id, kind, text, created_at) VALUES ('msg_late', 'p', 'dm:ag_late:ag_sub', 'ag_sub', 'task', 'x', 5);`);
    raw.close();
    const again = new Store(path);
    expect((again.db.query('SELECT fleet_id FROM messages WHERE id = ?').get('msg_late') as any).fleet_id).toBe('ag_cap');
    expect(again.getAgent('ag_late')!.fleet_id).toBe('ag_cap');
    expect(again.getAgent('ag_capnew')).toMatchObject({ fleet_id: 'ag_capnew', captain: { origin: 'terminal', harness: 'unknown' } });
    // inserted while this store is open: the read heals it
    again.db.exec(`INSERT INTO agents (id, project_id, handle, kind, resume, title, harness, can_hire, parent_id, depth, cwd, tmux_session, tmux_window, state, created_at, updated_at)
      VALUES ('ag_live', 'p', 'live', 'agent', 'r', 'T', 'claude', '[]', 'ag_w', 3, '/x', 's', 'w', 'idle', 6, 6)`);
    expect(again.getAgent('ag_live')!.fleet_id).toBe('ag_cap');
    expect((again.db.query('SELECT fleet_id FROM agents WHERE id = ?').get('ag_live') as any).fleet_id).toBe('ag_cap');
    again.close();
  });
});

describe('9 the captains read model', () => {
  test('status: working → attention → idle; archived wins; counts, unread, questions, results, cards, last_message', async () => {
    const ctx = await bare({ max_running: 50 });
    const A = await captainOf(ctx, uuid(), { name: 'alpha' });
    const idle = await captainOf(ctx);
    await ctx.req('PATCH', `/api/captains/${idle.id}`, { title: 'Idle one' });
    const w1 = await hire(ctx, 'fake', 'one', { name: 'w1' }, A.id);
    const w2 = await hire(ctx, 'fake', 'two', { name: 'w2' }, A.id);
    await flush();
    let s = (await summaries(ctx)).find((x) => x.agent.id === A.id)!;
    expect(s.status).toBe('working');
    expect(s.fleet).toMatchObject({ total: 2, working: 2, queued: 0 });
    expect(s.online).toBe(true);
    expect(s.unread).toBe(0);

    await doneAs(ctx, w1, 'w1 finished', 'ok');
    await ctx.req('POST', '/api/ask', { question: 'which db?' }, w2.id, agentOf(ctx, w2.id).call_id);
    s = (await summaries(ctx)).find((x) => x.agent.id === A.id)!;
    expect(s.status).toBe('attention');                 // nothing working; two unread, one a question
    expect(s.unread).toBe(2);
    expect(s.questions).toBe(1);
    expect(s.fleet).toMatchObject({ total: 2, idle: 1, waiting: 1, working: 0 });
    expect(s.results).toEqual({ ok: 1, blocked: 0, failed: 0 });
    expect(s.last_message).toMatchObject({ kind: 'question', text: 'which db?', from_handle: 'w2' });

    ctx.core.takeInbox(A.id);                           // the captain reads its inbox
    s = (await summaries(ctx)).find((x) => x.agent.id === A.id)!;
    expect(s.unread).toBe(0);
    expect(s.status).toBe('attention');                 // w2 still waits on an `ask`
    await ctx.req('POST', '/api/send', { to: '@w2', text: 'postgres' }, A.id);
    await flush();
    await doneAs(ctx, agentOf(ctx, w2.id), 'w2 finished', 'failed');
    ctx.core.takeInbox(A.id);
    s = (await summaries(ctx)).find((x) => x.agent.id === A.id)!;
    expect(s.status).toBe('idle');
    expect(s.results).toEqual({ ok: 1, blocked: 0, failed: 1 });

    // cards assigned to a fleet member are counted
    const card = (await ctx.req('POST', '/api/cards', { project: A.project_id, title: 'Rate limit', assignee: 'w1' })).body.card;
    expect(card.assignee_id).toBe(w1.id);
    s = (await summaries(ctx)).find((x) => x.agent.id === A.id)!;
    expect(s.cards).toBe(1);

    // a crashed agent needs attention
    const w3 = await hire(ctx, 'fake', 'three', {}, A.id);
    await flush();
    ctx.core.takeInbox(A.id);
    ctx.store.patchAgent(w3.id, { state: 'crashed' }, 1);
    expect((await summaries(ctx)).find((x) => x.agent.id === A.id)!.status).toBe('attention');
    expect(s.agent.handle).toBe('alpha');

    // archived wins over everything, and hides the row unless asked
    await ctx.req('PATCH', `/api/captains/${A.id}`, { archived: true });
    expect((await summaries(ctx)).some((x) => x.agent.id === A.id)).toBe(false);
    const withArchived = (await summaries(ctx, '&archived=1')).find((x) => x.agent.id === A.id)!;
    expect(withArchived.status).toBe('archived');
    // sorted by newest activity first
    const list = await summaries(ctx, '&archived=1');
    expect(list.map((x) => x.last_activity_at)).toEqual([...list.map((x) => x.last_activity_at)].sort((a, b) => b - a));
  });

  test('a queued agent counts as working; detail returns the whole fleet, last results and its cards', async () => {
    const ctx = await bare({ max_running: 1 });
    const A = await captainOf(ctx);
    const first = await hire(ctx, 'fake', 'first', { name: 'first' }, A.id);
    const second = await hire(ctx, 'fake', 'second', { name: 'second' }, A.id);
    await flush();
    expect(agentOf(ctx, second.id).state).toBe('queued');
    const d = (await ctx.req('GET', `/api/captains/${A.handle}?project=${A.project_id}`)).body;
    expect(d.summary.status).toBe('working');
    expect(d.summary.fleet).toMatchObject({ total: 2, working: 1, queued: 1 });
    expect(d.agents.map((a: Agent) => a.handle)).toEqual([A.handle, 'first', 'second']);
    expect(d.agents[1].call_started_at).toBeGreaterThan(0);           // A1: elapsed time for the Team tree
    expect(d.agents[2].call_started_at).toBeNull();
    const card = (await ctx.req('POST', '/api/cards', { project: A.project_id, title: 'Mine', assignee: 'second' })).body.card;
    const other = (await ctx.req('POST', '/api/cards', { project: A.project_id, title: 'Not mine' })).body.card;
    const prop = (await ctx.req('POST', '/api/propose', { title: 'Proposed by first' }, first.id)).body.card;
    const cards = (await ctx.req('GET', `/api/captains/${A.id}`)).body.cards.map((c: any) => c.id).sort();
    expect(cards).toEqual([card.id, prop.id].sort());
    expect(cards).not.toContain(other.id);
    expect((await ctx.req('GET', `/api/agents?project=${A.project_id}`)).body.find((a: Agent) => a.id === first.id).call_started_at).toBeGreaterThan(0);
    expect((await ctx.req('GET', '/api/captains/nobody?project=' + A.project_id)).status).toBe(404);
    expect((await ctx.req('GET', '/api/captains/captain')).status).toBe(400); // handle without a project
  });

  test('resume command per harness; attach only while a Sparrow window is open', async () => {
    const ctx = await bare();
    const sid = '7f3a1c2e-9b4d-4e6f-8a10-123456789abc';
    const by = async (harness: string, session = true) => (await ctx.req('POST', '/api/captains/register', { cwd: ctx.root, harness, ...(session ? { session_id: `${harness}-${sid}` } : {}), name: `h-${harness}`.slice(0, 20) })).body.agent as Agent;
    const claude = await by('claude');
    const codex = await by('codex');
    const opencode = await by('opencode');
    const unknown = await by('mystery');
    const none = await reg(ctx, { harness: 'claude', name: 'nosession', captain_id: undefined }); // no session: reuses ... more than one → 409
    expect(none.status).toBe(409);
    const list = await summaries(ctx, '&all=1');
    const res = (id: string) => list.find((s) => s.agent.id === id)!.resume;
    expect(res(claude.id)).toEqual({ cwd: ctx.root, harness: 'claude', session_id: `claude-${sid}`, command: `cd '${ctx.root}' && claude --resume claude-${sid}`, attach: null });
    expect(res(codex.id).command).toBe(`cd '${ctx.root}' && codex resume codex-${sid}`);
    expect(res(opencode.id).command).toBe(`cd '${ctx.root}' && opencode -s opencode-${sid}`);
    expect(res(unknown.id)).toMatchObject({ harness: 'unknown', command: null });
    expect(resumeCommand('claude', "/x/it's here", 'abc')).toBe(`cd '/x/it'\\''s here' && claude --resume abc`);
    expect(resumeCommand('codex', '/x', null)).toBeNull();
  });
});

describe('10 PATCH /api/captains/:id', () => {
  test('title, name, archived; validation; agent.updated; only the UI or the captain itself', async () => {
    const ctx = await bare();
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    ctx.events.length = 0;
    const t = await ctx.req('PATCH', `/api/captains/${A.id}`, { title: '  Rate   limiting for login  ' });
    expect(t.status).toBe(200);
    expect(t.body.agent.captain.title).toBe('Rate limiting for login');
    const ev = ctx.events.filter((e) => e.type === 'agent.updated') as any[];
    expect(ev.length).toBe(1);
    expect(ev[0].agent.id).toBe(A.id);
    expect(ev[0].agent.captain.title).toBe('Rate limiting for login');
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { title: null })).body.agent.captain.title).toBeNull();
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { title: 5 })).status).toBe(400);

    const n = await ctx.req('PATCH', `/api/captains/${A.id}`, { name: 'login-work' });
    expect(n.body.agent.handle).toBe('login-work');
    expect((await ctx.req('GET', `/api/captains/login-work?project=${A.project_id}`)).body.summary.agent.id).toBe(A.id);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { name: 'Bad Name' })).status).toBe(400);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { name: 'group' })).status).toBe(400);
    const clash = await ctx.req('PATCH', `/api/captains/${A.id}`, { name: B.handle });
    expect(clash.status).toBe(409);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { name: 'login-work' })).status).toBe(200); // unchanged name is fine
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { name: 'captain' })).status).toBe(200);    // the first captain's name is free again

    const arch = await ctx.req('PATCH', `/api/captains/${A.id}`, { archived: true });
    expect(arch.body.agent.captain.archived_at).toBeGreaterThan(0);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { archived: false })).body.agent.captain.archived_at).toBeNull();
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { archived: 'yes' })).status).toBe(400);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, {})).status).toBe(400);

    // the captain itself may; another captain may not; an agent may not; hires are not captains
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { title: 'mine' }, A.id)).status).toBe(200);
    const denied = await ctx.req('PATCH', `/api/captains/${A.id}`, { title: 'hijack' }, B.id);
    expect(denied.status).toBe(404); // another team's captain reads as unknown
    const w = await hire(ctx, 'fake', 'x', {}, A.id);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { title: 'hijack' }, w.id)).status).toBe(403);
    expect((await ctx.req('PATCH', `/api/captains/${w.id}`, { title: 'x' })).status).toBe(404);
    expect(agentOf(ctx, A.id).captain!.title).toBe('mine');
  });
});

describe('11 launching and resuming captains', () => {
  function launcherCtx(over: Record<string, unknown> = {}) {
    const calls: any[] = [];
    let open = false;
    const seen: any[] = [];
    const extra = {
      launchCaptain: async (req: any): Promise<CaptainStartRes> => {
        calls.push(req);
        seen.push(ctxRef.store.getAgent(req.agent_id)); // the row exists BEFORE the window is opened
        if (over.fail) throw new Error('claude not found');
        return { session: 'sptest-captains', window: req.handle, window_id: `@${calls.length + 40}`, cwd: req.cwd, attach: 'tmux attach -t =sptest-captains' };
      },
      captainWindowOpen: async () => open,
    };
    const ctxRef: { store: Ctx['store'] } = {} as any;
    return { calls, seen, extra, setOpen: (v: boolean) => { open = v; }, bind: (c: Ctx) => { ctxRef.store = c.store; } };
  }

  test('11. /api/captain/start creates the row first, launches with its id + a fresh session id, records the window', async () => {
    const l = launcherCtx();
    const ctx = await bare({}, l.extra);
    l.bind(ctx);
    const first = await captainOf(ctx); // the project already has a captain
    const r = await ctx.req('POST', '/api/captain/start', { cwd: join(ctx.root, 'sub'), name: 'login', title: '  Rate limit login ', model: 'haiku', effort: 'low' });
    expect(r.status).toBe(200);
    expect(r.body.agent_id).toMatch(/^ag_/);
    expect(l.calls.length).toBe(1);
    expect(l.calls[0]).toMatchObject({ cwd: join(ctx.root, 'sub'), model: 'haiku', effort: 'low', agent_id: r.body.agent_id, handle: 'login' });
    expect(l.calls[0].session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(l.seen[0]).toMatchObject({ kind: 'human', handle: 'login', session_id: l.calls[0].session_id, captain: { title: 'Rate limit login', origin: 'sparrow', harness: 'claude' } });
    const row = agentOf(ctx, r.body.agent_id);
    expect(row).toMatchObject({ fleet_id: row.id, tmux_session: 'sptest-captains', tmux_window: 'login', tmux_window_id: '@41', model: 'haiku', effort: 'low' });
    expect(row.project_id).toBe(first.project_id);
    // the session registering under that id (even after /clear) is the same captain
    const hello = await reg(ctx, { captain_id: row.id, session_id: l.calls[0].session_id, harness: 'claude' });
    expect(hello.body.agent.id).toBe(row.id);
    expect(hello.body.created).toBeUndefined();
    // name rules
    expect((await ctx.req('POST', '/api/captain/start', { cwd: ctx.root, name: 'login' })).status).toBe(409);
    expect((await ctx.req('POST', '/api/captain/start', { cwd: ctx.root, name: 'Bad Name' })).status).toBe(400);
    expect(l.calls.length).toBe(1);
    // no name: the next free handle
    const auto = await ctx.req('POST', '/api/captain/start', { cwd: ctx.root });
    expect(agentOf(ctx, auto.body.agent_id).handle).toBe('cap-orion');
  });

  test('11b. a launch that fails leaves no captain behind', async () => {
    const l = launcherCtx({ fail: true });
    const ctx = await bare({}, l.extra);
    l.bind(ctx);
    ctx.events.length = 0;
    const r = await ctx.req('POST', '/api/captain/start', { cwd: ctx.root, name: 'doomed' });
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('claude not found');
    expect(l.seen[0]).toMatchObject({ handle: 'doomed' });
    expect(ctx.store.listCaptains('' + (ctx.store.listProjects()[0]?.id ?? 'x'), true)).toEqual([]);
    expect(ctx.events.filter((e) => e.type === 'agent.updated')).toEqual([]);
  });

  test('11c. /resume runs `claude --resume <sid>` in the captain\'s folder with its id; 409 while the window is open', async () => {
    const l = launcherCtx();
    const ctx = await bare({}, l.extra);
    l.bind(ctx);
    const started = (await ctx.req('POST', '/api/captain/start', { cwd: ctx.root, title: 'Feature' })).body;
    const sid = l.calls[0].session_id;
    l.setOpen(true);
    const busy = await ctx.req('POST', `/api/captains/${started.agent_id}/resume`);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain('already open in tmux');
    expect(busy.body.error).toContain(attachLine('sptest-captains', '@41'));
    expect(busy.body.error).toContain('select-window -t @41');
    expect(l.calls.length).toBe(1);
    // the summary offers the attach line while it is open
    expect((await summaries(ctx))[0].resume.attach).toContain('select-window');
    l.setOpen(false);
    expect((await summaries(ctx))[0].resume.attach).toBeNull();
    const ok = await ctx.req('POST', `/api/captains/${started.agent_id}/resume`);
    expect(ok.status).toBe(200);
    expect(ok.body.agent_id).toBe(started.agent_id);
    expect(l.calls[1]).toMatchObject({ cwd: ctx.root, agent_id: started.agent_id, resume: sid, handle: agentOf(ctx, started.agent_id).handle });
    expect(agentOf(ctx, started.agent_id).tmux_window_id).toBe('@42');
  });

  test('11d. resume: non-claude captains get 400 with the manual command; no session → 409; unknown → 404', async () => {
    const l = launcherCtx();
    const ctx = await bare({}, l.extra);
    l.bind(ctx);
    const codex = await captainOf(ctx, 'codex-session-1', { harness: 'codex' });
    const r = await ctx.req('POST', `/api/captains/${codex.id}/resume`);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(`cd '${ctx.root}' && codex resume codex-session-1`);
    const bareCap = (await reg(ctx, { captain_id: undefined, harness: 'claude', session_id: undefined, name: 'x' })); // 1 captain, no session: reuses codex row
    expect(bareCap.body.agent.id).toBe(codex.id);
    const nosid = await bare();
    const none = (await nosid.req('POST', '/api/captains/register', { cwd: nosid.root, harness: 'claude' })).body.agent;
    const r2 = await nosid.req('POST', `/api/captains/${none.id}/resume`);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toContain('no session id');
    expect((await ctx.req('POST', '/api/captains/ag_NOPE/resume')).status).toBe(404);
    expect(l.calls.length).toBe(0);
    // agents cannot resume or read captains
    const w = await hire(ctx, 'fake', 'x', {}, codex.id);
    expect((await ctx.req('POST', `/api/captains/${codex.id}/resume`, undefined, w.id)).status).toBe(403);
    expect((await ctx.req('GET', `/api/captains?project=${codex.project_id}`, undefined, w.id)).status).toBe(403);
  });

  test('11e. the real launcher: script exports SPARROW_CAPTAIN_ID, uses --session-id / --resume, tags the window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-launch-'));
    const out = join(dir, 'out.txt');
    const fakeClaude = join(dir, 'claude');
    writeFileSync(fakeClaude, `#!/usr/bin/env bash\nprintf '%s\\n' "$SPARROW_CAPTAIN_ID" "$@" > ${JSON.stringify(out)}\nsleep 30\n`);
    chmodSync(fakeClaude, 0o755);
    const saved = { bin: process.env.SPARROW_CLAUDE_BIN, json: process.env.SPARROW_CLAUDE_JSON, url: process.env.SPARROW_URL };
    process.env.SPARROW_CLAUDE_BIN = fakeClaude;
    process.env.SPARROW_CLAUDE_JSON = join(dir, 'claude.json'); // never the real ~/.claude.json
    process.env.SPARROW_URL = 'http://127.0.0.1:1';
    const ids: string[] = [];
    try {
      const run = async (req: Record<string, unknown>) => {
        rmIfExists(out);
        const r = await launchCaptain({ cwd: dir, handle: 'cap-test', agent_id: 'ag_TESTCAP', ...req } as any);
        ids.push(r.window_id);
        for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(50);
        return { r, lines: readFileSync(out, 'utf8').trim().split('\n') };
      };
      const sid = uuid();
      const fresh = await run({ session_id: sid, model: 'haiku' });
      expect(fresh.lines[0]).toBe('ag_TESTCAP');
      expect(fresh.lines.slice(1, 3)).toEqual(['--session-id', sid]);
      expect(fresh.lines).toContain('--append-system-prompt-file');
      expect(fresh.lines.slice(-2)).toEqual(['--model', 'haiku']);
      expect(fresh.r.agent_id).toBe('ag_TESTCAP');
      expect(fresh.r.window).toBe('cap-test');
      expect(await captainWindowOpen({ id: 'ag_TESTCAP', tmux_window_id: fresh.r.window_id })).toBe(true);
      expect(await captainWindowOpen({ id: 'ag_OTHER', tmux_window_id: fresh.r.window_id })).toBe(false); // someone else's tag
      const script = readdirSync(join(process.env.SPARROW_HOME!, 'captains')).map((f) => readFileSync(join(process.env.SPARROW_HOME!, 'captains', f), 'utf8')).find((t) => t.includes('--session-id'))!;
      expect(script).toContain('export SPARROW_CAPTAIN_ID=ag_TESTCAP');
      expect(script).toMatch(/exec \S*claude --session-id \S+ --append-system-prompt-file/);
      expect(script.indexOf('unset')).toBeLessThan(script.indexOf('export SPARROW_CAPTAIN_ID'));
      const resumed = await run({ resume: sid });
      expect(resumed.lines.slice(0, 3)).toEqual(['ag_TESTCAP', '--resume', sid]);
      expect(resumed.lines).not.toContain('--session-id');
    } finally {
      for (const id of ids) await killWindow(id);
      for (const [k, v] of Object.entries({ SPARROW_CLAUDE_BIN: saved.bin, SPARROW_CLAUDE_JSON: saved.json, SPARROW_URL: saved.url })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

function rmIfExists(p: string) { try { require('node:fs').rmSync(p); } catch { /* absent */ } }

describe('12 fair scheduling', () => {
  test('12. max_running_per_captain: fleet A is capped, fleet B still starts; a finished call frees A\'s next', async () => {
    const ctx = await bare({ max_running: 10, max_running_per_captain: 1 });
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    const a1 = await hire(ctx, 'fake', 'a1', { name: 'a1' }, A.id);
    const a2 = await hire(ctx, 'fake', 'a2', { name: 'a2' }, A.id);
    const b1 = await hire(ctx, 'fake', 'b1', { name: 'b1' }, B.id);
    await flush();
    expect(agentOf(ctx, a1.id).state).toBe('working');
    expect(agentOf(ctx, a2.id).state).toBe('queued');   // the wake itself honours the cap, with slots to spare
    expect(agentOf(ctx, b1.id).state).toBe('working');
    expect(ctx.logs.some((l) => l.includes('max_running_per_captain 1 reached'))).toBe(true);
    await ctx.core.dequeue();
    expect(agentOf(ctx, a2.id).state).toBe('queued');   // still capped
    await doneAs(ctx, a1, 'a1 done');
    await flush();
    expect(agentOf(ctx, a2.id).state).toBe('working');
    // raising the cap through settings starts what was waiting
    const a3 = await hire(ctx, 'fake', 'a3', { name: 'a3' }, A.id);
    await flush();
    expect(agentOf(ctx, a3.id).state).toBe('queued');
    ctx.core.settings.max_running_per_captain = 0;
    ctx.core.settingsChanged();
    await flush();
    expect(agentOf(ctx, a3.id).state).toBe('working');
  });

  test('12b. dequeue is a round robin across fleets, not first-come-first-served', async () => {
    const ctx = await bare({ max_running: 1 });
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    const C = await captainOf(ctx);
    const order: string[] = [];
    const a = [] as Agent[];
    for (const n of ['a1', 'a2', 'a3', 'a4']) a.push(await hire(ctx, 'fake', n, { name: n }, A.id));
    const b = [await hire(ctx, 'fake', 'b1', { name: 'b1' }, B.id), await hire(ctx, 'fake', 'b2', { name: 'b2' }, B.id)];
    const c = [await hire(ctx, 'fake', 'c1', { name: 'c1' }, C.id)];
    await flush();
    const all = [...a, ...b, ...c];
    const working = () => all.find((x) => agentOf(ctx, x.id).state === 'working')!;
    for (let i = 0; i < all.length; i++) {
      const w = working();
      order.push(w.handle);
      await doneAs(ctx, w, 'done');
      await flush();
    }
    // a1 (first hired) runs; then each fleet takes a turn: B (never served), C, A, B, A, A
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'a4']);
  });

  test('a captain with several agents queued never blocks another fleet\'s single agent (probes unaffected)', async () => {
    const ctx = await bare({ max_running: 2, max_running_per_captain: 1 });
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    const a = [await hire(ctx, 'fake', 'a1', {}, A.id), await hire(ctx, 'fake', 'a2', {}, A.id), await hire(ctx, 'fake', 'a3', {}, A.id)];
    await flush();
    expect(a.map((x) => agentOf(ctx, x.id).state)).toEqual(['working', 'queued', 'queued']);
    const b = await hire(ctx, 'fake', 'b1', {}, B.id);
    await flush();
    expect(agentOf(ctx, b.id).state).toBe('working'); // A holds one slot only; B gets the other
  });
});

describe('13 scale', () => {
  test('13. 100 captains × 3 fake hires: every result reaches exactly its own captain', async () => {
    const t0 = Date.now();
    const ctx = await bare({ max_running: 400 });
    const caps: Agent[] = [];
    for (let i = 0; i < 100; i++) caps.push(await captainOf(ctx));
    expect(new Set(caps.map((c) => c.handle)).size).toBe(100);
    expect(caps[0].handle).toBe('captain');
    const hires = new Map<string, Agent[]>();
    for (const c of caps) {
      const list: Agent[] = [];
      for (let k = 0; k < 3; k++) list.push(await hire(ctx, 'fake', `task ${c.handle} #${k}`, {}, c.id));
      hires.set(c.id, list);
    }
    await flush();
    expect(ctx.store.countWorking()).toBe(300);
    for (const [capId, list] of hires) for (const h of list) {
      expect(h.fleet_id).toBe(capId);
      await doneAs(ctx, agentOf(ctx, h.id), `result of ${h.id} for ${capId}`);
    }
    await flush();
    for (const c of caps) {
      const inbox = ctx.core.takeInbox(c.id);
      expect(inbox.length).toBe(3);
      for (const m of inbox) {
        expect(m.kind).toBe('result');
        expect(hires.get(c.id)!.map((h) => h.id)).toContain(m.from_id);
        expect(m.text).toContain(`for ${c.id}`);
      }
    }
    // summaries for 100 captains come from a handful of grouped queries
    const t1 = Date.now();
    const list = await summaries(ctx, '&all=1');
    expect(list.length).toBe(100);
    expect(list.every((s) => s.fleet.total === 3 && s.fleet.idle === 3 && s.results.ok === 3 && s.unread === 0)).toBe(true);
    expect(Date.now() - t1).toBeLessThan(2000);
    expect(Date.now() - t0).toBeLessThan(30_000);
    // each fleet's feed holds only its own 6 messages
    const feed = (await ctx.req('GET', `/api/messages?project=${caps[0].project_id}&fleet=${caps[57].id}&limit=1000`)).body;
    expect(feed.length).toBe(6);
  }, 60_000);
});

describe('A-amendments: projects, paging, phantoms, cards, resolve', () => {
  test('A1. /api/projects counts captains (not archived, not phantom); /api/messages pages with before=', async () => {
    const ctx = await bare({ max_running: 50 });
    const A = await captainOf(ctx);
    await captainOf(ctx);                                          // phantom: no team, no title
    const T = await captainOf(ctx);
    await ctx.req('PATCH', `/api/captains/${T.id}`, { title: 'Has a title' });
    const H = await captainOf(ctx);
    await hire(ctx, 'fake', 'x', {}, H.id);
    const arch = await captainOf(ctx);
    await ctx.req('PATCH', `/api/captains/${arch.id}`, { title: 't', archived: true });
    await flush();
    const row = (await ctx.req('GET', '/api/projects')).body.find((p: any) => p.id === A.project_id);
    expect(row.captains).toBe(2);                                  // the titled one and the one with a team; A and the other ghost are phantoms
    expect(row.captains_working).toBe(1);
    // paging
    for (let i = 0; i < 5; i++) await ctx.req('POST', '/api/hire', { resume: 'fake', task: `t${i}`, name: `p${i}` }, A.id);
    await flush();
    const all = (await ctx.req('GET', `/api/messages?project=${A.project_id}&fleet=${A.id}&limit=100`)).body;
    expect(all.map((m: any) => m.text)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    const newest = (await ctx.req('GET', `/api/messages?project=${A.project_id}&fleet=${A.id}&limit=2`)).body;
    expect(newest.map((m: any) => m.text)).toEqual(['t3', 't4']);
    const older = (await ctx.req('GET', `/api/messages?project=${A.project_id}&fleet=${A.id}&limit=2&before=${newest[0].seq}`)).body;
    expect(older.map((m: any) => m.text)).toEqual(['t1', 't2']);
    const oldest = (await ctx.req('GET', `/api/messages?project=${A.project_id}&fleet=${A.id}&limit=2&before=${older[0].seq}`)).body;
    expect(oldest.map((m: any) => m.text)).toEqual(['t0']);
  });

  test('A6. phantom captains (no team, no title, from a terminal) are hidden unless ?all=1; a captain always sees itself', async () => {
    const ctx = await bare();
    const ghost = await captainOf(ctx);
    const titled = await captainOf(ctx);
    await ctx.req('PATCH', `/api/captains/${titled.id}`, { title: 'Real work' });
    const hiring = await captainOf(ctx);
    await hire(ctx, 'fake', 'x', {}, hiring.id);
    expect((await summaries(ctx)).map((s) => s.agent.id).sort()).toEqual([titled.id, hiring.id].sort());
    expect((await summaries(ctx, '&all=1')).map((s) => s.agent.id).sort()).toEqual([ghost.id, titled.id, hiring.id].sort());
    const asGhost = await ctx.req('GET', `/api/captains?project=${ghost.project_id}`, undefined, ghost.id);
    expect(asGhost.body.map((s: CaptainSummary) => s.agent.id)).toContain(ghost.id);
    // a Sparrow-launched captain is never a phantom, even with no title and no team yet
    const res = await ctx.core.startCaptain({ cwd: ctx.root, name: 'launched' }, async (r) => ({ session: 's', window: 'w', window_id: '@9', cwd: r.cwd, attach: 'x' }));
    expect((await summaries(ctx)).map((s) => s.agent.id)).toContain(res.agent_id!);
  });

  test('A5. cards: hire --card, assignee and state changes never reach into another fleet; notes stay open', async () => {
    const ctx = await bare({ max_running: 50 });
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    const a1 = await hire(ctx, 'fake', 'a1', { name: 'a1' }, A.id);
    const card = (await ctx.req('POST', '/api/cards', { title: 'A card', assignee: '@a1' }, A.id)).body.card;
    expect(card.assignee_id).toBe(a1.id);
    // B cannot assign to A's agent, hire for A's card, or move/reassign it
    const assign = await ctx.req('POST', '/api/cards', { title: 'x', assignee: '@a1' }, B.id);
    expect(assign.status).toBe(403);
    expect(assign.body.error).toContain("@a1 is on @captain's team");
    const take = await ctx.req('POST', '/api/hire', { resume: 'fake', task: 'steal', card_id: card.id }, B.id);
    expect(take.status).toBe(403);
    expect(take.body.error).toContain(`Card #${card.id} is assigned to @a1`);
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { state: 'done' }, B.id)).status).toBe(403);
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { assignee: 'me' }, B.id)).status).toBe(403);
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { note: 'FYI from B' }, B.id)).status).toBe(200);
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { state: 'review' }, A.id)).status).toBe(200);
    // an unassigned card is open to either; the UI is unrestricted
    const free = (await ctx.req('POST', '/api/cards', { title: 'free' }, B.id)).body.card;
    expect((await ctx.req('PATCH', `/api/cards/${free.id}`, { assignee: 'me' }, B.id)).status).toBe(200);
    expect((await ctx.req('PATCH', `/api/cards/${card.id}`, { assignee: '@a1', state: 'todo' })).status).toBe(200);
    // hire names may not start with cap-
    const bad = await ctx.req('POST', '/api/hire', { resume: 'fake', task: 'x', name: 'cap-evil' }, A.id);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('cap-');
  });

  test('A4. GET /api/projects/resolve?cwd= names the project without creating a captain', async () => {
    const ctx = await bare();
    expect((await ctx.req('GET', `/api/projects/resolve?cwd=${encodeURIComponent(ctx.root)}`)).status).toBe(404);
    expect((await ctx.req('GET', '/api/projects/resolve')).status).toBe(400);
    const A = await captainOf(ctx);
    const r = await ctx.req('GET', `/api/projects/resolve?cwd=${encodeURIComponent(join(ctx.root, 'sub'))}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(A.project_id);
    expect(ctx.store.listCaptains(A.project_id).length).toBe(1);
  });

  test('whoami carries the fleet root; a captain also gets its resume lines', async () => {
    const ctx = await bare();
    const A = await captainOf(ctx);
    const w = await hire(ctx, 'fake', 'x', {}, A.id);
    const me = (await ctx.req('GET', '/api/whoami', undefined, A.id)).body;
    expect(me.captain.id).toBe(A.id);
    expect(me.resume).toMatchObject({ harness: 'claude', session_id: A.session_id, attach: null });
    const mine = (await ctx.req('GET', '/api/whoami', undefined, w.id)).body;
    expect(mine.captain.id).toBe(A.id);
    expect(mine.resume).toBeUndefined();
  });
});

describe('read-side wall: agent detail, screen and threads', () => {
  test('an identified caller cannot read another team\'s agent, its screen or its thread; the UI and its own team can', async () => {
    const ctx = await bare({ max_running: 50 });
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    const a1 = await hire(ctx, 'fake', 'secret brief', { name: 'amy' }, A.id);
    const b1 = await hire(ctx, 'fake', 'b brief', { name: 'bob' }, B.id);
    await flush();
    for (const who of [B.id, b1.id]) {
      for (const ref of [a1.id, 'amy']) {
        const d = await ctx.req('GET', `/api/agents/${ref}?project=${A.project_id}`, undefined, who);
        expect(d.status).toBe(404);
        expect(JSON.stringify(d.body)).not.toContain('secret brief');
        expect((await ctx.req('GET', `/api/agents/${ref}/screen?project=${A.project_id}`, undefined, who)).status).toBe(404);
      }
      expect((await ctx.req('GET', `/api/messages?project=${A.project_id}&thread=@amy`, undefined, who)).status).toBe(404);
    }
    // same body as a really unknown agent: fleets are not enumerable
    const unknown = await ctx.req('GET', `/api/agents/ag_NOPE`, undefined, B.id);
    const other = await ctx.req('GET', `/api/agents/${a1.id}`, undefined, B.id);
    expect(other.body.error.replace(a1.id, 'X')).toBe(unknown.body.error.replace('ag_NOPE', 'X'));
    // raw dm thread of the other team: nothing
    const raw = await ctx.req('GET', `/api/messages?project=${A.project_id}&thread=${encodeURIComponent(`dm:${[A.id, a1.id].sort().join(':')}`)}`, undefined, B.id);
    expect(raw.body).toEqual([]);
    // own team, parent chain, and the UI still read fine
    expect((await ctx.req('GET', `/api/agents/${a1.id}`, undefined, A.id)).status).toBe(200);
    expect((await ctx.req('GET', `/api/agents/amy/screen?project=${A.project_id}`, undefined, a1.id)).status).toBe(200);
    expect((await ctx.req('GET', `/api/agents/${A.id}`, undefined, a1.id)).status).toBe(200);
    expect((await ctx.req('GET', `/api/agents/${a1.id}`)).status).toBe(200);
    expect((await ctx.req('GET', `/api/agents/${a1.id}/screen`)).status).toBe(200);
    expect((await ctx.req('GET', `/api/messages?project=${A.project_id}&thread=@amy`, undefined, A.id)).body.length).toBeGreaterThan(0);
  });
});

describe('captain reads are walled too', () => {
  test('another fleet\'s captain: detail, resume and patch are 404 (same text as unknown); the list hides its messages and results', async () => {
    const calls: any[] = [];
    const ctx = await bare({ max_running: 50 }, { launchCaptain: async (r: any) => { calls.push(r); return { session: 's', window: 'w', window_id: '@5', cwd: r.cwd, attach: 'x' }; }, captainWindowOpen: async () => false });
    const A = await captainOf(ctx);
    const B = await captainOf(ctx);
    await ctx.req('PATCH', `/api/captains/${A.id}`, { title: 'A work' });
    const a1 = await hire(ctx, 'fake', 'secret brief', { name: 'amy' }, A.id);
    await flush();
    await doneAs(ctx, a1, 'secret result');
    const p = A.project_id;
    // another captain: 404 on id and on handle, identical to a captain that does not exist
    const missing = await ctx.req('GET', `/api/captains/ag_NOPE`, undefined, B.id);
    for (const ref of [A.id, A.handle]) {
      const d = await ctx.req('GET', `/api/captains/${ref}?project=${p}`, undefined, B.id);
      expect(d.status).toBe(404);
      expect(JSON.stringify(d.body)).not.toContain('secret');
      expect(d.body.error).toContain(`No captain ${ref}`);
      expect((await ctx.req('POST', `/api/captains/${ref}/resume?project=${p}`, undefined, B.id)).status).toBe(404);
      expect((await ctx.req('PATCH', `/api/captains/${ref}?project=${p}`, { title: 'hijack' }, B.id)).status).toBe(404);
    }
    expect(missing.status).toBe(404);
    expect(calls.length).toBe(0);
    expect(agentOf(ctx, A.id).captain!.title).toBe('A work');
    // the list keeps the directory facts, drops messages and results of other teams
    const list = (await ctx.req('GET', `/api/captains?project=${p}&all=1`, undefined, B.id)).body as CaptainSummary[];
    const a = list.find((s) => s.agent.id === A.id)!;
    expect(a.agent.captain!.title).toBe('A work');
    expect(a).toMatchObject({ status: 'attention', last_message: null, results: { ok: 0, blocked: 0, failed: 0 } });
    expect(a.fleet.total).toBe(1);
    expect(a.last_activity_at).toBeGreaterThan(0);
    expect(a.resume.session_id).toBe(A.session_id);
    expect(a.resume.command).toContain('claude --resume');
    // the caller's own row and the UI see everything
    const mine = (await ctx.req('GET', `/api/captains?project=${p}&all=1`, undefined, A.id)).body as CaptainSummary[];
    expect(mine.find((s) => s.agent.id === A.id)).toMatchObject({ last_message: { text: 'secret result' }, results: { ok: 1 } });
    const ui = (await ctx.req('GET', `/api/captains?project=${p}&all=1`)).body as CaptainSummary[];
    expect(ui.find((s) => s.agent.id === A.id)!.last_message!.text).toBe('secret result');
    expect((await ctx.req('GET', `/api/captains/${A.id}`)).status).toBe(200);
    expect((await ctx.req('GET', `/api/captains/${A.id}`, undefined, A.id)).status).toBe(200);
    expect((await ctx.req('PATCH', `/api/captains/${A.id}`, { title: 'again' })).status).toBe(200);
    expect((await ctx.req('POST', `/api/captains/${A.id}/resume`, undefined, A.id)).status).toBe(200);
    expect(calls.length).toBe(1);
  });
});
