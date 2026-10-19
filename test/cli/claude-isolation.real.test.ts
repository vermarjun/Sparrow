// Headed verification only: SPARROW_REAL_CLI=1 bun test test/cli/claude-isolation.real.test.ts
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './helpers';
import { startStub } from '../harness/stub-server';
import type { Agent } from '../../src/shared/types';

describe.skipIf(process.env.SPARROW_REAL_CLI !== '1')('real Claude worker isolation', () => {
  test('haiku/low TUI loads worker skill, runs Bash without user hooks, sends Stop to server', async () => {
    const home = tempDir('u1cli-real-');
    const cwd = join(home, 'project'); mkdirSync(cwd);
    const actual = Bun.which('claude')!;
    const wrapper = join(home, 'claude-debug');
    const { sq } = await import('../../src/harness/launch');
    const debug = join(home, 'debug.log');
    writeFileSync(wrapper, `#!/bin/sh\nexec ${sq(actual)} --debug-file ${sq(debug)} "$@"\n`); chmodSync(wrapper, 0o755);
    const keys = ['SPARROW_HOME', 'SPARROW_URL', 'SPARROW_PORT', 'SPARROW_TMUX_SOCKET', 'SPARROW_TMUX_PREFIX', 'SPARROW_CLAUDE_BIN', 'SPARROW_CLAUDE_JSON'];
    const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    Object.assign(process.env, { SPARROW_HOME: home, SPARROW_URL: 'http://127.0.0.1:4153', SPARROW_PORT: '4153', SPARROW_TMUX_SOCKET: 'u1cli', SPARROW_TMUX_PREFIX: 'u1cli-', SPARROW_CLAUDE_BIN: wrapper, SPARROW_CLAUDE_JSON: join(home, 'trust.json') });
    // The driver preaccepts the actual ~/.claude.json in this real run, as normal. Restore the override afterwards.
    delete process.env.SPARROW_CLAUDE_JSON;
    const stub = startStub(4153);
    const { createSpawner } = await import('../../src/harness/spawner');
    const tmux = await import('../../src/harness/tmux');
    const spawner = createSpawner();
    const agent: Agent = {
      id: 'ag_u1cli_isolation', project_id: 'u1cli', handle: 'isolation', kind: 'agent', resume: 'builder', title: 'Isolation',
      harness: 'claude', model: 'haiku', effort: 'low', can_hire: [], parent_id: null, depth: 1, cwd,
      tmux_session: 'u1cli-isolation', tmux_window: 'haiku', tmux_window_id: null, session_id: null, state: 'working', call_id: 'cli-real',
      last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, resume_hash: null, last_run: null,
      fleet_id: 'ag_u1cli_isolation', captain: null, created_at: Date.now(), updated_at: Date.now(),
    };
    try {
      const user = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8'));
      expect(user.hooks.PreToolUse.length).toBeGreaterThan(0);
      const launched = await spawner.start({ agent, call_id: 'cli-real', resume: false,
        system_prompt: 'This is a controlled Sparrow harness verification. Follow the task exactly; do not run done, ask or wait. The test server records your update and Stop hook. Reply briefly after your one Bash call.',
        prompt: 'Check the available skills in your instructions. Run exactly one Bash command: sparrow update "worker-skill=<the full namespaced name of the sparrow worker skill you can see>". Do not invoke the skill, do not run sparrow done. Then reply "isolation verified" and end your turn.',
      });
      agent.tmux_window_id = launched.window_id;
      const update = await stub.waitFor('/api/update', undefined, 120_000);
      expect(update.body.text).toContain('sparrow:sparrow-worker');
      const stop = await stub.waitFor('/api/hooks/turn-end', undefined, 60_000);
      expect(stop.body.harness).toBe('claude'); expect(stop.body.session_id).toBe(launched.session_id);
      const screen = await spawner.capture(agent, 300);
      writeFileSync(join(home, 'screen.txt'), screen);
      const logs = readFileSync(debug, 'utf8');
      // The machine may also have managed hooks; only the user's hooks must be excluded.
      expect(logs).toContain('tool_dispatch_end tool=Bash');
      const userCommands = user.hooks.PreToolUse.flatMap((m: any) => m.hooks.map((h: any) => h.command));
      for (const cmd of userCommands) expect(logs.includes(cmd)).toBe(false);
      expect(logs.includes('pretooluse-bash')).toBe(false);
      expect(logs.includes('pretooluse-read')).toBe(false);
      const managedRtk = logs.includes('Hooks: PreToolUse:Bash [/usr/local/bin/rtk hook claude]');
      console.log(`Managed rtk hook still present: ${managedRtk} (project,local does not exclude managed policy)`);
      writeFileSync(join(home, 'requests.json'), JSON.stringify(stub.records, null, 2));
      console.log(`REAL EVIDENCE ${home}: update=${update.body.text}; Stop session=${stop.body.session_id}; user PreToolUse hooks=${user.hooks.PreToolUse.length}; user hook commands absent in debug log`);
    } finally {
      if (agent.tmux_window_id) await spawner.stop(agent);
      stub.stop();
      for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
    }
  }, 200_000);
});
