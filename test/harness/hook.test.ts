import { TEST_HOME, nextPort } from './helpers';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startStub, type Stub } from './stub-server';
import { isCodexTitleTurn, lastAssistantFromTranscript } from '../../src/cli/hook';
import { REPO_ROOT } from '../../src/shared/config';

const HOOK = join(REPO_ROOT, 'src', 'cli', 'hook.ts');
let stub: Stub;

beforeAll(() => {
  stub = startStub(nextPort());
});
afterAll(() => stub.stop());

async function hook(args: string[], opts: { env?: Record<string, string | undefined>; stdin?: string } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, SPARROW_URL: stub.url, SPARROW_AGENT_ID: 'ag_h1', SPARROW_CALL_ID: 'call_h1', ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const p = Bun.spawn([process.execPath, HOOK, ...args], {
    env: env as Record<string, string>,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe('sparrow hook', () => {
  test('no-op without SPARROW_AGENT_ID (prints nothing, exit 0, no request)', async () => {
    stub.clear();
    for (const kind of ['claude-stop', 'exit', 'turn-end', 'codex-notify']) {
      const r = await hook([kind, '--code', '1'], { env: { SPARROW_AGENT_ID: undefined }, stdin: '{"session_id":"x"}' });
      expect(r).toEqual({ out: '', err: '', code: 0 });
    }
    await Bun.sleep(200);
    expect(stub.records.length).toBe(0);
  });

  test('claude-stop: posts turn-end with session, stop_hook_active, last message; prints block decision', async () => {
    stub.clear();
    stub.setTurnEnd(() => ({ action: 'block', reason: 'NUDGE: report!' }));
    const transcript = join(TEST_HOME, 't.jsonl');
    await Bun.write(transcript, [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }] } }),
      '',
    ].join('\n'));
    const r = await hook(['claude-stop'], { stdin: JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, stop_hook_active: true, hook_event_name: 'Stop' }) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ decision: 'block', reason: 'NUDGE: report!' });
    const rec = stub.find('/api/hooks/turn-end')[0];
    expect(rec.agent).toBe('ag_h1');
    expect(rec.call).toBe('call_h1');
    expect(rec.body).toEqual({ harness: 'claude', session_id: 'sess-1', last_message: 'final answer', stop_hook_active: true });
  });

  test('claude-stop: allow → prints nothing; payload last_assistant_message preferred', async () => {
    stub.clear();
    stub.setTurnEnd(() => ({ action: 'allow' }));
    const r = await hook(['claude-stop'], { stdin: JSON.stringify({ session_id: 's2', last_assistant_message: 'from payload' }) });
    expect(r.out).toBe('');
    expect(stub.find('/api/hooks/turn-end')[0].body.last_message).toBe('from payload');
  });

  test('claude-stop: running background tasks are reported so the server allows without nudging', async () => {
    stub.clear();
    stub.setTurnEnd((req: any) => (req.background_tasks_running ? { action: 'allow' } : { action: 'block', reason: 'nudge' }));
    const r = await hook(['claude-stop'], {
      stdin: JSON.stringify({
        session_id: 's3', last_assistant_message: 'waiting for sleep',
        background_tasks: [{ status: 'running', command: 'sleep 90' }, { status: 'completed', command: 'ls' }],
      }),
    });
    expect(r.out).toBe('');
    expect(stub.find('/api/hooks/turn-end')[0].body.background_tasks_running).toBe(1);
    stub.clear();
    await hook(['claude-stop'], { stdin: JSON.stringify({ session_id: 's3', background_tasks: [{ status: 'completed' }] }) });
    expect('background_tasks_running' in stub.find('/api/hooks/turn-end')[0].body).toBe(false);
  });

  test('codex-notify: JSON payload as last arg → turn-end with thread-id', async () => {
    stub.clear();
    const payload = { type: 'agent-turn-complete', 'thread-id': 'th-9', 'turn-id': 'tu', cwd: '/x', 'input-messages': ['hi'], 'last-assistant-message': 'codex says hi' };
    const r = await hook(['codex-notify', JSON.stringify(payload)]);
    expect(r).toEqual({ out: '', err: '', code: 0 });
    expect(stub.find('/api/hooks/turn-end')[0].body).toEqual({ harness: 'codex', session_id: 'th-9', last_message: 'codex says hi' });
  });

  test('codex-notify: hidden title-generation turn is ignored', async () => {
    stub.clear();
    const title = {
      type: 'agent-turn-complete', 'thread-id': 'th-title', 'turn-id': 't', cwd: '/x', client: 'codex-tui',
      'input-messages': ['Generate a concise, single-line task title of at most 36 characters and under five words where possible.\n\nUser prompt:\nhi'],
      'last-assistant-message': '{"title":"Say hi"}',
    };
    const r = await hook(['codex-notify', JSON.stringify(title)]);
    expect(r).toEqual({ out: '', err: '', code: 0 });
    await Bun.sleep(100);
    expect(stub.find('/api/hooks/turn-end').length).toBe(0);
    expect(isCodexTitleTurn({ 'input-messages': ['Build a title bar'], 'last-assistant-message': 'done' })).toBe(false);
  });

  test('exit, session, opencode-idle, generic turn-end (prints reply)', async () => {
    stub.clear();
    stub.setTurnEnd(() => ({ action: 'none' }));
    await hook(['exit', '--code', '137']);
    await hook(['session', '--session', 'ses_a']);
    await hook(['opencode-idle', '--session', 'ses_a', '--last-message', 'idle msg']);
    const g = await hook(['turn-end', '--session', 'f1', '--last-message', 'm'], { env: { SPARROW_HARNESS: 'fake' } });
    expect(stub.find('/api/hooks/exit')[0].body).toEqual({ code: 137 });
    expect(stub.find('/api/hooks/session')[0].body).toEqual({ session_id: 'ses_a' });
    const te = stub.find('/api/hooks/turn-end');
    expect(te[0].body).toEqual({ harness: 'opencode', session_id: 'ses_a', last_message: 'idle msg', stop_hook_active: false });
    expect(te[1].body).toEqual({ harness: 'fake', session_id: 'f1', last_message: 'm', stop_hook_active: false });
    expect(JSON.parse(g.out)).toEqual({ action: 'none' });
  });

  test('server down / bad input → exit 0 silently, within the budget', async () => {
    const t0 = Date.now();
    const r = await hook(['claude-stop'], { env: { SPARROW_URL: 'http://127.0.0.1:1' }, stdin: 'not json' });
    const r2 = await hook(['exit', '--code', '1'], { env: { SPARROW_URL: 'http://127.0.0.1:1' } });
    expect(r).toEqual({ out: '', err: '', code: 0 });
    expect(r2).toEqual({ out: '', err: '', code: 0 });
    expect(Date.now() - t0).toBeLessThan(12_000);
  }, 20_000);

  test('hanging server → hook gives up after ~10 s with exit 0', async () => {
    const hang = Bun.serve({ port: nextPort(), hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
    const t0 = Date.now();
    const r = await hook(['claude-stop'], { env: { SPARROW_URL: `http://127.0.0.1:${hang.port}` }, stdin: '{}' });
    const dt = Date.now() - t0;
    hang.stop(true);
    expect(r).toEqual({ out: '', err: '', code: 0 });
    expect(dt).toBeLessThan(11_500);
  }, 20_000);

  test('lastAssistantFromTranscript handles missing files', () => {
    expect(lastAssistantFromTranscript('/nope')).toBeUndefined();
    expect(lastAssistantFromTranscript(undefined)).toBeUndefined();
  });
});
