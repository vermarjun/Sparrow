// Multi-captain CLI (docs/plans/multi-captain.md §6): captains, title, captain start/resume/adopt, whoami, SPARROW_CAPTAIN_ID,
// the created hint, plus two harness sessions end to end against a real sandboxed server.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptainDetail, CaptainStartRes, CaptainSummary } from '../../src/shared/types';
import { captainsTable } from '../../src/cli/format';
import { BIN, REPO, StubServer, agent, captain, cleanEnv, freePort, msg, project, run, tempDir } from './helpers';

const T0 = Date.UTC(2026, 9, 13, 14, 2, 0);
const CLAUDE = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-A' };

const resume = { cwd: '/x/plutus', harness: 'claude' as const, session_id: 'sess-A', command: "cd '/x/plutus' && claude --resume sess-A", attach: null };
const counts = { total: 0, working: 0, queued: 0, waiting: 0, crashed: 0, idle: 0, retired: 0 };

function summary(over: Record<string, unknown> = {}, a = captain): CaptainSummary {
  return {
    agent: a, status: 'idle', online: true, fleet: counts, results: { ok: 0, blocked: 0, failed: 0 }, unread: 0, questions: 0,
    last_activity_at: T0, last_message: null, cards: 0, resume, ...over,
  } as CaptainSummary;
}

const orion = agent({
  id: 'ag_ORION', handle: 'cap-orion', kind: 'human', resume: 'captain', title: 'Captain', harness: 'human', parent_id: null, depth: 0,
  can_hire: ['*'], fleet_id: 'ag_ORION', state: 'idle', call_id: null,
  captain: { title: 'Rate limiting for login', branch: 'feat1', harness: 'claude', origin: 'sparrow', archived_at: null },
});

describe('captainsTable (pure)', () => {
  const now = T0 + 120_000;
  test('handle, (you), title, status, team counts, age, resume line under each', () => {
    const list = [
      summary({ status: 'working', fleet: { ...counts, total: 3, working: 2, queued: 1 }, last_activity_at: T0 + 60_000 }, orion),
      summary({ status: 'attention', unread: 2, questions: 1, resume: { ...resume, session_id: null, command: null, attach: 'tmux attach -t s' } }),
    ];
    const lines = captainsTable(list, 'plutus', 'ag_ORION', false, now).split('\n');
    expect(lines[0]).toBe('Captains in plutus — 2');
    expect(lines[1]).toMatch(/^@cap-orion \(you\)\s+Rate limiting for login\s+working\s+2\/3 working \+1 queued\s+1m ago$/);
    expect(lines[2]).toBe(`    resume: ${resume.command}`);
    expect(lines[3]).toMatch(/^@captain\s+\(main\)\s+attention/);
    expect(lines[3]).toContain('attention (1 question, 2 unread)');
    expect(lines[3]).toContain('no team');
    expect(lines[3]).not.toContain('(you)');
    expect(lines.slice(4)).toEqual(['    resume: (no session id yet)', '    attach: tmux attach -t s']);
  });
  test('header counts what the default view hides', () => {
    const h = (archived: number, empty: number) => captainsTable([summary()], 'plutus', null, false, now, { archived, empty }).split('\n')[0];
    expect(h(1, 2)).toBe('Captains in plutus — 1 (3 hidden: 1 archived, 2 empty; --all)');
    expect(h(0, 1)).toBe('Captains in plutus — 1 (1 hidden: 1 empty; --all)');
    expect(h(2, 0)).toBe('Captains in plutus — 1 (2 hidden: 2 archived; --all)');
    expect(h(0, 0)).toBe('Captains in plutus — 1');
  });
  test('empty list points at `sparrow captain`', () => {
    expect(captainsTable([], 'plutus', null, true, now)).toBe('Captains in plutus — 0 (incl. archived and empty)\nNo captains yet. Start one: sparrow captain --title "…"');
  });
});

const stub = new StubServer(await freePort());
afterAll(() => stub.stop());

