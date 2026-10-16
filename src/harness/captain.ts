// The user's normal Claude session, in <prefix>captains (one window per launch).
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CaptainStartReq, CaptainStartRes } from '../shared/types';
import { ASSETS, TMUX_PREFIX } from '../shared/config';
import { CLAUDE_BIN, binDir, bunPath, serverUrl, sparrowHome, tmuxSocket } from './env';
import { preAcceptTrust } from './drivers/claude';
import { sq, UNSET_VARS, writeAtomic } from './launch';
import { newWindow } from './tmux';

export async function launchCaptain(req: CaptainStartReq): Promise<CaptainStartRes> {
  const cwd = resolve(req.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd must be an existing directory: ${cwd}`);
  const bin = CLAUDE_BIN();
  if (!(bin.includes('/') ? existsSync(bin) : Bun.which(bin))) throw new Error('Claude Code not found; install claude and log in before starting a captain.');
  preAcceptTrust(cwd);
  const session = (process.env.SPARROW_TMUX_PREFIX ?? TMUX_PREFIX) + 'captains';
  const window = `captain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const argv = [bin, '--append-system-prompt-file', join(ASSETS, 'captain.md')];
  if (req.model) argv.push('--model', req.model);
  if (req.effort) argv.push('--effort', req.effort);
  // A private script also overrides stale identity inherited by an existing tmux server.
  const script = join(sparrowHome(), 'captains', `${window}.sh`);
  const env = {
    SPARROW_HOME: sparrowHome(), SPARROW_URL: serverUrl(), SPARROW_PORT: new URL(serverUrl()).port || '80',
    ...(tmuxSocket() ? { SPARROW_TMUX_SOCKET: tmuxSocket()! } : {}),
    SPARROW_TMUX_PREFIX: process.env.SPARROW_TMUX_PREFIX ?? TMUX_PREFIX,
  };
  writeAtomic(script, [
    '#!/usr/bin/env bash', `cd ${sq(cwd)} || exit 1`,
    `unset SPARROW_AGENT_ID SPARROW_CALL_ID SPARROW_HARNESS SPARROW_TMUX_SOCKET ${UNSET_VARS.join(' ')}`,
    'for __v in $(compgen -e); do if [[ $__v =~ ^CODEX_ && $__v != CODEX_HOME ]]; then unset "$__v"; fi; done; unset __v',
    ...Object.entries(env).map(([k, v]) => `export ${k}=${sq(v)}`),
    `export PATH=${sq(binDir())}:${sq(dirname(bunPath()))}:"$PATH"`,
    `exec ${argv.map(sq).join(' ')}`, '',
  ].join('\n'), 0o700);
  const window_id = await newWindow({ session, name: window, cwd, command: `bash ${sq(script)}` });
  const sock = tmuxSocket() ? `-L ${sq(tmuxSocket()!)} ` : '';
  const attach = `tmux ${sock}attach -t ${sq('=' + session)} \\; select-window -t ${sq(window_id)}`;
  return { session, window, window_id, cwd, attach };
}
