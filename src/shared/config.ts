// Paths, ports and tunables. Env vars override for tests.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const REPO_ROOT = resolve(import.meta.dir, '../..');
export const BIN = join(REPO_ROOT, 'bin', 'sparrow');      // the CLI entry (on PATH inside agent windows)
export const ASSETS = join(REPO_ROOT, 'assets');

export const SPARROW_HOME = process.env.SPARROW_HOME ?? join(homedir(), '.sparrow');
export const DB_PATH = join(SPARROW_HOME, 'sparrow.db');
export const RESUMES_DIR = join(SPARROW_HOME, 'resumes');   // user-editable; seeded from assets/resumes
export const AGENTS_DIR = join(SPARROW_HOME, 'agents');     // per-agent files: system.md, calls/<call>.sh|.prompt.md, ...
export const PORT = Number(process.env.SPARROW_PORT ?? 4040);
export const SERVER_URL = process.env.SPARROW_URL ?? `http://127.0.0.1:${PORT}`;
export const TMUX_PREFIX = process.env.SPARROW_TMUX_PREFIX ?? 'sparrow-';   // default tmux session = prefix + project
export const TMUX_SOCKET = process.env.SPARROW_TMUX_SOCKET ?? null;          // null = user's default tmux server; tests use -L

export interface Settings {
  max_running: number;        // concurrent working agents (open windows) across all projects
  max_depth: number;          // human captain is depth 0
  max_nudges: number;         // reminders per call before the call ends as 'unreported'
  max_restarts: number;       // auto-restarts after a crash before state 'crashed'
  close_grace_ms: number;     // delay between done/ask/wait and closing the window
  watchdog_ms: number;        // liveness poll interval
  snapshot_ms: number;        // screen snapshot interval for working agents
  fresh_fallback_ms: number;  // a resumed call that dies within this window restarts with a FRESH session
  quiet_minutes: number;      // default when the resume has no limits.quiet_minutes
  max_call_minutes: number;   // default when the resume has no limits.max_call_minutes
  doctor_timeout_ms: number;  // per-harness cap for the doctor's live round trip
  provider_error_threshold: number;       // consecutive provider errors that mark a harness+provider degraded
  provider_error_window_minutes: number;  // ...within this many minutes
  doctor_models: Partial<Record<'claude' | 'codex' | 'opencode', string>>; // override the auto-picked cheapest model per harness
}

export const DEFAULT_SETTINGS: Settings = {
  max_running: 3,
  max_depth: 3,                // you (0) → sub-captain (1) → builder (2) → helper (3)
  max_nudges: 2,
  max_restarts: 1,
  close_grace_ms: 8000,
  watchdog_ms: 5000,
  snapshot_ms: 10000,
  fresh_fallback_ms: 20000,
  quiet_minutes: 15,
  max_call_minutes: 90,
  doctor_timeout_ms: 90000,
  provider_error_threshold: 3,
  provider_error_window_minutes: 15,
  doctor_models: {},
};

export const PID_FILE = join(SPARROW_HOME, 'server.pid');     // written by the server on listen: {"pid":N,"port":N,"started_at":N}
export const LOG_FILE = join(SPARROW_HOME, 'server.log');     // detached server stdout+stderr
export const CLAUDE_PLUGIN_DIR = join(SPARROW_HOME, 'claude-plugin'); // Sparrow skills as a Claude plugin (--plugin-dir) for isolated agents

export const CONFIG_FILE = join(SPARROW_HOME, 'config.json'); // written by the web Settings page (PUT /api/settings)

// ~/.sparrow/config.json overrides defaults; SPARROW_SETTINGS (JSON) overrides both (tests).
export function loadSettings(): Settings {
  let s: Settings = { ...DEFAULT_SETTINGS };
  const file = CONFIG_FILE;
  if (existsSync(file)) s = { ...s, ...JSON.parse(readFileSync(file, 'utf8')) };
  if (process.env.SPARROW_SETTINGS) s = { ...s, ...JSON.parse(process.env.SPARROW_SETTINGS) };
  return s;
}