describe('commands against a stub server', () => {
  const root = tempDir();
  const proj = { ...project, root };
  const detail = (a = orion): CaptainDetail => ({ summary: summary({ fleet: { ...counts, total: 2, working: 1 } }, a), agents: [a], cards: [] });
  beforeEach(() => {
    stub.reset();
    stub.on('GET', '/api/projects/resolve', proj);
    stub.on('POST', '/api/captains/register', { agent: orion, project: proj, inbox: [] });
    stub.on('GET', '/api/captains', [summary({}, orion), summary({ status: 'archived' })]);
  });
  const url = () => stub.url;

  test('captains in a bare shell resolves the project from cwd, never registers, no (you)', async () => {
    const r = await run(['captains'], { url: url(), cwd: root });
    expect(r.code).toBe(0);
    expect(stub.find('POST', '/api/captains/register')).toHaveLength(0);
    const get = stub.find('GET', '/api/captains')[0];
    expect(get.path).toBe('/api/captains?project=plutus');
    expect(r.stdout).toContain('Captains in plutus');
    expect(r.stdout).toContain('@cap-orion');
    expect(r.stdout).not.toContain('(you)');
  });

  test('a bare shell asks the server to resolve cwd (worktrees map to their repo); a failing resolve is an error', async () => {
    const wt = join(root, '..', 'plutus-feat1');
    mkdirSync(wt, { recursive: true });
    stub.on('GET', '/api/projects/resolve', (req: any) => (req.path.includes(encodeURIComponent(wt)) ? proj : { error: 'no project' }));
    const r = await run(['captains'], { url: url(), cwd: wt });
    expect(r.code).toBe(0);
    expect(stub.find('GET', '/api/projects/resolve')[0].path).toBe(`/api/projects/resolve?cwd=${encodeURIComponent(wt)}`);
    expect(stub.find('GET', '/api/captains')[0].path).toBe('/api/captains?project=plutus');
    expect(stub.find('POST', '/api/captains/register')).toHaveLength(0);
  });

  test('captains header says how many were hidden, from a second all=1 query', async () => {
    const phantom = summary({}, { ...captain, id: 'ag_PH', handle: 'cap-vega' });
    stub.on('GET', '/api/captains', (req: any) => (req.path.includes('all=1')
      ? [summary({}, orion), summary({ status: 'archived' }, { ...captain, id: 'ag_AR', handle: 'cap-old' }), phantom]
      : [summary({}, orion)]));
    const r = await run(['captains'], { url: url(), cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('Captains in plutus — 1 (2 hidden: 1 archived, 1 empty; --all)');
    expect(stub.find('GET', '/api/captains').map((q) => q.path)).toEqual(['/api/captains?project=plutus', '/api/captains?project=plutus&archived=1&all=1']);
    stub.requests = [];
    const all = await run(['captains', '--all'], { url: url(), cwd: root });
    expect(all.stdout.split('\n')[0]).toBe('Captains in plutus — 3 (incl. archived and empty)');
    expect(stub.find('GET', '/api/captains')).toHaveLength(1);
  });

  test('captains --all asks for archived ones; --json prints the raw list', async () => {
    const r = await run(['captains', '--all', '--json'], { url: url(), cwd: root });
    expect(r.code).toBe(0);
    expect(stub.find('GET', '/api/captains')[0].path).toBe('/api/captains?project=plutus&archived=1&all=1');
    expect(JSON.parse(r.stdout)).toHaveLength(2);
  });

  test('captains in a bare shell outside any project shows the server error', async () => {
    stub.on('GET', '/api/projects/resolve', { error: 'cwd is not inside a Sparrow project' }, 404);
    const r = await run(['captains'], { url: url(), cwd: tempDir() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cwd is not inside a Sparrow project');
  });

  test('captains from a session registers, marks (you), and passes SPARROW_CAPTAIN_ID through', async () => {
    const r = await run(['captains'], { url: url(), cwd: root, env: { ...CLAUDE, SPARROW_CAPTAIN_ID: 'ag_ORION' } });
    expect(r.code).toBe(0);
    const reg = stub.find('POST', '/api/captains/register')[0];
    expect(reg.body).toMatchObject({ cwd: root, harness: 'claude', session_id: 'sess-A', captain_id: 'ag_ORION' });
    expect(stub.find('GET', '/api/captains')[0].agent).toBe('ag_ORION');
    expect(r.stdout).toMatch(/@cap-orion \(you\)/);
    expect(r.stdout).not.toContain('a new captain');
  });

  test('created:true prints the one-time hint before the output; --json stays clean', async () => {
    stub.on('POST', '/api/captains/register', { agent: orion, project: proj, inbox: [], created: true });
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    const r = await run(['update', 'hi'], { url: url(), cwd: root, env: CLAUDE });
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('You are @cap-orion, a new captain in plutus. Name your work: sparrow title "…"');
    const j = await run(['update', 'hi', '--json'], { url: url(), cwd: root, env: CLAUDE });
    expect(() => JSON.parse(j.stdout)).not.toThrow();
    expect(j.stdout).not.toContain('a new captain');
  });

  test('register carries CLAUDE_PID as a number (so /clear re-attaches), and nothing when it is unset', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    await run(['update', 'x'], { url: url(), cwd: root, env: { ...CLAUDE, CLAUDE_PID: '4242' } });
    expect(stub.find('POST', '/api/captains/register')[0].body.pid).toBe(4242);
    stub.requests = [];
    await run(['update', 'x'], { url: url(), cwd: root, env: CLAUDE });
    expect(stub.find('POST', '/api/captains/register')[0].body.pid).toBeUndefined();
  });

  test('ambiguous plain shell (register 409): captains and card list fall back to the resolved project; update keeps the 409', async () => {
    const many = { error: '2 captains in plutus: @captain, @cap-orion. Run from the captain\'s own session, or set SPARROW_CAPTAIN_ID=<id|handle>.' };
    stub.on('POST', '/api/captains/register', many, 409);
    stub.on('GET', '/api/agents', [captain, orion]);
    stub.on('GET', '/api/cards', []);
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    const c = await run(['captains'], { url: url(), cwd: root, env: CLAUDE });
    expect(c.code).toBe(0);
    expect(stub.find('POST', '/api/captains/register')).toHaveLength(1);
    expect(stub.find('GET', '/api/captains')[0].path).toBe('/api/captains?project=plutus');
    expect(c.stdout).not.toContain('(you)');
    stub.requests = [];
    const l = await run(['card', 'list'], { url: url(), cwd: root, env: CLAUDE });
    expect(l.code).toBe(0);
    expect(l.stdout).toContain('Board · project plutus');
    expect(stub.find('GET', '/api/cards')[0].agent).toBeNull();
    const u = await run(['update', 'x'], { url: url(), cwd: root, env: CLAUDE });
    expect(u.code).toBe(1);
    expect(u.stderr).toContain('2 captains in plutus');
  });

  test('no SPARROW_CAPTAIN_ID: register body carries none', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    await run(['update', 'x'], { url: url(), cwd: root, env: CLAUDE });
    expect(stub.find('POST', '/api/captains/register')[0].body.captain_id).toBeUndefined();
  });

  test('title PATCHes my captain row; text may come from stdin', async () => {
    stub.on('PATCH', '/api/captains/ag_ORION', (req: any) => ({ agent: { ...orion, captain: { ...orion.captain!, title: req.body.title } } }));
    const r = await run(['title', 'Fix', 'login', 'bug'], { url: url(), cwd: root, env: CLAUDE });
    expect(r.code).toBe(0);
    const p = stub.find('PATCH', '/api/captains/ag_ORION')[0];
    expect(p.body).toEqual({ title: 'Fix login bug' });
    expect(p.agent).toBe('ag_ORION');
    expect(r.stdout).toContain('@cap-orion now works on: Fix login bug');
    const s = await run(['title', '-'], { url: url(), cwd: root, env: CLAUDE, stdin: '- from stdin\n' });
    expect(s.code).toBe(0);
    expect(stub.find('PATCH', '/api/captains/ag_ORION')[1].body).toEqual({ title: '- from stdin' });
  });

  test('title as an agent is refused clearly, and with no text is a usage error', async () => {
    stub.on('GET', '/api/whoami', { agent: agent(), project: proj, parent: captain, inbox: [] });
    const a = await run(['title', 'x'], { url: url(), env: { SPARROW_AGENT_ID: 'ag_JAMES' } });
    expect(a.code).toBe(1);
    expect(a.stderr).toContain('only a human captain has a title');
    expect(stub.find('PATCH', '/api/captains/ag_ORION')).toHaveLength(0);
    const e = await run(['title'], { url: url(), cwd: root, env: CLAUDE });
    expect(e.code).toBe(2);
    expect(e.stderr).toContain('missing "<what you work on>"');
  });

  test('captain adopt registers with adopt (no captain_id) and needs a harness session', async () => {
    stub.on('POST', '/api/captains/register', { agent: orion, project: proj, inbox: [] });
    const r = await run(['captain', 'adopt', '@cap-orion'], { url: url(), cwd: root, env: { ...CLAUDE, SPARROW_CAPTAIN_ID: 'ag_OTHER' } });
    expect(r.code).toBe(0);
    const body = stub.find('POST', '/api/captains/register')[0].body;
    expect(body).toMatchObject({ adopt: 'cap-orion', session_id: 'sess-A', harness: 'claude' });
    expect(body.captain_id).toBeUndefined();
    expect(r.stdout).toContain('This session is now @cap-orion — Rate limiting for login');
    stub.requests = [];
    const none = await run(['captain', 'adopt', 'cap-orion'], { url: url(), cwd: root });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no harness session id');
    expect(stub.requests).toHaveLength(0);
  });

  test('captain adopt surfaces the server 409 (previous row has hires)', async () => {
    stub.on('POST', '/api/captains/register', { error: 'this session already leads @captain with 2 hires; not merging fleets' }, 409);
    const r = await run(['captain', 'adopt', '@cap-orion'], { url: url(), cwd: root, env: CLAUDE });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not merging fleets');
  });

  test('whoami shows captain handle, title, fleet and resume line; agents see whose team they are on', async () => {
    stub.on('GET', '/api/captains/ag_ORION', detail());
    const r = await run(['whoami'], { url: url(), cwd: root, env: { ...CLAUDE, SPARROW_CAPTAIN_ID: 'ag_ORION' } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('captain: @cap-orion — Rate limiting for login · branch feat1 · sparrow');
    expect(r.stdout).toContain('fleet: ag_ORION · 2 agents (1 working)');
    expect(r.stdout).toContain(`resume: ${resume.command}`);
    const j = JSON.parse((await run(['whoami', '--json'], { url: url(), cwd: root, env: CLAUDE })).stdout);
    expect(j.me.handle).toBe('cap-orion');

    stub.reset();
    stub.on('GET', '/api/whoami', { agent: agent({ fleet_id: 'ag_ORION' }), project: proj, parent: orion, inbox: [] });
    stub.on('GET', '/api/captains/ag_ORION', detail());
    const a = await run(['whoami'], { url: url(), env: { SPARROW_AGENT_ID: 'ag_JAMES' } });
    expect(a.stdout).toContain("fleet: @cap-orion's team — Rate limiting for login");
  });

  test('whoami still works when the captain detail is unavailable', async () => {
    const r = await run(['whoami'], { url: url(), cwd: root, env: CLAUDE });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('mode: human captain');
  });

  const started: CaptainStartRes = { session: 'sparrow-plutus-cap-orion', window: 'cap-orion', window_id: '@7', cwd: root, attach: 'tmux attach -t sparrow-plutus-cap-orion \\; select-window -t @7', agent_id: 'ag_ORION' };

  test('captain launches through POST /api/captain/start and prints handle, attach and resume lines', async () => {
    stub.on('POST', '/api/captain/start', started);
    stub.on('GET', '/api/captains/ag_ORION', detail());
    const r = await run(['captain', '--cwd', root, '--name', '@cap-orion', '--title', 'Rate limiting', '--model', 'opus', '--effort', 'high'], { url: url() });
    expect(r.code).toBe(0);
    const s = stub.find('POST', '/api/captain/start')[0];
    expect(s.body).toEqual({ cwd: root, name: 'cap-orion', title: 'Rate limiting', model: 'opus', effort: 'high' });
    expect(s.agent).toBeNull();
    expect(r.stdout).toContain(`Captain @cap-orion — Rate limiting for login · ${root} · sparrow-plutus-cap-orion:cap-orion`);
    expect(r.stdout).toContain(`attach: ${started.attach}`);
    expect(r.stdout).toContain(`resume: ${resume.command}`);
    const bad = await run(['captain', '--cwd', join(root, 'absent')], { url: url() });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('is not a directory');
  });

  test('captain is refused inside an agent window; a server 400 reaches the user', async () => {
    const a = await run(['captain'], { url: url(), env: { SPARROW_AGENT_ID: 'ag_JAMES' } });
    expect(a.code).toBe(1);
    expect(a.stderr).toContain('only the user starts captains');
    stub.on('POST', '/api/captain/start', { error: 'handle cap-orion is taken in plutus' }, 409);
    const r = await run(['captain', '--cwd', root, '--name', 'cap-orion'], { url: url() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('handle cap-orion is taken');
  });

  test('captain resume <@handle> resolves the handle in this project; ids go straight through; 409 is shown', async () => {
    stub.on('POST', '/api/captains/ag_ORION/resume', started);
    stub.on('GET', '/api/captains/ag_ORION', detail());
    const r = await run(['captain', 'resume', '@cap-orion'], { url: url(), cwd: root });
    expect(r.code).toBe(0);
    expect(stub.find('GET', '/api/captains')[0].path).toBe('/api/captains?project=plutus&archived=1&all=1');
    expect(stub.find('POST', '/api/captains/ag_ORION/resume')).toHaveLength(1);
    expect(r.stdout).toContain('Resumed @cap-orion');
    expect(r.stdout).toContain(`attach: ${started.attach}`);

    stub.requests = [];
    const byId = await run(['captain', 'resume', 'ag_ORION'], { url: url() });
    expect(byId.code).toBe(0);
    expect(stub.find('GET', '/api/captains')).toHaveLength(0);

    stub.on('POST', '/api/captains/ag_ORION/resume', { error: '@cap-orion is open: tmux attach -t x' }, 409);
    const busy = await run(['captain', 'resume', '@cap-orion'], { url: url(), cwd: root });
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain('is open: tmux attach -t x');

    const missing = await run(['captain', 'resume', '@nobody'], { url: url(), cwd: root });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no captain @nobody in plutus (@cap-orion, @captain)');
  });

  test('help lines exist for the new commands', async () => {
    for (const c of ['captain', 'captains', 'title', 'whoami']) {
      const r = await run([c, '--help']);
      expect(r.stdout).toContain(`sparrow ${c}`);
    }
    expect((await run(['captain', '--help'])).stdout).toContain('adopt <@handle>');
    expect((await run(['help'])).stdout).toContain('sparrow captains [--all]');
  });
});

// ---- two sessions against a real server (sandboxed home, own port, own tmux socket)

const HAVE_SERVER = existsSync(join(REPO, 'src', 'server', 'main.ts'));
const SOCKET = `mc-cli-${process.pid}`;

describe.skipIf(!HAVE_SERVER)('two sessions, one project, end to end', () => {
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(async () => {
    for (const p of procs) { p.kill('SIGTERM'); await p.exited; }
    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('different CLAUDE_CODE_SESSION_ID → different captains, own titles, private inboxes, walled messaging', async () => {
    const base = tempDir('mc-cli-');
    const home = join(base, 'home');
    mkdirSync(join(home, 'resumes'), { recursive: true });
    writeFileSync(join(home, 'resumes', 'fake.md'), '---\nname: fake\ntitle: Fake\nharness: fake\ncan_hire: []\n---\nTest worker.\n');
    const web = join(base, 'web'); mkdirSync(web); writeFileSync(join(web, 'package.json'), '{}');
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const common = { SPARROW_HOME: home, SPARROW_PORT: String(port), SPARROW_TMUX_SOCKET: SOCKET, SPARROW_TMUX_PREFIX: 'mcc-', SPARROW_WEB_DIR: web };
    const server = Bun.spawn([process.execPath, BIN, 'up', '--port', String(port)], { env: cleanEnv(common), stdout: 'ignore', stderr: 'ignore' });
    procs.push(server);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* starting */ }
      await Bun.sleep(250);
    }
    const work = join(base, 'repo'); mkdirSync(work);
    const as = (id: string) => ({ env: { ...common, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: id }, cwd: work, url });
    const who = async (id: string) => JSON.parse((await run(['whoami', '--json'], as(id))).stdout).me;

    const a = await who('sess-A');
    const b = await who('sess-B');
    expect(a.handle).toBe('captain');
    expect(b.handle).toMatch(/^cap-/);
    expect(a.fleet_id).not.toBe(b.fleet_id);
    expect((await who('sess-A')).id).toBe(a.id);

    for (const [id, title] of [['sess-A', 'Feature A'], ['sess-B', 'Feature B']]) {
      const t = await run(['title', title], as(id));
      expect(t.stderr).toBe('');
      expect(t.code).toBe(0);
    }
    const list = await run(['captains'], as('sess-B'));
    expect(list.stdout).toContain('Feature A');
    expect(list.stdout).toMatch(new RegExp(`@${b.handle} \\(you\\)\\s+Feature B`));
    expect(list.stdout).toMatch(/@captain\s+Feature A/);

    const hired = JSON.parse((await run(['hire', 'fake', 'FAKE:done A-result', '--json'], as('sess-A'))).stdout);
    expect(hired.agent.fleet_id).toBe(a.fleet_id);
    const inA = await run(['inbox', '--wait', '30'], as('sess-A'));
    expect(inA.stdout).toContain('A-result');
    const inB = await run(['inbox'], as('sess-B'));
    expect(inB.stdout).not.toContain('A-result');
    const wall = await run(['send', `@${hired.agent.handle}`, 'hello'], as('sess-B'));
    expect(wall.code).toBe(1);
    expect(wall.stderr).toContain('team');
    const rosterB = await run(['roster'], as('sess-B'));
    expect(rosterB.stdout).not.toContain(`@${hired.agent.handle}`);
  }, 90_000);
});
