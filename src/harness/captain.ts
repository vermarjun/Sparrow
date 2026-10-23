// The user's normal Claude session, in <prefix>captains (one window per launch or resume).
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CaptainStartReq, CaptainStartRes } from '../shared/types';
import { ASSETS, TMUX_PREFIX } from '../shared/config';
import { CLAUDE_BIN, agentPathDirs, serverUrl, sparrowHome, tmuxSocket } from './env';
import { preAcceptTrust } from './drivers/claude';
import { sq, UNSET_VARS, writeAtomic } from './launch';
import { newWindow, tagWindow, windowInfo } from './tmux';

/** What the server passes when it launches a captain it already has a row for (multi-captain). */
export interface CaptainLaunchReq extends CaptainStartReq {
  agent_id?: string;    // the captain row: exported as SPARROW_CAPTAIN_ID so the session keeps its identity through /clear
  session_id?: string;  // a NEW session: `claude --session-id <uuid>`
  resume?: string;      // an existing session: `claude --resume <sid>` (wins over session_id)
  handle?: string;      // names the tmux window
}

/** Exact line that attaches to a window and selects it. */
export function attachLine(session: string, windowId: string): string {
  const sock = tmuxSocket() ? `-L ${sq(tmuxSocket()!)} ` : '';
  return `tmux ${sock}attach -t ${sq('=' + session)} \\; select-window -t ${sq(windowId)}`;
}

/** A Sparrow-launched captain's window is open: it exists, runs, and carries this captain's ownership tag. */
export async function captainWindowOpen(a: { id: string; tmux_window_id: string | null }): Promise<boolean> {
  const info = await windowInfo(a.tmux_window_id);
  return !!info && info.agent === a.id && !info.dead;
}

export async function launchCaptain(req: CaptainLaunchReq): Promise<CaptainStartRes> {
  const cwd = resolve(req.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd must be an existing directory: ${cwd}`);
  const bin = CLAUDE_BIN();
  if (!(bin.includes('/') ? existsSync(bin) : Bun.which(bin))) throw new Error('Claude Code not found; install claude and log in before starting a captain.');
  preAcceptTrust(cwd);
  const session = (process.env.SPARROW_TMUX_PREFIX ?? TMUX_PREFIX) + 'captains';
  const window = req.handle ?? `captain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const argv = [bin];
  if (req.resume) argv.push('--resume', req.resume);
  else if (req.session_id) argv.push('--session-id', req.session_id);
  argv.push('--append-system-prompt-file', join(ASSETS, 'captain.md'));
  if (req.model) argv.push('--model', req.model);
  if (req.effort) argv.push('--effort', req.effort);
  // A private script also overrides stale identity inherited by an existing tmux server.
  const script = join(sparrowHome(), 'captains', `${window}-${Date.now()}.sh`);
  const env = {
    SPARROW_HOME: sparrowHome(), SPARROW_URL: serverUrl(), SPARROW_PORT: new URL(serverUrl()).port || '80',
    ...(tmuxSocket() ? { SPARROW_TMUX_SOCKET: tmuxSocket()! } : {}),
    SPARROW_TMUX_PREFIX: process.env.SPARROW_TMUX_PREFIX ?? TMUX_PREFIX,
    ...(req.agent_id ? { SPARROW_CAPTAIN_ID: req.agent_id } : {}),
  };
  writeAtomic(script, [
    '#!/usr/bin/env bash', `cd ${sq(cwd)} || exit 1`,
    `unset SPARROW_AGENT_ID SPARROW_CALL_ID SPARROW_WINDOW SPARROW_HARNESS SPARROW_TMUX_SOCKET SPARROW_CAPTAIN_ID ${UNSET_VARS.join(' ')}`,
    'for __v in $(compgen -e); do if [[ $__v =~ ^CODEX_ && $__v != CODEX_HOME ]]; then unset "$__v"; fi; done; unset __v',
    ...Object.entries(env).map(([k, v]) => `export ${k}=${sq(v)}`),
    `export PATH=${agentPathDirs().map(sq).join(':')}:"$PATH"`,
    `exec ${argv.map(sq).join(' ')}`, '',
  ].join('\n'), 0o700);
  const window_id = await newWindow({ session, name: window, cwd, command: `bash ${sq(script)}` });
  if (req.agent_id) { try { await tagWindow(window_id, req.agent_id, 'captain'); } catch { /* untagged: reads as not open */ } }
  return { session, window, window_id, cwd, attach: attachLine(session, window_id), ...(req.agent_id ? { agent_id: req.agent_id } : {}) };
}
