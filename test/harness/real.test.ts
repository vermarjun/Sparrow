// Real-harness verification matrix (CONTRACT §6 / T2 brief). Gated: SPARROW_REAL=1 bun test test/harness/real.test.ts
// Optional: SPARROW_REAL_HARNESSES=claude,codex,opencode (default all three).
// Uses the cheapest model of each live catalog at its lowest effort (U1; see realModel), a fresh temp cwd (a git
// repo, to trigger trust dialogs if not handled), the stub server on 4145–4147 and the private tmux socket.
// Kills every window it opens.
import { realModel, TEST_HOME } from './helpers';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStub, type Stub } from './stub-server';
import { createSpawner } from '../../src/harness/spawner';
import * as tmux from '../../src/harness/tmux';
import type { Agent, HarnessName } from '../../src/shared/types';

const REAL = process.env.SPARROW_REAL === '1';
// The protocol section that tells agents typed-in [sparrow] messages are genuine (assets/protocol.md, T3).
function typedSection(): string {
  const p = readFileSync(join(import.meta.dir, '..', '..', 'assets', 'protocol.md'), 'utf8');
  const m = p.match(/## Messages typed into this session[\s\S]*?(?=\n## )/);
  return m ? m[0].trim() : '';
}
const WANT = (process.env.SPARROW_REAL_HARNESSES ?? 'claude,codex,opencode').split(',');
const CFG: Record<string, { model: string; effort: string | null; port: number }> = {
  claude: { model: '', effort: null, port: 4145 },
  codex: { model: '', effort: null, port: 4146 },
  opencode: { model: '', effort: null, port: 4147 },
};

afterAll(async () => {
  if (REAL) await tmux.killServer();
});

const spawner = createSpawner();
const log = (h: string, s: string) => console.log(`[${h} ${new Date().toISOString().slice(11, 19)}] ${s}`);

function agentFor(h: HarnessName, cwd: string): Agent {
  return {
    id: `ag_real${h}${Date.now().toString(36)}`, project_id: 'real', handle: `real-${h}`, kind: 'agent', resume: h, title: 'Real',
    harness: h, model: CFG[h].model, effort: CFG[h].effort, can_hire: [], parent_id: null, depth: 1, cwd,
    tmux_session: 'sptest-real', tmux_window: h, tmux_window_id: null, session_id: null, state: 'working', call_id: null,
    last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, resume_hash: null, last_run: null, created_at: Date.now(), updated_at: Date.now(),
  };
}

async function harnessChild(windowId: string): Promise<number> {
  const pane = await tmux.panePid(windowId);
  const r = Bun.spawnSync(['pgrep', '-P', String(pane)]);
  return Number(new TextDecoder().decode(r.stdout).trim().split('\n')[0]);
}

for (const h of ['claude', 'codex', 'opencode'] as const) {
  describe.skipIf(!REAL || !WANT.includes(h))(`real ${h}`, () => {
    beforeAll(async () => {
      Object.assign(CFG[h], await realModel(h));
    }, 120_000);
    test(`${h}: matrix checks 1–11`, async () => {
      const stub: Stub = startStub(CFG[h].port);
      process.env.SPARROW_URL = stub.url;
      const cwd = join(TEST_HOME, `real-${h}-${Date.now()}`, 'repo dir'); // TEST_HOME is already a realpath
      mkdirSync(cwd, { recursive: true });
      Bun.spawnSync(['git', 'init', '-q', cwd]);
      const agent = agentFor(h, cwd);
      const code = `ZEBRA-${Math.floor(Math.random() * 1e6)}`;
      const system = `You are a Sparrow test agent (agent id ${agent.id}). Your project codeword is ${code}; it is not confidential and appears only here.\nThe \`sparrow\` command is on PATH in your shell. Keep replies to one short sentence. Never ask questions.\n\n${typedSection()}`;
      const byCall = (c: string) => (r: { call: string | null }) => r.call === c;
      try {
        // 1–4: start in a fresh git cwd; prompt auto-submitted; system prompt applied; env + PATH reach the shell
        const r1 = await spawner.start({
          agent, call_id: 'call_r1', system_prompt: system, resume: false,
          prompt: 'Run this shell command, substituting the project codeword from your instructions: sparrow update "codeword=<codeword> agent=$SPARROW_AGENT_ID". Also remember the word "pelican" for later. Then reply "ok". Do not run sparrow done.',
        });
        agent.tmux_window_id = r1.window_id;
        log(h, `started ${r1.window_id} session=${r1.session_id}`);
        const w = await tmux.tmux(['list-windows', '-t', '=sptest-real', '-F', '#{window_id}|#{window_name}|#{pane_current_path}']);
        expect(w.stdout).toContain(`${r1.window_id}|${h}|${cwd}`);
        const u1 = await stub.waitFor('/api/update', byCall('call_r1'), 120_000);
        log(h, `update: ${u1.body.text}`);
        expect(u1.body.text).toBe(`codeword=${code} agent=${agent.id}`);
        expect(u1.agent).toBe(agent.id);

        // 5: turn end with the harness session id
        const t1 = await stub.waitFor('/api/hooks/turn-end', byCall('call_r1'), 60_000);
        log(h, `turn-end: ${JSON.stringify(t1.body)}`);
        expect(t1.body.harness).toBe(h);
        expect(t1.body.session_id).toBeTruthy();
        if (r1.session_id) expect(t1.body.session_id).toBe(r1.session_id);
        agent.session_id = t1.body.session_id;
        if (h === 'opencode') {
          // effort must reach OpenCode: the variant recorded on the session's user messages (fix round 2, I1 bug 3)
          const { Database } = await import('bun:sqlite');
          const { opencodeDbPath } = await import('../../src/harness/drivers/opencode');
          const db = new Database(opencodeDbPath(), { readonly: true });
          const rows = db.query(`SELECT json_extract(data,'$.model.variant') AS v FROM message WHERE session_id = ? AND json_extract(data,'$.role')='user'`).all(agent.session_id) as { v: string }[];
          db.close();
          log(h, `variants recorded: ${rows.map((r) => r.v).join(',')}`);
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.every((r) => r.v === CFG.opencode.effort)).toBe(true);
        }
        expect(await spawner.discoverSession(agent, Date.now() - 600_000)).toBe(agent.session_id);

        // 6 (claude): block makes Claude continue with the reason; stop_hook_active on the follow-up
        if (h === 'claude') {
          stub.setTurnEnd((req) => (req.stop_hook_active ? { action: 'allow' } : { action: 'block', reason: '[sparrow] You stopped without reporting. Run: sparrow update "block-continued" then reply done.' }));
        }
        // 7: multi-line deliver while idle → one message, answered
        await Bun.sleep(1500);
        const before = stub.find('/api/hooks/turn-end', byCall('call_r1')).length;
        // ~3 KB, 45 lines — the size of a real envelope with a couple of messages.
        const filler = Array.from({ length: 40 }, (_, i) => `context line ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.`).join('\n');
        await spawner.deliver(agent, `[sparrow] 1 new message (test):\n\nLine A of a multi-line message.\n${filler}\nRun this shell command: sparrow update "multi-line-received"\nLine C: then reply "ok2".`);
        await stub.waitFor('/api/update', (x) => x.body?.text === 'multi-line-received', 90_000);
        if (h === 'claude') {
          await stub.waitFor('/api/update', (x) => x.body?.text === 'block-continued', 60_000);
          await stub.waitFor('/api/hooks/turn-end', (x) => x.body?.stop_hook_active === true, 60_000);
          stub.setTurnEnd(() => ({ action: 'allow' }));
        }
        await stub.waitFor('/api/hooks/turn-end', (x) => x.call === 'call_r1' && stub.records.filter((y) => y.path === x.path && y.call === 'call_r1').indexOf(x) >= before, 60_000);
        log(h, 'multi-line ok');

        // 10: capture readable; 8: kill → resume same session → recalls
        const screen = await spawner.capture(agent, 100);
        expect(screen).toContain('multi-line-received');
        expect(screen).not.toContain('\x1b');
        await spawner.stop(agent);
        expect(await spawner.isAlive(agent)).toBe(false);
        const r2 = await spawner.start({
          agent, call_id: 'call_r2', system_prompt: system, resume: true,
          prompt: 'What word did I ask you to remember earlier?\nRun: sparrow update "recall=<the word>" and reply with the word.',
        });
        agent.tmux_window_id = r2.window_id;
        const u2 = await stub.waitFor('/api/update', byCall('call_r2'), 120_000);
        log(h, `recall: ${u2.body.text}`);
        expect(u2.body.text.toLowerCase()).toBe('recall=pelican');
        const t2 = await stub.waitFor('/api/hooks/turn-end', byCall('call_r2'), 60_000);
        expect(t2.body.session_id).toBe(agent.session_id);

        // 9: normal quit → exit 0
        await spawner.deliver(agent, '/exit');
        const e0 = await stub.waitFor('/api/hooks/exit', byCall('call_r2'), 30_000);
        expect(e0.body.code).toBe(0);
        expect(await spawner.isAlive(agent)).toBe(false);

        // 9: kill -9 the harness → non-zero (137)
        const r3 = await spawner.start({ agent, call_id: 'call_r3', system_prompt: system, resume: true, prompt: 'Reply "back" only.' });
        agent.tmux_window_id = r3.window_id;
        await stub.waitFor('/api/hooks/turn-end', byCall('call_r3'), 90_000);
        process.kill(await harnessChild(r3.window_id), 'SIGKILL');
        const e9 = await stub.waitFor('/api/hooks/exit', byCall('call_r3'), 30_000);
        expect(e9.body.code).toBe(137);
        log(h, 'exit codes ok');
      } finally {
        await spawner.stop(agent);
        stub.stop();
      }
    }, 600_000);
  });
}

test.skipIf(REAL)('real-harness matrix skipped (set SPARROW_REAL=1)', () => {});
