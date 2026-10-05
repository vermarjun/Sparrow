// FROZEN CONTRACT — the seam between the server (T1) and the harness layer (T2).
// T2 implements createSpawner() in ./spawner.ts and re-exports it here.
import type { Agent } from '../shared/types';

export interface StartSpec {
  agent: Agent;          // cwd, tmux_session, tmux_window, harness, model, effort, session_id
  call_id: string;
  system_prompt: string; // full text: protocol + resume body (rendered by the server)
  prompt: string;        // the envelope = first user message of this call
  resume: boolean;       // true ⇒ resume agent.session_id; false ⇒ start a new harness session
}

export interface StartResult {
  window_id: string;         // tmux window id, e.g. '@17'
  session_id: string | null; // known at launch (claude: we pick the uuid) or null (learned later via hooks)
}

export interface Spawner {
  // Open a tmux window running the real interactive harness TUI with the prompt already submitted.
  start(spec: StartSpec): Promise<StartResult>;
  // Type `text` into the running TUI and submit it (used for nudges and for messages to an agent sitting at its prompt).
  deliver(agent: Agent, text: string): Promise<void>;
  // Close the window (idempotent; no error if already gone).
  stop(agent: Agent): Promise<void>;
  // Window exists and its pane process is still running.
  isAlive(agent: Agent): Promise<boolean>;
  // Plain text (ANSI stripped) of the screen plus up to `lines` of scrollback.
  capture(agent: Agent, lines?: number): Promise<string>;
  // Fallback when hooks never reported a session id (e.g. crash in the first turn). null if unknown.
  discoverSession(agent: Agent, since: number): Promise<string | null>;
}

export { createSpawner } from './spawner';
