// End-to-end: createSpawner() + fake harness in real tmux windows (private socket) against the stub server.
// Covers matrix checks 1–3, 5, 7–10 for the fake harness.
import { nextPort, makeAgent, tempDir, until } from './helpers';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startStub, type Stub } from './stub-server';
import { createSpawner } from '../../src/harness/spawner';
import { createSpawner as fromIndex } from '../../src/harness/index';
import * as tmux from '../../src/harness/tmux';
import { BIN } from '../../src/shared/config';
import type { Agent } from '../../src/shared/types';

let stub: Stub;
const spawner = createSpawner();

beforeAll(() => {
  stub = startStub(nextPort());
  process.env.SPARROW_URL = stub.url;
});
afterAll(async () => {
  stub.stop();
  await tmux.killServer();
});

async function start(agent: Agent, prompt: string, callId: string, resume = false) {
  const r = await spawner.start({ agent, call_id: callId, system_prompt: `SYSTEM for ${agent.handle}`, prompt, resume });
  agent.tmux_window_id = r.window_id;
  if (r.session_id) agent.session_id = r.session_id;
  return r;
}
const byCall = (call: string) => (r: { call: string | null }) => r.call === call;

describe('fake harness through the spawner', () => {
  test('index re-exports createSpawner', () => {
    expect(fromIndex).toBe(createSpawner);
  });

  test('start: cwd/session/window honoured, prompt auto-run, env + identity reach the CLI, turn end with session id', async () => {
    const cwd = tempDir("fake cwd 'with' spaces");
    const agent = makeAgent({ harness: 'fake', cwd, tmux_session: 'sptest-fk-a', tmux_window: 'james' });
    const r = await start(agent, 'FAKE:update hello from fake\nFAKE:remember pelican\nFAKE:done all good', 'call_a1');
    expect(r.window_id).toMatch(/^@\d+$/);
    expect(r.session_id).toMatch(/^fake-/);
    const upd = await stub.waitFor('/api/update', byCall('call_a1'));
    expect(upd.agent).toBe(agent.id);
    expect(upd.body.text).toBe('hello from fake');
    const done = await stub.waitFor('/api/done', byCall('call_a1'));
    expect(done.body.summary).toBe('all good');
    const te = await stub.waitFor('/api/hooks/turn-end', byCall('call_a1'));
    expect(te.body.session_id).toBe(r.session_id);
    expect(te.body.harness).toBe('fake');

    const w = await tmux.tmux(['list-windows', '-t', '=sptest-fk-a', '-F', '#{window_id}|#{window_name}|#{pane_current_path}']);
    expect(w.stdout.trim()).toBe(`${r.window_id}|james|${cwd}`);
    expect(await spawner.isAlive(agent)).toBe(true); // stays open after done (server closes it)
    const screen = await spawner.capture(agent, 100);
    expect(screen).toContain(`fake harness · session ${r.session_id}`);
    expect(screen).toContain(`sparrow on PATH: ${BIN}`);
    expect(screen).toContain(`agent ${agent.id} · call call_a1 · ${stub.url}`);
    expect(screen).not.toContain('\x1b');

    // deliver a multi-line message while idle → ONE prompt (one turn end), directives inside honoured
    const before = stub.find('/api/hooks/turn-end', byCall('call_a1')).length;
    await spawner.deliver(agent, 'first line of a message\nFAKE:update multi-line ok\nthird line "quoted" $HOME');
    const u2 = await stub.waitFor('/api/update', (x) => x.body?.text === 'multi-line ok');
    expect(u2.call).toBe('call_a1');
    await until(() => stub.find('/api/hooks/turn-end', byCall('call_a1')).length === before + 1);
    await Bun.sleep(800);
    expect(stub.find('/api/hooks/turn-end', byCall('call_a1')).length).toBe(before + 1);
    expect(stub.find('/api/done', byCall('call_a1')).length).toBe(1);

    // stop → window gone, isAlive false, stop idempotent
    await spawner.stop(agent);
    expect(await spawner.isAlive(agent)).toBe(false);
    await spawner.stop(agent);
    expect(await spawner.capture({ ...agent, tmux_window_id: null })).toBe('');

    // resume on the same session → remembers
    const r2 = await start(agent, 'FAKE:recall\nFAKE:done resumed', 'call_a2', true);
    expect(r2.session_id).toBe(r.session_id!);
    const rec = await stub.waitFor('/api/update', byCall('call_a2'));
    expect(rec.body.text).toBe('recall: pelican');
    expect(await spawner.discoverSession(agent, 0)).toBe(r.session_id);
    await spawner.stop(agent);
  }, 40_000);

  test('exit codes reach `sparrow hook exit`: crash N, clean exit 0, kill -9', async () => {
    const a = makeAgent({ harness: 'fake' });
    await start(a, 'FAKE:update about to crash\nFAKE:crash 7', 'call_c1');
    const ex = await stub.waitFor('/api/hooks/exit', byCall('call_c1'));
    expect(ex.body.code).toBe(7);
    expect(ex.agent).toBe(a.id);
    await until(async () => !(await spawner.isAlive(a)));

    const b = makeAgent({ harness: 'fake' });
    await start(b, 'FAKE:exit0', 'call_c2');
    expect((await stub.waitFor('/api/hooks/exit', byCall('call_c2'))).body.code).toBe(0);

    const c = makeAgent({ harness: 'fake' });
    await start(c, 'FAKE:sleep 30', 'call_c3');
    await until(async () => (await spawner.capture(c)).includes('sleeping'));
    // kill -9 the harness process (child of the launch script's bash)
    const pane = await tmux.panePid(c.tmux_window_id!);
    const ps = Bun.spawnSync(['pgrep', '-P', String(pane)]);
    const child = Number(new TextDecoder().decode(ps.stdout).trim().split('\n')[0]);
    expect(child).toBeGreaterThan(0);
    process.kill(child, 'SIGKILL');
    expect((await stub.waitFor('/api/hooks/exit', byCall('call_c3'))).body.code).toBe(137);
  }, 40_000);

  test('turn end without reporting: block reason is acted on; silent agent only signals turn ends', async () => {
    stub.setTurnEnd((req, rec) =>
      rec.call === 'call_n1' && !req.stop_hook_active ? { action: 'block', reason: 'FAKE:done reported after nudge' } : { action: 'allow' },
    );
    const a = makeAgent({ harness: 'fake' });
    await start(a, 'FAKE:idle', 'call_n1');
    const d = await stub.waitFor('/api/done', byCall('call_n1'));
    expect(d.body.summary).toBe('reported after nudge');
    await spawner.stop(a);
    stub.setTurnEnd(() => ({ action: 'none' }));

    const s = makeAgent({ harness: 'fake' });
    await start(s, 'FAKE:silent\nFAKE:idle', 'call_n2');
    await stub.waitFor('/api/hooks/turn-end', byCall('call_n2'));
    await spawner.deliver(s, '[sparrow] You stopped without reporting. run sparrow done');
    await until(() => stub.find('/api/hooks/turn-end', byCall('call_n2')).length === 2);
    expect(stub.find('/api/done', byCall('call_n2')).length).toBe(0);
    expect(stub.find('/api/update', byCall('call_n2')).length).toBe(0);
    await spawner.stop(s);
  }, 30_000);

  test('deliver while busy queues the message; deliveries never interleave', async () => {
    const a = makeAgent({ harness: 'fake' });
    await start(a, 'FAKE:sleep 2\nFAKE:update first', 'call_q1');
    await until(async () => (await spawner.capture(a)).includes('sleeping'));
    await Promise.all([
      spawner.deliver(a, 'FAKE:update second\nmore text'),
      spawner.deliver(a, 'FAKE:update third\neven more'),
    ]);
    await until(() => stub.find('/api/update', byCall('call_q1')).length >= 3, 15_000);
    expect(stub.find('/api/update', byCall('call_q1')).map((r) => r.body.text)).toEqual(['first', 'second', 'third']);
    await spawner.stop(a);
  }, 30_000);

  test('stale window ids (tmux server restart reuses @0) never touch another agent\'s window', async () => {
    const first = makeAgent({ harness: 'fake', tmux_session: 'sptest-fk-stale1' });
    await start(first, 'FAKE:update first', 'call_st1');
    const staleId = first.tmux_window_id!;
    expect(await spawner.isAlive(first)).toBe(true);
    await tmux.killServer(); // all windows gone; ids restart
    const second = makeAgent({ harness: 'fake', tmux_session: 'sptest-fk-stale2' });
    await start(second, 'FAKE:update second', 'call_st2');
    expect(second.tmux_window_id).toBe(staleId); // tmux reused the id
    const info = await tmux.windowInfo(staleId);
    expect(info).toEqual({ id: staleId, agent: second.id, call: 'call_st2', dead: false });
    // first agent still holds the stale id
    expect(await spawner.isAlive(first)).toBe(false);
    expect(await spawner.capture(first)).toBe('');
    await expect(spawner.deliver(first, 'FAKE:update hijack')).rejects.toThrow(/not running/);
    await spawner.stop(first);
    expect(await spawner.isAlive(second)).toBe(true);
    await Bun.sleep(500);
    expect(stub.find('/api/update', (r) => r.body?.text === 'hijack').length).toBe(0);
    // a window not created by Sparrow (no tag) is never touched either
    const foreign = await tmux.newWindow({ session: 'sptest-fk-foreign', name: 'user', cwd: tempDir('foreign'), command: 'sleep 30' });
    const impostor = { ...first, tmux_window_id: foreign };
    expect(await spawner.isAlive(impostor)).toBe(false);
    await spawner.stop(impostor);
    expect(await tmux.windowAlive(foreign)).toBe(true);
    await tmux.killWindow(foreign);
    await spawner.stop(second);
    expect(await spawner.isAlive(second)).toBe(false);
  }, 30_000);

  test('opencode resume whose prompt never lands → start() throws and removes the window', async () => {
    // A stand-in "opencode" TUI that renders an idle footer but swallows input (no user message ever appears).
    const bin = `${tempDir('fakeoc')}/opencode`;
    await Bun.write(
      bin,
      [
        '#!/usr/bin/env bun',
        "process.stdout.write('old transcript\\n\\n┃  Sparrow auto · Model\\n╹▀▀▀\\n  1K (0%)  ctrl+p commands\\n');",
        "process.stdin.on('data', () => {});",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    Bun.spawnSync(['chmod', '+x', bin]);
    process.env.SPARROW_OPENCODE_BIN = bin;
    const a = makeAgent({ harness: 'opencode', session_id: 'ses_doesnotexist', tmux_session: 'sptest-fk-oc' });
    try {
      await expect(spawner.start({ agent: a, call_id: 'call_oc1', system_prompt: 's', prompt: 'hello resume', resume: true })).rejects.toThrow(/not accepted/);
      const w = await tmux.tmux(['list-windows', '-a', '-F', '#{@sparrow_agent}'], { check: false });
      expect(w.stdout).not.toContain(a.id);
    } finally {
      delete process.env.SPARROW_OPENCODE_BIN;
    }
  }, 60_000);

  test('deliver to a dead window throws; start into an existing session adds a window', async () => {
    const a = makeAgent({ harness: 'fake', tmux_session: 'sptest-fk-shared', tmux_window: 'one' });
    const b = makeAgent({ harness: 'fake', tmux_session: 'sptest-fk-shared', tmux_window: 'two' });
    await start(a, 'FAKE:update a', 'call_s1');
    await start(b, 'FAKE:update b', 'call_s2');
    const w = await tmux.tmux(['list-windows', '-t', '=sptest-fk-shared', '-F', '#{window_name}']);
    expect(w.stdout.trim().split('\n').sort()).toEqual(['one', 'two']);
    await spawner.stop(a);
    await expect(spawner.deliver(a, 'hello')).rejects.toThrow(/not running/);
    await expect(spawner.deliver({ ...a, tmux_window_id: null }, 'hello')).rejects.toThrow(/no open window/);
    await spawner.stop(b);
  }, 30_000);

  test('D2 directives: provider_error reports through the provider-error hook, api_error ends the turn on an "API Error" last message; done_failed passes --status', async () => {
    const a = makeAgent({ harness: 'fake', tmux_session: 'sptest-fk-d2', tmux_window: 'pe' });
    const r = await start(a, 'FAKE:provider_error HTTP 500 Internal Server Error', 'call_pe1');
    const pe = await stub.waitFor('/api/hooks/provider-error', byCall('call_pe1'));
    expect(pe.body).toMatchObject({ message: 'HTTP 500 Internal Server Error', session_id: r.session_id });
    const te = await stub.waitFor('/api/hooks/turn-end', byCall('call_pe1'));
    expect(te.body.last_message).toBeUndefined();
    await spawner.stop(a);

    const b = makeAgent({ harness: 'fake', tmux_session: 'sptest-fk-d2', tmux_window: 'ae' });
    await start(b, 'FAKE:api_error 529 overloaded_error', 'call_ae1');
    const te2 = await stub.waitFor('/api/hooks/turn-end', byCall('call_ae1'));
    expect(te2.body.last_message).toBe('API Error: 529 overloaded_error');
    await spawner.stop(b);

    const c = makeAgent({ harness: 'fake', tmux_session: 'sptest-fk-d2', tmux_window: 'df' });
    await start(c, 'FAKE:done_failed it broke', 'call_df1');
    const done = await stub.waitFor('/api/done', byCall('call_df1'));
    expect(done.body).toMatchObject({ summary: 'it broke', status: 'failed' });
    await spawner.stop(c);
  }, 30_000);
});
