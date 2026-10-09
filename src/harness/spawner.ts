// createSpawner(): the harness layer behind the frozen Spawner seam (src/harness/index.ts).
import type { Agent, HarnessName } from '../shared/types';
import type { Spawner, StartResult, StartSpec } from './index';
import { buildScript, sq, writeCallTexts, writeScript } from './launch';
import * as tmux from './tmux';
import type { Driver } from './drivers/types';
import { claudeDriver } from './drivers/claude';
import { codexDriver } from './drivers/codex';
import { opencodeDriver } from './drivers/opencode';
import { fakeDriver } from './drivers/fake';

export const DRIVERS: Record<HarnessName, Driver> = {
  claude: claudeDriver,
  codex: codexDriver,
  opencode: opencodeDriver,
  fake: fakeDriver,
};

export function driverFor(agent: Agent): Driver {
  const d = DRIVERS[agent.harness as HarnessName];
  if (!d) throw new Error(`no harness driver for "${agent.harness}" (agent @${agent.handle})`);
  return d;
}

// Per-window serialisation so two deliveries never interleave their paste/Enter keystrokes.
const deliverLocks = new Map<string, Promise<void>>();

async function owned(agent: Agent): Promise<boolean> {
  const info = await tmux.windowInfo(agent.tmux_window_id);
  return !!info && info.agent === agent.id;
}
async function ownedAlive(agent: Agent): Promise<boolean> {
  const info = await tmux.windowInfo(agent.tmux_window_id);
  return !!info && info.agent === agent.id && !info.dead;
}

export function createSpawner(): Spawner {
  return {
    async start(spec: StartSpec): Promise<StartResult> {
      const a = spec.agent;
      const driver = driverFor(a);
      const files = writeCallTexts(a.id, spec.call_id, spec.system_prompt, spec.prompt);
      const prepared = await driver.prepare(spec, files);
      writeScript(files.script, buildScript(a, spec.call_id, prepared));
      const window_id = await tmux.newWindow({
        session: a.tmux_session,
        name: a.tmux_window || a.handle,
        cwd: a.cwd,
        command: `bash ${sq(files.script)}`,
      });
      await tmux.tagWindow(window_id, a.id, spec.call_id);
      if (driver.afterStart) {
        try {
          await driver.afterStart(window_id, spec, files);
        } catch (e) {
          await tmux.killWindow(window_id); // failed start: don't leave a half-started window behind
          throw e;
        }
      }
      return { window_id, session_id: prepared.session_id };
    },

    async deliver(agent: Agent, text: string): Promise<void> {
      const win = agent.tmux_window_id;
      if (!win) throw new Error(`@${agent.handle} has no open window`);
      const driver = driverFor(agent);
      const prev = deliverLocks.get(win) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(async () => {
        if (!(await ownedAlive(agent))) throw new Error(`@${agent.handle}'s window ${win} is not running`);
        await driver.deliver(win, text);
      });
      deliverLocks.set(win, next);
      try {
        await next;
      } finally {
        if (deliverLocks.get(win) === next) deliverLocks.delete(win);
      }
    },

    async stop(agent: Agent): Promise<void> {
      // Never kill a window that is not this agent's (stale id reused by tmux).
      if (await owned(agent)) await tmux.killWindow(agent.tmux_window_id);
    },

    async isAlive(agent: Agent): Promise<boolean> {
      return ownedAlive(agent);
    },

    async capture(agent: Agent, lines = 200): Promise<string> {
      if (!(await owned(agent))) return '';
      return tmux.capture(agent.tmux_window_id!, lines);
    },

    async discoverSession(agent: Agent, since: number): Promise<string | null> {
      try {
        return await driverFor(agent).discoverSession(agent, since);
      } catch {
        return null;
      }
    },
  };
}
