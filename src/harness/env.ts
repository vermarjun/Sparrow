// Paths and settings the harness layer needs, read lazily from the environment so tests
// (and a server started with a custom SPARROW_HOME) always see the current values.
// Falls back to the frozen constants in src/shared/config.ts.
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveHarnessBin } from './discover';
import { AGENTS_DIR, APP_DIR, BIN, COMPILED, REPO_ROOT, SERVER_URL, SPARROW_HOME, TMUX_SOCKET } from '../shared/config';

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
// Dir that holds a `sparrow` for agents' PATH. Compiled: the binary's own dir, or a shim dir (src/shared/app.ts) when
// the binary is not named `sparrow` (e.g. dist/bin/sparrow-darwin-arm64).
export const binDirFor = (bin: string, appDir: string, compiled: boolean) => (compiled && basename(bin) !== 'sparrow' ? join(appDir, 'bin') : dirname(bin));
export const binDir = () => binDirFor(BIN, APP_DIR, COMPILED);
// Absolute bun binary (the one running us). Agents' shells get its dir on PATH so `#!/usr/bin/env bun` works.
// Prefer the stable PATH entry (e.g. /opt/homebrew/bin/bun) over a versioned Cellar path that a
// `brew upgrade` would delete under a long-running server.
let bunCached: string | null = null;
export const bunPath = () => (bunCached ??= Bun.which('bun') ?? process.execPath);
// Hook entry: run src/cli/hook.ts directly (fast; does not depend on the CLI dispatcher).
export const hookEntry = () => join(REPO_ROOT, 'src', 'cli', 'hook.ts');
// What runs a hook: compiled = `<binary> hook`; source = `bun src/cli/hook.ts`. Append the kind and its args.
export const hookArgvFor = (compiled: boolean, bin: string, bun: string, entry: string): string[] => (compiled ? [bin, 'hook'] : [bun, entry]);
export const hookArgv = () => hookArgvFor(COMPILED, BIN, bunPath(), hookEntry());
// Dirs an agent's PATH starts with. Compiled: no bun needed at runtime.
export const agentPathDirsFor = (compiled: boolean, binD: string, bunDir: string, harness: string[] = []): string[] =>
  [...new Set([binD, ...(compiled ? [] : [bunDir]), ...harness])];
export const agentPathDirs = () => agentPathDirsFor(COMPILED, binDir(), dirname(bunPath()), harnessDirs());

// Harness binaries (overridable for tests / other machines).
// resolveHarnessBin (src/harness/discover.ts): override env -> widened PATH -> known install dirs. Always absolute: the tmux
// server's PATH (inherited by new windows) may not include ~/.local/bin. Not found: the old default, so error text names a path.
export const CODEX_BIN = () => resolveHarnessBin('codex') ?? process.env.SPARROW_CODEX_BIN ?? '/opt/homebrew/bin/codex';
export const CLAUDE_BIN = () => resolveHarnessBin('claude') ?? process.env.SPARROW_CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude');
export const OPENCODE_BIN = () => resolveHarnessBin('opencode') ?? process.env.SPARROW_OPENCODE_BIN ?? join(homedir(), '.opencode', 'bin', 'opencode');
/** Dirs of the harness binaries found on this machine (they join the agents' PATH, so a minimal tmux PATH still works). */
export const harnessDirs = (): string[] => [...new Set((['claude', 'codex', 'opencode'] as const).map((h) => resolveHarnessBin(h)).filter((p): p is string => !!p).map((p) => dirname(p)))];
export const CODEX_HOME = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
export const CLAUDE_JSON = () => process.env.SPARROW_CLAUDE_JSON ?? join(homedir(), '.claude.json');
