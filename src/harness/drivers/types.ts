import type { Agent } from '../../shared/types';
import type { StartSpec } from '../index';
import type { CallFiles, LaunchCommand } from '../launch';

export interface PreparedLaunch extends LaunchCommand {
  session_id: string | null; // known at launch (claude, fake) or null (learned via hooks)
}

export interface Driver {
  name: string;
  // Build the harness command (new vs resume), env, and any extra files. May write files under files.dir.
  prepare(spec: StartSpec, files: CallFiles): Promise<PreparedLaunch>;
  // Optional: runs after the window opened, before start() returns (e.g. submit the first prompt by typing
  // it when the harness ignores its prompt flag in some mode).
  afterStart?(windowId: string, spec: StartSpec, files: CallFiles): Promise<void>;
  // Type text into the running TUI and submit it.
  deliver(windowId: string, text: string): Promise<void>;
  // Best-effort session id discovery when hooks never reported one.
  discoverSession(agent: Agent, since: number): Promise<string | null>;
}
