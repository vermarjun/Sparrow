// Paths and settings the harness layer needs, read lazily from the environment so tests
// (and a server started with a custom SPARROW_HOME) always see the current values.
// Falls back to the frozen constants in src/shared/config.ts.
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { AGENTS_DIR, BIN, REPO_ROOT, SERVER_URL, SPARROW_HOME, TMUX_SOCKET } from '../shared/config';

export const sparrowHome = () => process.env.SPARROW_HOME ?? SPARROW_HOME;
export const isSandboxHome = () => resolve(sparrowHome()) !== resolve(join(homedir(), '.sparrow'));
export const agentsDir = () => (process.env.SPARROW_HOME ? join(process.env.SPARROW_HOME, 'agents') : AGENTS_DIR);
export const agentDir = (agentId: string) => join(agentsDir(), agentId);
export const callsDir = (agentId: string) => join(agentDir(agentId), 'calls');
export const tmuxSocket = (): string | null => process.env.SPARROW_TMUX_SOCKET ?? TMUX_SOCKET;
export const serverUrl = () =>
  process.env.SPARROW_URL ?? (process.env.SPARROW_PORT ? `http://127.0.0.1:${process.env.SPARROW_PORT}` : SERVER_URL);

export const repoRoot = () => REPO_ROOT;
export const binPath = () => BIN;
export const binDir = () => dirname(BIN);
// Absolute bun binary (the one running us). Agents' shells get its dir on PATH so `#!/usr/bin/env bun` works.
// Prefer the stable PATH entry (e.g. /opt/homebrew/bin/bun) over a versioned Cellar path that a
// `brew upgrade` would delete under a long-running server.
let bunCached: string | null = null;
export const bunPath = () => (bunCached ??= Bun.which('bun') ?? process.execPath);
// Hook entry: run src/cli/hook.ts directly (fast; does not depend on the CLI dispatcher).
export const hookEntry = () => join(REPO_ROOT, 'src', 'cli', 'hook.ts');

// Harness binaries (overridable for tests / other machines).
export const CODEX_BIN = () => process.env.SPARROW_CODEX_BIN ?? '/opt/homebrew/bin/codex';
// Absolute path: the tmux server's PATH (inherited by new windows) may not include ~/.local/bin.
export const CLAUDE_BIN = () => process.env.SPARROW_CLAUDE_BIN ?? Bun.which('claude') ?? join(homedir(), '.local', 'bin', 'claude');
export const OPENCODE_BIN = () => process.env.SPARROW_OPENCODE_BIN ?? join(homedir(), '.opencode', 'bin', 'opencode');
export const CODEX_HOME = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
export const CLAUDE_JSON = () => process.env.SPARROW_CLAUDE_JSON ?? join(homedir(), '.claude.json');
