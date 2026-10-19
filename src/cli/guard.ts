// Guards for commands an agent must not run against the user's Sparrow server (D11, D12, D15).
// Pure functions over an env so they are unit-testable; main.ts applies them.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

/** Identity/marker vars a started server must not inherit from the agent window that started it. */
export const AGENT_ENV_VARS = ['SPARROW_AGENT_ID', 'SPARROW_CALL_ID', 'SPARROW_WINDOW', 'SPARROW_HARNESS'];

/**
 * The launch script exports SPARROW_WINDOW=<agent id> next to SPARROW_AGENT_ID. Test recipes unset the latter (and
 * SPARROW_URL / SPARROW_CALL_ID) but not this one, so it still tells an agent window from a human captain's shell.
 * SPARROW_HARNESS (exported by older launch scripts, unset by the captain launcher) covers windows opened before the
 * marker existed.
 */
export function agentWindow(env: Env = process.env): string | null {
  return env.SPARROW_WINDOW || (env.SPARROW_HARNESS ? 'unknown (older window, identified by SPARROW_HARNESS)' : null);
}

/** A shell that is an agent window, with or without its SPARROW_AGENT_ID. */
export const inAgentWindow = (env: Env = process.env): boolean => !!env.SPARROW_AGENT_ID || agentWindow(env) !== null;

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** SPARROW_HOME is set and is not the default ~/.sparrow: a throwaway instance, not the user's. */
export function isSandboxHome(env: Env = process.env): boolean {
  return !!env.SPARROW_HOME && real(env.SPARROW_HOME) !== real(join(homedir(), '.sparrow'));
}

/**
 * Why `sparrow up|stop` may not run here, or null when allowed. Humans (no agent identity) are always allowed.
 * An agent is allowed only with --sandbox AND a non-default SPARROW_HOME.
 */
export function lifecycleRefusal(cmd: string, sandbox: boolean, env: Env = process.env, port?: string | number): string | null {
  if (!inAgentWindow(env)) return null;
  const who = env.SPARROW_AGENT_ID ? 'SPARROW_AGENT_ID is set' : 'this shell is inside a Sparrow agent window';
  const base = `agents must not start/stop the user's Sparrow server; report it to your captain (${who}).`;
  const sandboxHint = `For a throwaway sandbox server: SPARROW_HOME=<dir other than ~/.sparrow> SPARROW_PORT=<free port> sparrow ${cmd} --sandbox`;
  if (sandbox && isSandboxHome(env)) {
    // Belt and braces: 4040 is the user's server port; a sandbox must name its own (an unset SPARROW_PORT means 4040).
    if (Number(port ?? env.SPARROW_PORT ?? 4040) === 4040)
      return `${base} --sandbox refuses port 4040 (the user's server port); set SPARROW_PORT to your own free port. ${sandboxHint}`;
    return null;
  }
  if (sandbox) return `${base} --sandbox needs SPARROW_HOME set to a directory other than ~/.sparrow. ${sandboxHint}`;
  return `${base} If the server is unreachable, say so in your final message and stop. ${sandboxHint}`;
}

/** Why a CLI call without SPARROW_AGENT_ID must not become a human captain, or null when it may. */
export function lostIdentityRefusal(env: Env = process.env): string | null {
  if (env.SPARROW_AGENT_ID) return null;
  const w = agentWindow(env);
  if (w === null) return null;
  const id = env.SPARROW_WINDOW ? `agent window ${env.SPARROW_WINDOW}` : 'an agent window';
  return `this shell is inside ${id} but SPARROW_AGENT_ID is unset; unset identity vars only in a subshell: `
    + `(unset SPARROW_AGENT_ID SPARROW_URL SPARROW_CALL_ID; bun test). Refusing to register a captain from here.`;
}
