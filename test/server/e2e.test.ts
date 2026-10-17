// End to end: the real server in a subprocess + T2's real spawner + the `fake` harness in real tmux windows
// on a private tmux socket (-L sparrow-test-t1-e2e). Skipped when tmux or T2's spawner is missing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const PORT = 4111;
const SOCKET = 'sparrow-test-t1-e2e';
const URL = `http://127.0.0.1:${PORT}`;
const hasTmux = Bun.spawnSync(['which', 'tmux']).exitCode === 0;
const hasSpawner = existsSync(join(REPO, 'src', 'harness', 'spawner.ts'));
const run = hasTmux && hasSpawner ? describe : describe.skip;

let proc: ReturnType<typeof Bun.spawn> | null = null;
let cap = '';
const home = mkdtempSync(join(tmpdir(), 'sparrow-t1-e2e-'));
const proj = join(home, 'proj');

async function api(method: string, path: string, body?: unknown, as: string | null = cap) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-sparrow-agent'] = as;
  const r = await fetch(URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json() as Promise<any>;
}

function windows(): string[] {
  const r = Bun.spawnSync(['tmux', '-L', SOCKET, 'list-windows', '-a', '-F', '#{window_name}'], { stderr: 'ignore' });
  return r.exitCode === 0 ? r.stdout.toString().trim().split('\n').filter(Boolean) : [];
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await Bun.sleep(200);
  }
}

run('e2e with the real spawner + fake harness', () => {
  beforeAll(async () => {
    mkdirSync(join(home, 'resumes'), { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(home, 'resumes', 'fake.md'), '---\nname: fake\ntitle: Fake\ndescription: test\nharness: fake\ncan_hire: []\n---\nYou are a fake agent.\n');
    proc = Bun.spawn(['bun', join(import.meta.dir, 'run-server.ts')], {
      cwd: REPO,
      env: {
        ...process.env,
        SPARROW_HOME: home, SPARROW_PORT: String(PORT), SPARROW_URL: URL, SPARROW_TMUX_SOCKET: SOCKET,
        SPARROW_TMUX_PREFIX: 'sptest-', SPARROW_SETTINGS: JSON.stringify({ close_grace_ms: 1000, watchdog_ms: 500 }),
        SPARROW_AGENT_ID: '', SPARROW_CALL_ID: '',
      },
      stdout: Bun.file(join(home, 'server.log')), stderr: Bun.file(join(home, 'server.err')),
    });
    await until(() => fetch(URL + '/api/health').then((r) => r.ok).catch(() => false), (v) => v, 10_000);
    cap = (await api('POST', '/api/captains/register', { cwd: proj }, null)).agent.id;
  });

  afterAll(async () => {
    proc?.kill('SIGTERM');
    await proc?.exited;
    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stderr: 'ignore' });
  });

  test('hire → window → update+done → result in inbox → window closes; message → resume remembers', async () => {
    const h = await api('POST', '/api/hire', { resume: 'fake', task: 'FAKE:update hello\nFAKE:remember banana\nFAKE:done first done', name: 'james' });
    expect(h.agent.state).toBe('working');
    const started = await until(() => api('GET', `/api/agents/${h.agent.id}`, undefined, null), (d) => !!d.agent.tmux_window_id);
    expect(started.agent.tmux_window_id).toMatch(/^@\d+$/);
    expect(windows()).toContain('james');
    const r = await api('GET', '/api/inbox?wait=20');
    // the update is quiet: it did not end the wait early; it arrives bundled with the result
    expect(r.inbox.map((m: any) => [m.kind, m.text])).toEqual([['update', 'hello'], ['result', 'first done']]);
    const closed = await until(() => windows(), (w) => !w.includes('james'), 10_000);
    expect(closed).not.toContain('james');
    await api('POST', '/api/send', { to: '@james', text: 'FAKE:recall\nFAKE:done recalled' });
    const r2 = await api('GET', '/api/inbox?wait=20');
    expect(r2.inbox.map((m: any) => m.text)).toEqual(['recall: banana', 'recalled']);
    const dm = await api('GET', `/api/messages?project=proj&thread=@james`, undefined, cap);
    expect(dm.filter((m: any) => m.kind === 'update').map((m: any) => m.text)).toContain('recall: banana');
    const detail = await api('GET', `/api/agents/${h.agent.id}`, undefined, null);
    expect(detail.calls.map((c: any) => [c.resumed, c.end_reason])).toEqual([[true, 'done'], [false, 'done']]);
  }, 60_000);

  test('SSE over the real socket delivers call.started for a hire', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${URL}/api/events?project=proj`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    await api('POST', '/api/hire', { resume: 'fake', task: 'FAKE:done sse', name: 'sse' });
    const end = Date.now() + 10_000;
    while (!buf.includes('"call.started"') && Date.now() < end) buf += dec.decode((await reader.read()).value);
    ctrl.abort();
    expect(buf).toContain('"call.started"');
    expect(buf).toContain('"agent.updated"');
    await api('GET', '/api/inbox?wait=20');
  }, 30_000);

  test('killed window → watchdog restarts on the same session; parent is told', async () => {
    const h = await api('POST', '/api/hire', { resume: 'fake', task: 'FAKE:update working\nFAKE:sleep 60', name: 'victim' });
    await until(() => api('GET', `/api/agents/${h.agent.id}`, undefined, null), (d) => d.agent.last_update === 'working');
    const win = (await api('GET', `/api/agents/${h.agent.id}`, undefined, null)).agent.tmux_window_id;
    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-window', '-t', win]);
    const r = await api('GET', '/api/inbox?wait=20');
    const got = r.inbox.map((m: any) => `${m.kind}: ${m.text}`);
    if (got.at(-1) !== 'result: fake: done') console.error('SERVER LOG:\n' + (await Bun.file(join(home, 'server.log')).text()));
    // the FYI restart notice (and the updates) are quiet: they did not end the wait; they arrive bundled with the result
    expect(got.filter((g: string) => !g.startsWith('update: '))).toEqual(['system: @victim crashed (exit -1); restarting on the same session.', 'result: fake: done']);
    const thread = await api('GET', `/api/messages?project=proj&thread=@victim`, undefined, cap);
    const fyi = thread.find((m: any) => m.kind === 'system');
    expect(fyi.text).toBe('@victim crashed (exit -1); restarting on the same session.');
    expect(fyi.mentions).toEqual([]);
    const detail = await until(() => api('GET', `/api/agents/${h.agent.id}`, undefined, null), (d) => d.calls.length === 2 && d.calls[0].end_reason === 'done');
    expect(detail.calls[1]).toMatchObject({ end_reason: 'crashed', exit_code: -1 });
    expect(detail.calls[0].resumed).toBe(true);
  }, 60_000);
});
