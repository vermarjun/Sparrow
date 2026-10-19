import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StubServer, agent, captain, msg, project, run, tempDir } from './helpers';

const stub = new StubServer(4131);
const url = stub.url;
const AGENT = { SPARROW_AGENT_ID: 'ag_JAMES' };

afterAll(() => stub.stop());
beforeEach(() => {
  stub.reset();
  stub.on('POST', '/api/captains/register', { agent: captain, project, inbox: [] });
  stub.on('GET', '/api/whoami', { agent: agent(), project, parent: captain, inbox: [] });
  stub.on('GET', '/api/projects/resolve', project);
});

const ok = (r: { code: number; stderr: string }) => {
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr}`);
};
const r0 = (r: { code: number; stdout: string; stderr: string }) => { ok(r); return r.stdout.trim(); };

describe('identity', () => {
  test('captain mode registers with cwd, then calls with the returned id', async () => {
    const cwd = tempDir();
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    const r = await run(['update', 'hello'], { url, cwd });
    ok(r);
    const reg = stub.find('POST', '/api/captains/register');
    expect(reg.length).toBe(1);
    expect(reg[0].body.cwd).toBe(cwd);
    expect(reg[0].agent).toBeNull();
    expect(reg[0].body.harness).toBeUndefined();
    const upd = stub.find('POST', '/api/update')[0];
    expect(upd.agent).toBe('ag_CAPTAIN');
    expect(upd.body).toEqual({ text: 'hello' });
  });

  test('captain mode detects the harness from env', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    ok(await run(['update', 'x'], { url, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-1' } }));
    expect(stub.find('POST', '/api/captains/register')[0].body).toMatchObject({ harness: 'claude', session_id: 'sess-1' });
    stub.requests = [];
    ok(await run(['update', 'x'], { url, env: { CODEX_THREAD_ID: 't-9' } }));
    expect(stub.find('POST', '/api/captains/register')[0].body).toMatchObject({ harness: 'codex', session_id: 't-9' });
    stub.requests = [];
    ok(await run(['update', 'x'], { url, env: { OPENCODE: '1' } }));
    expect(stub.find('POST', '/api/captains/register')[0].body).toMatchObject({ harness: 'opencode' });
  });

  test('agent mode uses SPARROW_AGENT_ID and never registers', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    ok(await run(['update', 'did X; next Y'], { url, env: AGENT }));
    expect(stub.find('POST', '/api/captains/register').length).toBe(0);
    expect(stub.find('POST', '/api/update')[0].agent).toBe('ag_JAMES');
  });

  test('D11: an agent window that lost SPARROW_AGENT_ID is refused, never registered as a captain', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    for (const cmd of [['update', 'x'], ['whoami'], ['roster'], ['inbox']]) {
      const r = await run(cmd, { url, env: { SPARROW_WINDOW: 'ag_JAMES' } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('inside agent window ag_JAMES but SPARROW_AGENT_ID is unset');
      expect(r.stderr).toContain('(unset SPARROW_AGENT_ID SPARROW_URL SPARROW_CALL_ID; bun test)');
    }
    // windows opened before the marker existed are recognised by SPARROW_HARNESS
    const old = await run(['update', 'x'], { url, env: { SPARROW_HARNESS: 'claude' } });
    expect(old.code).toBe(1);
    expect(old.stderr).toContain('SPARROW_AGENT_ID is unset');
    expect(stub.find('POST', '/api/captains/register').length).toBe(0);
    expect(stub.find('POST', '/api/update').length).toBe(0);
  });

  test('D11: the marker does not break an agent with its id, nor a human captain without one', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    ok(await run(['update', 'x'], { url, env: { ...AGENT, SPARROW_WINDOW: 'ag_JAMES' } }));
    expect(stub.find('POST', '/api/captains/register').length).toBe(0);
    ok(await run(['update', 'x'], { url, env: { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' } }));
    expect(stub.find('POST', '/api/captains/register').length).toBe(1);
  });

  test('whoami prints identity', async () => {
    const r = await run(['whoami'], { url, env: AGENT });
    ok(r);
    expect(r.stdout).toContain('@james — Builder (builder) · claude·opus/high · working');
    expect(r.stdout).toContain('parent @captain');
    expect(r.stdout).toContain('tmux attach -t sparrow-plutus \\; select-window -t james');
  });
});

describe('hire', () => {
  test('prints visible model and effort overrides returned by the server', async () => {
    stub.on('POST', '/api/hire', {
      agent: agent({ model: 'opus', effort: 'high' }),
      message: msg({ meta: { override: {
        model: { resume: 'sonnet', used: 'opus' },
        effort: { resume: 'low', used: 'high' },
      } } }),
      inbox: [],
    });
    const r = await run(['hire', 'builder', 'Build it'], { url });
    ok(r);
    expect(r.stdout).toContain('Override: model opus (resume says sonnet).');
    expect(r.stdout).toContain('Override: effort high (resume says low).');
  });

  test('sends every flag and an absolute cwd', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'wt'));
    stub.on('POST', '/api/hire', (r: any) => ({
      agent: agent({ handle: r.body.name, tmux_session: r.body.tmux_session, tmux_window: r.body.tmux_window, cwd: r.body.cwd }),
      message: msg(), inbox: [],
    }));
    const r = await run(['hire', 'builder', 'Build', 'the', 'login', '--name', '@Maya', '--cwd', 'wt', '--tmux-session', 'work',
      '--tmux-window', 'w1', '--card', '#4', '--model', 'sonnet', '--effort', 'low'], { url, cwd });
    ok(r);
    expect(stub.find('POST', '/api/hire')[0].body).toEqual({
      resume: 'builder', task: 'Build the login', cwd: join(cwd, 'wt'), name: 'Maya', tmux_session: 'work',
      tmux_window: 'w1', card_id: 4, model: 'sonnet', effort: 'low',
    });
    expect(r.stdout).toContain('Hired @Maya — Builder (builder)');
    expect(r.stdout).toContain('tmux attach -t work \\; select-window -t w1');
  });

  test('defaults cwd to process.cwd()', async () => {
    const cwd = tempDir();
    stub.on('POST', '/api/hire', { agent: agent({ state: 'queued' }), message: msg(), inbox: [] });
    const r = await run(['hire', 'verifier', 'check it'], { url, cwd });
    ok(r);
    expect(stub.find('POST', '/api/hire')[0].body).toEqual({ resume: 'verifier', task: 'check it', cwd });
    expect(r.stdout).toContain('queued (max_running reached');
  });

  test('task from stdin with -', async () => {
    stub.on('POST', '/api/hire', { agent: agent(), message: msg(), inbox: [] });
    const task = 'Goal: "quotes" and `ticks` and $HOME\nline 2\n';
    ok(await run(['hire', 'builder', '-', '--name', 'leo'], { url, stdin: task }));
    expect(stub.find('POST', '/api/hire')[0].body.task).toBe(task.trim());
  });

  test('usage errors exit 2', async () => {
    let r = await run(['hire'], { url });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: sparrow hire');
    r = await run(['hire', 'builder'], { url });
    expect(r.code).toBe(2);
    r = await run(['hire', 'builder', 'x', '--cwd', '/definitely/not/here'], { url });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not a directory');
    r = await run(['hire', 'builder', 'x', '--card', 'abc'], { url });
    expect(r.code).toBe(2);
    r = await run(['hire', 'builder', 'x', '--bogus'], { url });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown option '--bogus'");
    expect(stub.find('POST', '/api/hire').length).toBe(0);
  });

  test('server error → exit 1 with the server message', async () => {
    stub.on('POST', '/api/hire', { error: '@james (builder) may not hire builder: can_hire = []' }, 403);
    const r = await run(['hire', 'builder', 'x'], { url, env: AGENT });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('@james (builder) may not hire builder: can_hire = []');
  });
});

describe('messages', () => {
  test('send DM normalises the handle; --card', async () => {
    stub.on('POST', '/api/send', { message: msg({ kind: 'chat' }), inbox: [] });
    const r = await run(['send', 'james', 'use', 'redis', '--card', 'PLU-3'], { url, env: AGENT });
    ok(r);
    expect(stub.find('POST', '/api/send')[0].body).toEqual({ to: '@james', text: 'use redis', card_id: 3 });
    expect(r.stdout).toContain('Sent to @james.');
  });

  test('send group / log group → usage error: group chat was removed (nothing sent)', async () => {
    for (const args of [['send', 'group', '@maya sync please'], ['send', '@group', 'hi'], ['log', 'group'], ['log', 'GROUP']]) {
      const r = await run(args, { url, env: AGENT });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('group chat was removed');
      expect(r.stderr).not.toContain('group]'); // usage strings drop group
    }
    expect(r0(await run(['send', '--help'], { url }))).toBe('usage: sparrow send <@handle> "<text>" [--card N]');
    expect(r0(await run(['log', '--help'], { url }))).toBe('usage: sparrow log [@handle] [-n 30]');
    expect(stub.requests.length).toBe(0);
  });

  test('send/update/ask/done without text → exit 2', async () => {
    for (const args of [['send', '@x'], ['update'], ['ask'], ['done'], ['send']]) {
      const r = await run(args, { url, env: AGENT });
      expect(r.code).toBe(2);
    }
    expect(stub.requests.length).toBe(0);
  });

  test('update from stdin keeps the text verbatim', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    const text = 'did `x` with "y"; next $z';
    ok(await run(['update', '-', '--card', '7'], { url, env: AGENT, stdin: text + '\n' }));
    expect(stub.find('POST', '/api/update')[0].body).toEqual({ text, card_id: 7 });
  });

  test('piggyback inbox is printed after the result, grouped by sender', async () => {
    stub.on('POST', '/api/update', {
      message: msg({ kind: 'update' }),
      inbox: [
        msg({ seq: 9, id: 'msg_9', thread: 'dm:ag_JAMES:ag_MAYA', thread_label: 'dm @james ↔ @maya', kind: 'chat', from_id: 'ag_MAYA', from_handle: 'maya', text: 'the API is at /api/v2', created_at: Date.UTC(2026, 9, 13, 14, 5, 7) }),
        msg({ seq: 4, id: 'msg_4', text: 'Build the login page\nwith tests', card_id: 3 }),
      ],
    });
    const r = await run(['update', 'progress'], { url, env: AGENT });
    ok(r);
    expect(r.stdout).toBe([
      'Update posted.',
      '',
      '━━ 📨 2 new messages for @james ━━',
      '── @captain (DM) ──',
      '  14:02:00  task · card #3',
      '    Build the login page',
      '    with tests',
      '── @maya (DM) ──',
      '  14:05:07  DM  the API is at /api/v2',
      '━━ Act on these before you finish. ━━',
      '',
    ].join('\n'));
  });
});

describe('done / ask / wait', () => {
  test('done ended:true prints the close line', async () => {
    stub.on('POST', '/api/done', { ended: true, message: msg({ kind: 'result' }), inbox: [] });
    const summary = '## Result\nok\n## Evidence\n`bun test` → 3 pass\n';
    const r = await run(['done', '--status', 'blocked', '-'], { url, env: AGENT, stdin: summary });
    ok(r);
    expect(stub.find('POST', '/api/done')[0].body).toEqual({ summary: summary.trim(), status: 'blocked' });
    expect(r.stdout.trim()).toBe('Reported. This session will now close — stop here; you will be resumed with full memory when someone messages you.');
  });

  test('done ended:false prints the inbox then "Not sent"', async () => {
    stub.on('POST', '/api/done', { ended: false, message: msg({ kind: 'result' }), inbox: [msg({ kind: 'chat', text: 'also add tests' })] });
    const r = await run(['done', 'all good'], { url, env: AGENT });
    ok(r);
    expect(stub.find('POST', '/api/done')[0].body).toEqual({ summary: 'all good' });
    expect(r.stdout).toBe([
      '━━ 📨 1 new message for @james ━━',
      '── @captain (DM) ──',
      '  14:02:00  DM  also add tests',
      '━━ Act on these before you finish. ━━',
      'Not sent: new messages arrived (above). Handle them, then run sparrow done again with your complete report.',
      '',
    ].join('\n'));
  });

  test('done --status must be ok|blocked|failed', async () => {
    const r = await run(['done', 'x', '--status', 'great'], { url, env: AGENT });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--status must be ok, blocked or failed');
  });

  test('ask and wait', async () => {
    stub.on('POST', '/api/ask', { ended: true, message: msg({ kind: 'question' }), inbox: [] });
    stub.on('POST', '/api/wait', { ended: true, message: msg({ kind: 'update' }), inbox: [] });
    let r = await run(['ask', 'which', 'db?'], { url, env: AGENT });
    ok(r);
    expect(stub.find('POST', '/api/ask')[0].body).toEqual({ question: 'which db?' });
    expect(r.stdout).toContain('Reported. This session will now close');
    r = await run(['wait'], { url, env: AGENT });
    ok(r);
    expect(stub.find('POST', '/api/wait')[0].body).toEqual({});
    r = await run(['wait', 'builders working'], { url, env: AGENT });
    ok(r);
    expect(stub.find('POST', '/api/wait')[1].body).toEqual({ reason: 'builders working' });
  });

  test('human captain gets a captain-appropriate line', async () => {
    stub.on('POST', '/api/wait', { ended: true, message: null, inbox: [] });
    const r = await run(['wait', 'hires working'], { url });
    ok(r);
    expect(r.stdout).toContain('sparrow inbox --wait 600');
    expect(r.stdout).not.toContain('session will now close');
  });
});

describe('inbox', () => {
  test('empty inbox', async () => {
    stub.on('GET', '/api/inbox', { inbox: [] });
    const r = await run(['inbox'], { url, env: AGENT });
    ok(r);
    expect(r.stdout.trim()).toBe('No new messages.');
  });

  test('--wait: messages grouped by agent with hh:mm:ss, result in full, then the "Still working" digest', async () => {
    const at = (h: number, m: number, s: number) => Date.UTC(2026, 9, 13, h, m, s);
    const fromJames = { from_handle: 'james', from_id: 'ag_JAMES', to_handles: [] as string[] };
    const maya = agent({ id: 'ag_MAYA', handle: 'maya', resume: 'builder', state: 'waiting' });
    const now = Date.now();
    stub.on('GET', '/api/agents', [maya, agent(), captain]);
    stub.on('GET', '/api/inbox', {
      inbox: [
        msg({ ...fromJames, seq: 2, id: 'm2', kind: 'update', text: 'schema done; next API', created_at: at(14, 2, 10) }),
        msg({ seq: 5, id: 'm5', from_id: 'ag_MAYA', from_handle: 'maya', thread: 'dm:ag_CAPTAIN:ag_MAYA', thread_label: 'dm @captain ↔ @maya', kind: 'question', text: 'Which port?', to_handles: ['captain'], created_at: at(14, 6, 0) }),
        msg({ ...fromJames, seq: 6, id: 'm6', kind: 'result', meta: { status: 'ok', call_ms: 302_000 }, text: '## Result\nlogin page done', to_handles: ['captain'], created_at: at(14, 7, 12) }),
        msg({ ...fromJames, seq: 3, id: 'm3', kind: 'update', text: 'API done; tests next', created_at: at(14, 4, 55) }),
      ],
      team: [
        { handle: 'leo', resume: 'builder-codex', harness: 'codex', state: 'working', call_started_at: now - 12 * 60_000 - 5000, last_update: 'wiring the API', last_update_at: now - 8 * 60_000 - 5000 },
        { handle: 'iris', resume: 'verifier', harness: 'codex', state: 'working', call_started_at: now - 3 * 60_000 - 5000, last_update: 'old call', last_update_at: now - 60 * 60_000 },
        { handle: 'quinn', resume: 'builder', harness: 'claude', state: 'waiting', call_started_at: null, last_update: null, last_update_at: null },
      ],
    });
    const r = await run(['inbox', '--wait', '5'], { url });
    ok(r);
    expect(stub.find('GET', '/api/inbox')[0].path).toBe('/api/inbox?wait=5');
    expect(stub.find('GET', '/api/inbox')[0].agent).toBe('ag_CAPTAIN');
    expect(r.stdout).toBe([
      '━━ 📨 4 new messages for @captain ━━',
      '── @james · builder · done ok · call 5m02s ──',
      '  14:02:10  update  schema done; next API',
      '  14:04:55  update  API done; tests next',
      '  14:07:12  result (ok)',
      '    ## Result',
      '    login page done',
      '── @maya (DM) ──',
      '  14:06:00  question  Which port?',
      '━━ Act on these before you finish. ━━',
      '',
      'Still working:',
      '  @leo · builder-codex · working 12m · last update 8m ago: wiring the API',
      '  @iris · verifier · working 3m · no update yet',
      '  @quinn · builder · waiting · no update yet',
      '',
    ].join('\n'));
    const j = JSON.parse((await run(['--json', 'inbox'], { url })).stdout);
    expect(j.team.map((t: any) => t.handle)).toEqual(['leo', 'iris', 'quinn']);
  });

  test('timeout: "No new messages (waited Ns)." then the digest; nobody busy → just the first line', async () => {
    const now = Date.now();
    stub.on('GET', '/api/inbox', { inbox: [], team: [{ handle: 'leo', resume: 'builder-codex', harness: 'codex', state: 'working', call_started_at: now - 65 * 60_000, last_update: 'a\nmulti-line   update', last_update_at: now - 30_000 }] });
    let r = await run(['inbox', '--wait', '1'], { url });
    ok(r);
    expect(r.stdout).toBe([
      'No new messages (waited 1s).',
      'Still working:',
      '  @leo · builder-codex · working 1h05m · last update 30s ago: a multi-line update',
      '',
    ].join('\n'));
    stub.on('GET', '/api/inbox', { inbox: [], team: [] });
    r = await run(['inbox', '--wait', '1'], { url });
    expect(r.stdout).toBe('No new messages (waited 1s).\n');
  });

  test('--wait over 600 is a usage error', async () => {
    const r = await run(['inbox', '--wait', '601'], { url });
    expect(r.code).toBe(2);
  });

  test('superseded wait prints the stopped message and exits successfully', async () => {
    stub.on('GET', '/api/inbox', { inbox: [], team: [], superseded: true });
    const r = await run(['inbox', '--wait', '5'], { url, env: AGENT });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Stopped: a newer `sparrow inbox --wait` took over. Nothing was taken from your inbox.\n');
  });

  test('--last prints a recovery block and defaults to 10', async () => {
    stub.on('GET', '/api/agents', [agent(), captain]);
    stub.on('GET', '/api/inbox', { inbox: [
      msg({ seq: 1, id: 'old', text: 'already finished' }),
    ], team: [] });
    let r = await run(['inbox', '--last'], { url });
    ok(r);
    expect(stub.find('POST', '/api/captains/register')[0].path).toBe('/api/captains/register?no_inbox=1');
    expect(stub.find('GET', '/api/inbox')[0].path).toBe('/api/inbox?last=10');
    expect(r.stdout).toContain('━━ 📨 1 already delivered message for @captain ━━');
    expect(r.stdout).toContain('  14:02:00  task  already finished');

    stub.requests = [];
    r = await run(['inbox', '--last', '2'], { url });
    ok(r);
    expect(stub.find('GET', '/api/inbox')[0].path).toBe('/api/inbox?last=2');
  });

  test('--last rejects counts outside 1..50', async () => {
    const r = await run(['inbox', '--last', '51'], { url, env: AGENT });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--last must be between 1 and 50');
  });

  test('system notices are grouped under the agent they are about (meta.about), with its updates', async () => {
    stub.on('GET', '/api/agents', [agent({ id: 'ag_MAYA', handle: 'maya', resume: 'builder-codex' }), captain]);
    stub.on('GET', '/api/inbox', { inbox: [
      msg({ seq: 1, from_id: 'ag_MAYA', from_handle: 'maya', thread: 'dm:ag_CAPTAIN:ag_MAYA', thread_label: 'dm @captain ↔ @maya', kind: 'update', text: 'half way', to_handles: [] }),
      msg({ seq: 2, id: 'm2', from_id: 'system', from_handle: 'system', kind: 'system', meta: { about: 'ag_MAYA', fyi: true }, thread: 'dm:ag_CAPTAIN:ag_MAYA', thread_label: 'dm @captain ↔ @maya', text: '@maya crashed (exit 1); restarting', to_handles: [] }),
      msg({ seq: 3, id: 'm3', from_id: 'system', from_handle: 'system', kind: 'system', text: '@james stopped without reporting.\nSend @james a message to resume it.' }),
    ] });
    const r = await run(['inbox'], { url });
    expect(r.stdout).toBe([
      '━━ 📨 3 new messages for @captain ━━',
      '── @maya · builder-codex ──',
      '  14:02:00  update  half way',
      '  14:02:00  system  @maya crashed (exit 1); restarting',
      '── @james ──', // no meta.about and unknown to the roster: named from the DM thread
      '  14:02:00  system',
      '    @james stopped without reporting.',
      '    Send @james a message to resume it.',
      '━━ Act on these before you finish. ━━',
      '',
    ].join('\n'));
  });
});

describe('roster / resumes / log / status', () => {
  test('roster: hierarchy order, retired hidden unless --all', async () => {
    const maya = agent({ id: 'ag_MAYA', handle: 'maya', parent_id: 'ag_JAMES', depth: 2, state: 'idle', created_at: 3 });
    const old = agent({ id: 'ag_OLD', handle: 'old', state: 'retired', created_at: 2 });
    const james = agent({ last_update: 'did X; next Y', last_update_at: Date.now() - 3 * 60_000, created_at: 1 });
    stub.on('GET', '/api/agents', [maya, old, james, captain]);
    let r = await run(['roster'], { url });
    ok(r);
    expect(stub.find('GET', '/api/agents')[0].path).toBe('/api/agents?project=plutus');
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('Project plutus — 3 agents (1 retired hidden; --all)');
    expect(lines[1]).toMatch(/^HANDLE\s+RESUME\s+HARNESS\s+STATE\s+PARENT\s+LAST UPDATE$/);
    expect(lines[2]).toMatch(/^@captain \(you\)\s+captain\s+human\s+-\s+-\s+-$/);
    expect(lines[3]).toMatch(/^@james\s+builder\s+claude·opus\/high\s+working\s+@captain\s+did X; next Y \(3m ago\)$/);
    expect(lines[4]).toMatch(/^@maya\s+builder\s+claude·opus\/high\s+idle\s+@james\s+-$/);
    r = await run(['roster', '--all'], { url });
    expect(r.stdout).toContain('@old');
  });

  test('resumes directory', async () => {
    stub.on('GET', '/api/resumes', [
      { slug: 'sub-captain', title: 'Sub-captain', description: 'Owns a slice.', harness: 'claude', model: 'opus', effort: 'high', can_hire: ['builder', 'verifier'], limits: { quiet_minutes: 20, max_call_minutes: 120 }, body: '', path: '' },
      { slug: 'builder', title: 'Builder', description: 'Implements one task.', harness: 'claude', model: 'opus', effort: 'high', can_hire: [], limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: '', path: '' },
    ]);
    const r = await run(['resumes'], { url });
    ok(r);
    expect(stub.find('POST', '/api/captains/register').length).toBe(0);
    expect(r.stdout).toBe([
      'builder — Builder [claude · opus · effort high]',
      '  Implements one task.',
      '  status: unchecked',
      '  can hire: nobody',
      'sub-captain — Sub-captain [claude · opus · effort high]',
      '  Owns a slice.',
      '  status: unchecked',
      '  can hire: builder, verifier',
      '',
      'Hire: sparrow hire <slug> "<task>"',
      '',
    ].join('\n'));
  });

  test('resumes render template variables in the description from the resume\'s current settings', async () => {
    stub.on('GET', '/api/resumes', [
      { slug: 'builder', title: 'Builder', description: 'Builds ({{runtime}}) on {{harness}}; {{x}}.', harness: 'claude', model: 'sonnet', effort: null, can_hire: [], limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: '', path: '' },
    ]);
    const r = await run(['resumes'], { url });
    ok(r);
    expect(r.stdout).toContain('builder — Builder [claude · sonnet · effort default]\n  Builds (claude · sonnet · effort default) on claude; {{x}}.\n');
  });

  test('resumes show resolved aliases and refuse-looking unusable status', async () => {
    stub.on('GET', '/api/resumes', [
      { slug: 'broken', title: 'Broken', description: 'Old model.', harness: 'claude', model: 'opus', effort: 'low', can_hire: [], status: 'model_gone', resolved_model: 'claude-opus-retired', status_detail: 'model no longer offered' },
    ]);
    const r = await run(['resumes'], { url });
    ok(r);
    expect(r.stdout).toContain('opus → claude-opus-retired');
    expect(r.stdout).toContain('status: model_gone — UNUSABLE: do not hire · model no longer offered');
  });

  test('log pages through messages and filters by handle', async () => {
    const all = Array.from({ length: 150 }, (_, i) => msg({
      seq: i + 1, id: `msg_${i + 1}`, kind: 'chat', text: `m${i + 1}`,
      from_handle: i % 2 ? 'maya' : 'james', to_handles: i % 2 ? ['leo'] : ['captain'],
    }));
    stub.on('GET', '/api/messages', (r: any) => {
      const after = Number(new URL('http://x' + r.path).searchParams.get('after') ?? 0);
      return all.filter((m) => m.seq > after).slice(0, 100);
    });
    let r = await run(['log', '@james', '-n', '3'], { url, env: AGENT });
    ok(r);
    expect(stub.find('GET', '/api/messages').map((x) => x.path)).toEqual([
      '/api/messages?project=plutus&after=0&limit=100',
      '/api/messages?project=plutus&after=100&limit=100',
    ]);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('Log @james · project plutus · last 3');
    expect(lines.slice(1)).toEqual(['14:02 @james → @captain: m145', '14:02 @james → @captain: m147', '14:02 @james → @captain: m149']);
    r = await run(['log', '-n', '2'], { url, env: AGENT });
    expect(r.stdout).toContain('@maya → @leo: m150');
    expect(r.stdout).toContain('m149');
  });

  test('status: server up with working agents', async () => {
    stub.on('GET', '/api/health', { ok: true, version: '0.1.0', pid: 42, started_at: Date.now() - 120_000 });
    stub.on('GET', '/api/projects', [{ ...project, agents: 2, working: 1, cards: 0 }]);
    stub.on('GET', '/api/agents', [agent(), captain]);
    const r = await run(['status'], { url });
    ok(r);
    expect(r.stdout).toContain('Sparrow server: up');
    expect(r.stdout).toContain('pid 42');
    expect(r.stdout).toContain('Working (1):');
    expect(r.stdout).toContain('tmux attach -t sparrow-plutus \\; select-window -t james');
    expect(stub.find('POST', '/api/captains/register').length).toBe(0);
  });

  test('status: server down → exit 1, fast', async () => {
    const t = Date.now();
    const r = await run(['status'], { url: 'http://127.0.0.1:4139' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('not running');
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('board', () => {
  const card = { id: 4, project_id: 'plutus', title: 'Rate limit', details: '5/15min', category: 'api', state: 'todo', position: 1, assignee_id: 'ag_JAMES', created_by: 'ag_CAPTAIN', notes: [{ at: 1, by: 'x', text: 'n1' }], created_at: 1, updated_at: 1, context: '', problem: '', approach: '', checks: [], tags: [], urgent: false, impact: null, effort: null, estimate_min: null, blocked_on: null, blocked_at: null, later_at: null, history: [] };

  test('propose', async () => {
    stub.on('POST', '/api/propose', { card: { ...card, state: 'proposed' }, inbox: [] });
    const r = await run(['propose', 'Add', 'rate', 'limit', '--details', 'why', '--category', 'api'], { url, env: AGENT });
    ok(r);
    expect(stub.find('POST', '/api/propose')[0].body).toEqual({ title: 'Add rate limit', details: 'why', category: 'api' });
    expect(r.stdout).toContain('Proposed PLU-4');
  });

  test('card list / add / move / assign / note', async () => {
    stub.on('GET', '/api/agents', [agent(), captain]);
    stub.on('GET', '/api/cards', [card, { ...card, id: 5, title: 'Old', state: 'dropped', assignee_id: null, notes: [] }]);
    stub.on('POST', '/api/cards', { card });
    stub.on('PATCH', '/api/cards/4', { card });
    let r = await run(['card', 'list'], { url });
    ok(r);
    expect(r.stdout).toContain('To do (1)\n  PLU-4 Rate limit · api · 20745d · @james');
    expect(r.stdout).not.toContain('Old');
    r = await run(['card'], { url });
    ok(r);
    expect(r.stdout).toContain('PLU-4 Rate limit');

    ok(await run(['card', 'add', 'Rate limit', '--details', 'd', '--state', 'in-progress', '--assignee', 'james'], { url }));
    expect(stub.find('POST', '/api/cards')[0].body).toEqual({ title: 'Rate limit', details: 'd', state: 'in_progress', assignee: '@james' });

    ok(await run(['card', 'move', '4', 'review'], { url }));
    ok(await run(['card', 'assign', '#4', 'none'], { url }));
    ok(await run(['card', 'assign', '4', '@maya'], { url }));
    ok(await run(['card', 'note', '4', 'merged', 'in', 'a1b2'], { url }));
    expect(stub.find('PATCH', '/api/cards/4').map((x) => x.body)).toEqual([
      { state: 'review' }, { assignee: null }, { assignee: '@maya' }, { note: 'merged in a1b2' },
    ]);
  });

  test('card usage errors', async () => {
    for (const args of [['card', 'move', '4', 'shipped'], ['card', 'move', 'x', 'done'], ['card', 'frob'], ['card', 'note', '4']]) {
      const r = await run(args, { url });
      expect(r.code).toBe(2);
    }
    expect(stub.find('PATCH', '/api/cards/4').length).toBe(0);
  });

  test('propose passes all ticket flags and repeated values', async () => {
    stub.on('POST', '/api/propose', { card: { ...card, state: 'proposed' }, inbox: [] });
    const r = await run(['propose', 'Add', 'a', 'cap', '--context', 'why now', '--problem', 'Observed x; expected y', '--approach', 'Use plain English',
      '--check', 'First check', '--check', 'Second check', '--category', 'Board', '--tag', 'UI', '--tag', 'planning', '--urgent',
      '--return', 'high', '--effort', 'low', '--estimate', '2h', '--details', 'legacy', '--blocked', 'IT access'], { url, env: AGENT });
    ok(r);
    expect(stub.find('POST', '/api/propose')[0].body).toEqual({
      title: 'Add a cap', context: 'why now', problem: 'Observed x; expected y', approach: 'Use plain English', checks: ['First check', 'Second check'],
      category: 'Board', tags: ['UI', 'planning'], urgent: true, impact: 'high', effort: 'low', estimate_min: '2h', details: 'legacy', blocked_on: 'IT access',
    });
  });

  test('card show, pick, edit, block, later, urgent and check use normalized refs', async () => {
    stub.on('GET', '/api/agents', [agent(), captain]);
    stub.on('GET', '/api/cards/4', card);
    stub.on('PATCH', '/api/cards/4', { card });
    const shown = await run(['card', 'show', '#4'], { url });
    ok(shown);
    expect(stub.find('GET', '/api/cards/4')).toHaveLength(1);
    expect(shown.stdout).toContain('# PLU-4 · Rate limit');
    expect(shown.stdout).toContain('Timing: proposed');

    ok(await run(['card', 'pick', 'PLU-4'], { url }));
    ok(await run(['card', 'edit', '#4', '--title', 'Cap requests', '--context', 'why', '--check', 'One', '--check', 'Two', '--tag', 'UI', '--tag', 'API',
      '--category', 'none', '--impact', 'none', '--effort', 'high', '--estimate', '90m', '--urgent', 'off', '--later', 'on', '--blocked', 'off', '--details', 'more'], { url }));
    ok(await run(['card', 'block', 'PLU-4', 'IT access'], { url }));
    ok(await run(['card', 'unblock', '#4'], { url }));
    ok(await run(['card', 'later', 'PLU-4'], { url }));
    ok(await run(['card', 'urgent', '#4', '--undo'], { url }));
    ok(await run(['card', 'check', 'PLU-4', '2'], { url }));
    expect(stub.find('PATCH', '/api/cards/4').map((x) => x.body)).toEqual([
      { assignee: 'me', state: 'in_progress' },
      { title: 'Cap requests', context: 'why', checks: ['One', 'Two'], tags: ['UI', 'API'], category: null, impact: null, effort: 'high', estimate_min: '90m', blocked_on: null, urgent: false, later: true, details: 'more' },
      { blocked_on: 'IT access' }, { blocked_on: null }, { later: true }, { urgent: false }, { check: { index: 1, done: true } },
    ]);
  });

  test('card show labels an untouched build and small estimate ratios', async () => {
    stub.on('GET', '/api/agents', [agent(), captain]);
    const started = Date.now() - 30_000;
    stub.on('GET', '/api/cards/4', {
      ...card, state: 'todo', created_at: started, estimate_min: 120,
      history: [{ at: started, by: 'captain', from: null, to: 'todo' }],
    });
    const untouched = await run(['card', 'show', '4'], { url });
    ok(untouched);
    expect(untouched.stdout).toContain('build not started');
    expect(untouched.stdout).toContain('est 2h → not started');

    const tinyBuildStarted = Date.now() - 10_000;
    stub.on('GET', '/api/cards/4', {
      ...card, state: 'in_progress', created_at: tinyBuildStarted, estimate_min: 60,
      history: [{ at: tinyBuildStarted, by: 'captain', from: 'todo', to: 'in_progress' }],
    });
    const smallRatio = await run(['card', 'show', 'PLU-4'], { url });
    ok(smallRatio);
    expect(smallRatio.stdout).toContain('est 1h → <1m build (<0.1×)');
  });
});

describe('misc', () => {
  test('release', async () => {
    stub.on('POST', '/api/release', { agent: agent({ state: 'retired' }), inbox: [] });
    const r = await run(['release', 'james'], { url });
    ok(r);
    expect(stub.find('POST', '/api/release')[0].body).toEqual({ agent: '@james' });
    expect(r.stdout).toContain('Released @james');
  });

  test('--json prints the raw response', async () => {
    stub.on('POST', '/api/send', { message: msg({ kind: 'chat' }), inbox: [] });
    const r = await run(['send', '@james', 'hi', '--json'], { url });
    ok(r);
    const j = JSON.parse(r.stdout);
    expect(j.message.id).toBe('msg_1');
    expect(j.inbox).toEqual([]);
  });

  test('unknown command exits 2; help exits 0', async () => {
    let r = await run(['frobnicate'], { url });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command');
    r = await run(['help'], { url });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sparrow hire <resume>');
    r = await run(['done', '--help'], { url });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage: sparrow done');
  });

  test('server unreachable → exit 1 with a hint', async () => {
    const r = await run(['inbox'], { url: 'http://127.0.0.1:4138', env: { ...AGENT } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Start it with: sparrow up');
  }, 15_000);

  test('hook dispatches to runHook (no-op without SPARROW_AGENT_ID)', async () => {
    const r = await run(['hook', 'turn-end'], { url });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(stub.requests.length).toBe(0);
  });
});

describe('V3 fixes', () => {
  test('Bug 1: text that starts with "-" is text', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    stub.on('POST', '/api/done', { ended: true, message: msg({ kind: 'result' }), inbox: [] });
    stub.on('POST', '/api/send', { message: msg({ kind: 'chat' }), inbox: [] });
    stub.on('POST', '/api/hire', { agent: agent(), message: msg(), inbox: [] });
    for (const text of ['- fixed the bug', '-5 tests now pass', '--force push to main', '-x and -y were wrong', '—dash']) {
      const r = await run(['update', text], { url, env: AGENT });
      ok(r);
    }
    expect(stub.find('POST', '/api/update').map((x) => x.body.text)).toEqual(
      ['- fixed the bug', '-5 tests now pass', '--force push to main', '-x and -y were wrong', '—dash']);
    ok(await run(['done', '- did X', '--status', 'ok'], { url, env: AGENT }));
    expect(stub.find('POST', '/api/done')[0].body).toEqual({ summary: '- did X', status: 'ok' });
    // explicit `--`: flag-shaped words and the global flags become text
    ok(await run(['send', '@maya', '--', '--json', '-h', '--bogus'], { url, env: AGENT }));
    expect(stub.find('POST', '/api/send')[0].body).toEqual({ to: '@maya', text: '--json -h --bogus' });
    ok(await run(['hire', 'builder', '- step one', '--name', 'leo'], { url, env: AGENT }));
    expect(stub.find('POST', '/api/hire')[0].body).toMatchObject({ task: '- step one', name: 'leo' });
    // a declared string option takes a value that starts with "-"
    stub.on('POST', '/api/propose', { card: { id: 1, project_id: 'plutus', title: 't', state: 'proposed' }, inbox: [] });
    ok(await run(['propose', 'T', '--details', '- bullet'], { url, env: AGENT }));
    expect(stub.find('POST', '/api/propose')[0].body).toEqual({ title: 'T', details: '- bullet' });
    // a flag-shaped unknown token is still a usage error, with a hint
    const r = await run(['update', 'x', '--bogus'], { url, env: AGENT });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('put it after --');
  });

  test('Bug 2: piggybacked inbox survives an API error (text and --json)', async () => {
    const pending = msg({ from_id: 'ag_JAMES', from_handle: 'james', kind: 'result', meta: { status: 'ok' }, text: 'login done', to_handles: ['captain'] });
    stub.on('POST', '/api/captains/register', { agent: captain, project, inbox: [pending] });
    stub.on('POST', '/api/hire', { error: 'unknown resume "nosuch"; available: builder' }, 404);
    let r = await run(['hire', 'nosuch', 'x'], { url });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown resume "nosuch"');
    expect(r.stdout).toContain('── @james · done ok ──\n  14:02:00  result (ok)\n    login done');
    r = await run(['hire', 'nosuch', 'x', '--json'], { url });
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.error).toContain('unknown resume');
    expect(j.inbox.map((m: any) => m.text)).toEqual(['login done']);
    // generic (non-API) error path: the server answers with broken JSON
    stub.on('POST', '/api/hire', () => new Response('<html>oops', { status: 200 }));
    r = await run(['hire', 'builder', 'x'], { url });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('login done');
  });

  test('Bug 3: text is not trimmed; stdin loses exactly one trailing newline', async () => {
    stub.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    ok(await run(['update', '-'], { url, env: AGENT, stdin: '  indented first line\n\tsecond  \n\n' }));
    ok(await run(['update', '  spaced  '], { url, env: AGENT }));
    expect(stub.find('POST', '/api/update').map((x) => x.body.text)).toEqual(['  indented first line\n\tsecond  \n', '  spaced  ']);
    const r = await run(['update', '-'], { url, env: AGENT, stdin: '  \n\n' });
    expect(r.code).toBe(2);
  });

  test('Bug 4: global --json before the command', async () => {
    stub.on('GET', '/api/health', { ok: true, version: '0.1.0', pid: 42, started_at: Date.now() });
    stub.on('GET', '/api/projects', []);
    let r = await run(['--json', 'status'], { url });
    ok(r);
    expect(JSON.parse(r.stdout).health.pid).toBe(42);
    stub.on('POST', '/api/send', { message: msg({ kind: 'chat' }), inbox: [] });
    r = await run(['--json', 'send', '@james', 'hi'], { url });
    ok(r);
    expect(JSON.parse(r.stdout).message.id).toBe('msg_1');
    expect(stub.find('POST', '/api/send')[0].body).toEqual({ to: '@james', text: 'hi' });
  });

  test('A1: ended:false wording for done / ask / wait', async () => {
    const res = { ended: false, message: null, inbox: [msg({ kind: 'chat', text: 'one more thing' })] };
    stub.on('POST', '/api/done', res);
    stub.on('POST', '/api/ask', res);
    stub.on('POST', '/api/wait', res);
    const lines = await Promise.all([['done', 'x'], ['ask', 'q?'], ['wait']].map(async (a) =>
      (await run(a, { url, env: AGENT })).stdout.trim().split('\n').at(-1)));
    expect(lines).toEqual([
      'Not sent: new messages arrived (above). Handle them, then run sparrow done again with your complete report.',
      'Not sent: new messages arrived (above). Handle them; if you still need an answer, run sparrow ask again.',
      'Not sent: new messages arrived (above). Handle them, then run sparrow wait again if you are still waiting.',
    ]);
  });
});

describe('V1 bug 5: captain inbox --wait with messages already piggybacked by register', () => {
  test('prints them at once without long-polling; never says "No new messages"', async () => {
    const notice = msg({ from_id: 'system', from_handle: 'system', kind: 'system', text: '@james stopped without reporting', to_handles: ['captain'] });
    stub.on('POST', '/api/captains/register', { agent: captain, project, inbox: [notice] });
    stub.on('GET', '/api/inbox', async () => { await Bun.sleep(8000); return { inbox: [] }; });
    const t = Date.now();
    const r = await run(['inbox', '--wait', '8'], { url });
    ok(r);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(stub.find('GET', '/api/inbox').length).toBe(0);
    expect(r.stdout).toContain('── @james ──\n  14:02:00  system  @james stopped without reporting');
    expect(r.stdout).not.toContain('No new messages');
    const j = JSON.parse((await run(['--json', 'inbox', '--wait', '8'], { url })).stdout);
    expect(j.inbox.map((m: any) => m.text)).toEqual(['@james stopped without reporting']);
  }, 20_000);

  test('only quiet messages piggybacked (updates, FYI) → still long-polls; prints them with what arrives', async () => {
    const upd = msg({ seq: 3, id: 'm3', from_id: 'ag_JAMES', from_handle: 'james', kind: 'update', text: 'half way', to_handles: [] });
    const fyi = msg({ seq: 4, id: 'm4', from_id: 'system', from_handle: 'system', kind: 'system', meta: { about: 'ag_JAMES', fyi: true }, text: '@james crashed (exit 1); restarting on the same session.', to_handles: [] });
    stub.on('POST', '/api/captains/register', { agent: captain, project, inbox: [upd, fyi] });
    stub.on('GET', '/api/inbox', {
      inbox: [msg({ seq: 7, id: 'm7', from_id: 'ag_JAMES', from_handle: 'james', kind: 'result', meta: { status: 'ok' }, text: 'done', to_handles: ['captain'] })],
      team: [],
    });
    const r = await run(['inbox', '--wait', '8'], { url });
    ok(r);
    expect(stub.find('GET', '/api/inbox').map((x) => x.path)).toEqual(['/api/inbox?wait=8']);
    expect(r.stdout).toContain('━━ 📨 3 new messages for @captain ━━\n── @james · done ok ──\n  14:02:00  update  half way\n  14:02:00  system  @james crashed');
    expect(r.stdout).toContain('  14:02:00  result (ok)\n    done');
  });

  test('nothing pending → long-polls and says "No new messages (waited Ns)"', async () => {
    stub.on('GET', '/api/inbox', { inbox: [] });
    const r = await run(['inbox', '--wait', '1'], { url });
    ok(r);
    expect(stub.find('GET', '/api/inbox')[0].path).toBe('/api/inbox?wait=1');
    expect(r.stdout.trim()).toBe('No new messages (waited 1s).');
  });
});
