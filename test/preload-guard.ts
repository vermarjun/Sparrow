// Pure part of the test preload (D7/D20): scrub identity vars, and say why a run must be refused.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

export const IDENTITY_VARS = ['SPARROW_AGENT_ID', 'SPARROW_CALL_ID', 'SPARROW_URL', 'SPARROW_WINDOW', 'SPARROW_AGENT_URL'];

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Why `bun test` must not run with this env, or null. Call after scrubbing. */
export function testEnvProblem(env: Env): string | null {
  const home = env.SPARROW_HOME;
  if (!home) return 'SPARROW_HOME is unset (tests would use the real ~/.sparrow)';
  if (real(home) === real(join(homedir(), '.sparrow'))) return `SPARROW_HOME is the real ${home}`;
  const port = env.SPARROW_PORT;
  if (!port) return 'SPARROW_PORT is unset (tests would reach the live server on :4040)';
  if (Number(port) === 4040) return 'SPARROW_PORT is 4040 (the live server)';
  if (!env.SPARROW_TMUX_SOCKET) return 'SPARROW_TMUX_SOCKET is unset (tests would use the user\'s default tmux server)';
  const prefix = env.SPARROW_TMUX_PREFIX;
  if (!prefix) return 'SPARROW_TMUX_PREFIX is unset (tests could use the user\'s tmux session names)';
  if (prefix === 'sparrow-') return 'SPARROW_TMUX_PREFIX is the default sparrow- (tests could collide with the user\'s tmux sessions)';
  return null;
}

export function scrub(env: Env): string[] {
  const removed: string[] = [];
  for (const k of IDENTITY_VARS) if (env[k] !== undefined) { delete env[k]; removed.push(k); }
  return removed;
}

export const REFUSAL = (why: string) =>
  `bun test refused: ${why}.\nRun tests with an isolated home and port, e.g.:\n`
  + '  SPARROW_HOME=$PWD/.sandbox/t/home SPARROW_PORT=<free port> SPARROW_TMUX_SOCKET=<sock> SPARROW_TMUX_PREFIX=<prefix>- bun test test/\n'
  + '(identity vars SPARROW_AGENT_ID/CALL_ID/URL/WINDOW are removed automatically; see CLAUDE.md)';
