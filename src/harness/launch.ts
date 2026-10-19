// Writes the per-call files and the bash launch script that runs inside the tmux window.
//   AGENTS_DIR/<agentId>/system.md
//   AGENTS_DIR/<agentId>/calls/<callId>.prompt.md
//   AGENTS_DIR/<agentId>/calls/<callId>.sh
import { mkdirSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Agent } from '../shared/types';
import { agentDir, binDir, bunPath, callsDir, hookEntry, serverUrl, sparrowHome } from './env';

// An argv element: a literal string, or the contents of a file (emitted as "$(cat '<file>')").
export type Arg = string | { file: string };

export interface LaunchCommand {
  argv: Arg[];
  env?: Record<string, string>; // extra exports (after the identity vars)
  preamble?: string[];          // extra raw bash lines before the harness runs (already quoted!)
}

export interface CallFiles {
  dir: string;        // agent dir
  system: string;     // system.md
  prompt: string;     // calls/<call>.prompt.md
  script: string;     // calls/<call>.sh
}

// POSIX single-quote a string for bash.
export function sq(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function renderArg(a: Arg): string {
  return typeof a === 'string' ? sq(a) : `"$(cat ${sq(a.file)})"`;
}

export function writeAtomic(path: string, content: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function callFiles(agentId: string, callId: string): CallFiles {
  const dir = agentDir(agentId);
  const calls = callsDir(agentId);
  return {
    dir,
    system: join(dir, 'system.md'),
    prompt: join(calls, `${callId}.prompt.md`),
    script: join(calls, `${callId}.sh`),
  };
}

export function writeCallTexts(agentId: string, callId: string, systemPrompt: string, prompt: string): CallFiles {
  const f = callFiles(agentId, callId);
  mkdirSync(dirname(f.prompt), { recursive: true });
  writeAtomic(f.system, systemPrompt);
  writeAtomic(f.prompt, prompt);
  return f;
}

// Session-identity env vars a spawned harness must NOT inherit from whoever started the server.
export const UNSET_VARS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SSE_PORT', 'TMUX_PANE_SPARROW',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH'];
// Prefix families unset too — except configuration homes, which hold auth.
export const UNSET_PREFIX_RE = '^(CODEX_|OPENCODE_)';
export const KEEP_RE = '^(CODEX_HOME|OPENCODE_CONFIG|OPENCODE_CONFIG_DIR|OPENCODE_CONFIG_CONTENT)$';

export function hookCommand(kind: string, extra = ''): string {
  return `${sq(bunPath())} ${sq(hookEntry())} ${kind}${extra ? ' ' + extra : ''}`;
}

export function buildScript(agent: Agent, callId: string, cmd: LaunchCommand): string {
  const ident: Record<string, string> = {
    SPARROW_AGENT_ID: agent.id,
    SPARROW_WINDOW: agent.id, // marker for the CLI: this shell is an agent window even if SPARROW_AGENT_ID gets unset (D11)
    SPARROW_CALL_ID: callId,
    SPARROW_URL: serverUrl(),
    SPARROW_AGENT_URL: serverUrl(), // where this agent reports, immune to later SPARROW_PORT/HOME changes (D19)
    SPARROW_HARNESS: String(agent.harness),
    SPARROW_HOME: sparrowHome(),
    // A sandbox server's skills isolation (`sparrow sandbox up`) follows its agents, so their own sparrow calls stay inside it.
    ...(process.env.SPARROW_SKILLS_HOME ? { SPARROW_SKILLS_HOME: process.env.SPARROW_SKILLS_HOME } : {}),
  };
  const lines = [
    '#!/usr/bin/env bash',
    `# sparrow launch: agent ${agent.id} (@${agent.handle}) call ${callId} harness ${agent.harness}`,
    `cd ${sq(agent.cwd)} || { echo "sparrow: cannot cd to ${agent.cwd.replace(/["$`\\]/g, '')}"; sleep 5; exit 97; }`,
    `unset ${UNSET_VARS.join(' ')}`,
    `for __v in $(compgen -e); do if [[ $__v =~ ${UNSET_PREFIX_RE} && ! $__v =~ ${KEEP_RE} ]]; then unset "$__v"; fi; done; unset __v`,
    ...Object.entries(ident).map(([k, v]) => `export ${k}=${sq(v)}`),
    `export PATH=${sq(binDir())}:${sq(dirname(bunPath()))}:"$PATH"`,
    ...Object.entries(cmd.env ?? {}).map(([k, v]) => `export ${k}=${sq(v)}`),
    ...(cmd.preamble ?? []),
    cmd.argv.map(renderArg).join(' '),
    '__code=$?',
    `${hookCommand('exit', '--code "$__code"')} >/dev/null 2>&1`,
    'exit $__code',
    '',
  ];
  return lines.join('\n');
}

export function writeScript(path: string, script: string) {
  writeAtomic(path, script, 0o755);
}
