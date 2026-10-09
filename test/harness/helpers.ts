// Test isolation for T2 (CONTRACT §10): temp SPARROW_HOME, ports 4120–4129, private tmux socket.
// Import this FIRST in every harness test file.
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, HarnessName } from '../../src/shared/types';

export const TEST_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'sparrow-t2-')));
process.env.SPARROW_HOME = TEST_HOME;
process.env.SPARROW_TMUX_SOCKET = process.env.SPARROW_TMUX_SOCKET_T2 ?? 'sparrow-test-t2';
process.env.SPARROW_TMUX_PREFIX = 'sptest-';
process.env.SPARROW_PORT ??= '4120';

let portCursor = 4120 + Math.floor(Math.random() * 3);
export function nextPort() {
  // Spread across 4120–4129 (fast tests 4120–4124; real tests 4125–4129).
  const p = portCursor;
  portCursor = portCursor >= 4124 ? 4120 : portCursor + 1;
  return p;
}

export function tempDir(name: string) {
  const d = join(TEST_HOME, name);
  mkdirSync(d, { recursive: true });
  return d;
}

let n = 0;
export function makeAgent(over: Partial<Agent> & { harness: HarnessName }): Agent {
  n++;
  const id = over.id ?? `ag_test${Date.now().toString(36)}${n}`;
  return {
    id,
    project_id: 'proj',
    handle: `t${n}`,
    kind: 'agent',
    resume: over.harness,
    title: 'Test',
    model: null,
    effort: null,
    can_hire: [],
    parent_id: null,
    depth: 1,
    cwd: over.cwd ?? tempDir(`cwd-${n}`),
    tmux_session: `sptest-t2-${n}`,
    tmux_window: `win${n}`,
    tmux_window_id: null,
    session_id: null,
    state: 'working',
    call_id: null,
    last_end_reason: null,
    last_update: null,
    last_update_at: null,
    last_seen_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  } as Agent;
}

export async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000, every = 150): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(every);
  }
  throw new Error(`until: timed out${last ? ': ' + (last as Error).message : ''}`);
}
