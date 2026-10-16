// Fix round 2 (I1 bug 2): OpenCode resume must always land its envelope. Gated: SPARROW_REAL=1.
// 6 kill → resume cycles in a NARROW (70-col) tmux session; every resume must produce a user message + turn end.
import { TEST_HOME } from './helpers';
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStub } from './stub-server';
import { createSpawner } from '../../src/harness/spawner';
import * as tmux from '../../src/harness/tmux';
import { userMessageCount } from '../../src/harness/drivers/opencode';
import type { Agent } from '../../src/shared/types';

const REAL = process.env.SPARROW_REAL === '1';
afterAll(async () => {
  if (REAL) await tmux.killServer();
});

test.skipIf(!REAL)('opencode: 6 resumes in a narrow window all land', async () => {
  const stub = startStub(4128);
  process.env.SPARROW_URL = stub.url;
  const cwd = join(TEST_HOME, `oc-resume-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  // pre-create a narrow session (spawner adds windows to it)
  await tmux.tmux(['new-session', '-d', '-s', 'sptest-narrow', '-x', '70', '-y', '30', '-c', cwd, 'sleep 3600']);
  const spawner = createSpawner();
  const agent: Agent = {
    id: `ag_ocres${Date.now().toString(36)}`, project_id: 'r', handle: 'ocres', kind: 'agent', resume: 'opencode', title: 'R',
    harness: 'opencode', model: 'opencode-go/deepseek-v4-flash', effort: 'low', can_hire: [], parent_id: null, depth: 1, cwd,
    tmux_session: 'sptest-narrow', tmux_window: 'oc', tmux_window_id: null, session_id: null, state: 'working', call_id: null,
    last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, resume_hash: null, last_run: null, created_at: 0, updated_at: 0,
  };
  try {
    const r = await spawner.start({ agent, call_id: 'call_0', system_prompt: 'You are a test agent. Reply with one word.', prompt: 'Reply "zero".', resume: false });
    agent.tmux_window_id = r.window_id;
    const t0 = await stub.waitFor('/api/hooks/turn-end', (x) => x.call === 'call_0', 120_000);
    agent.session_id = t0.body.session_id;
    for (let i = 1; i <= 6; i++) {
      await spawner.stop(agent);
      const before = userMessageCount(agent.session_id!)!;
      const t = Date.now();
      const rr = await spawner.start({ agent, call_id: `call_${i}`, system_prompt: 'x', resume: true, prompt: `[sparrow] resume ${i}\nReply "r${i}".` });
      agent.tmux_window_id = rr.window_id;
      console.log(`[resume ${i}] start() returned after ${((Date.now() - t) / 1000).toFixed(1)}s`);
      expect(userMessageCount(agent.session_id!)).toBe(before + 1);
      const te = await stub.waitFor('/api/hooks/turn-end', (x) => x.call === `call_${i}`, 90_000);
      expect(te.body.session_id).toBe(agent.session_id);
    }
  } finally {
    await spawner.stop(agent);
    stub.stop();
  }
}, 900_000);
