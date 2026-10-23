// Test helpers for the CLI: a stub Sparrow server with canned responses, and a runner for bin/sparrow.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Agent, MessageView, Project } from '../../src/shared/types';

export const REPO = resolve(import.meta.dir, '../..');
export const BIN = join(REPO, 'bin', 'sparrow');

export interface Recorded {
  method: string;
  path: string;            // pathname + search
  agent: string | null;    // x-sparrow-agent header
  body: any;
}

type Reply = unknown | ((req: Recorded) => unknown);
export interface Canned { status?: number; body: Reply }

export class StubServer {
  requests: Recorded[] = [];
  routes = new Map<string, Canned>();    // key: "METHOD /pathname"
  server: ReturnType<typeof Bun.serve>;

  constructor(public port: number) {
    this.server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        const text = await req.text();
        const rec: Recorded = {
          method: req.method,
          path: url.pathname + url.search,
          agent: req.headers.get('x-sparrow-agent'),
          body: text ? JSON.parse(text) : undefined,
        };
        this.requests.push(rec);
        const c = this.routes.get(`${req.method} ${url.pathname}`);
        if (!c) return Response.json({ error: `stub: no route ${req.method} ${url.pathname}` }, { status: 404 });
        const body = typeof c.body === 'function' ? (c.body as (r: Recorded) => unknown)(rec) : c.body;
        if (body instanceof Response) return body; // raw replies (e.g. a broken JSON body)
        return Response.json(body, { status: c.status ?? 200 });
      },
    });
  }

  get url() { return `http://127.0.0.1:${this.port}`; }
  on(method: string, path: string, body: Reply, status = 200) { this.routes.set(`${method} ${path}`, { body, status }); return this; }
  reset() { this.requests = []; this.routes.clear(); }
  find(method: string, pathname: string) { return this.requests.filter((r) => r.method === method && r.path.split('?')[0] === pathname); }
  stop() { this.server.stop(true); }
}

export function tempDir(prefix = 'sparrow-t3-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Clean env: no inherited harness/sparrow identity (the test itself may run inside Claude Code). */
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('SPARROW_') || k.startsWith('CODEX_') || k.startsWith('OPENCODE') || k.startsWith('CLAUDE')) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export interface RunResult { code: number; stdout: string; stderr: string }

export async function run(args: string[], opts: { env?: Record<string, string | undefined>; stdin?: string; cwd?: string; url?: string } = {}): Promise<RunResult> {
  const p = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: opts.cwd ?? REPO,
    env: cleanEnv({ TZ: 'UTC', SPARROW_URL: opts.url, SPARROW_HOME: opts.env?.SPARROW_HOME ?? join(tempDir(), 'home'), ...opts.env }),
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

// ---------- fixtures

const T0 = Date.UTC(2026, 9, 13, 14, 2, 0); // children run with TZ=UTC

export const project: Project = { id: 'tortuga', name: 'tortuga', root: '/x/tortuga', created_at: T0 };

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_JAMES', project_id: 'tortuga', handle: 'james', kind: 'agent', resume: 'builder', title: 'Builder',
    harness: 'claude', model: 'opus', effort: 'high', can_hire: [], parent_id: 'ag_CAPTAIN', depth: 1,
    cwd: '/x/tortuga', tmux_session: 'sparrow-tortuga', tmux_window: 'james', tmux_window_id: '@3',
    session_id: null, state: 'working', call_id: 'call_1', last_end_reason: null, last_update: null,
    last_update_at: null, last_seen_at: null, resume_hash: null, last_run: null, fleet_id: 'ag_CAPTAIN', captain: null, created_at: T0, updated_at: T0, ...over,
  };
}

export const captain = agent({
  id: 'ag_CAPTAIN', handle: 'captain', kind: 'human', resume: 'captain', title: 'Captain', harness: 'human',
  model: null, effort: null, can_hire: ['*'], parent_id: null, depth: 0, tmux_window: 'captain', tmux_window_id: null,
  state: 'idle', call_id: null, fleet_id: 'ag_CAPTAIN',
  captain: { title: null, branch: 'main', harness: 'claude', origin: 'terminal', archived_at: null },
});

export function msg(over: Partial<MessageView> = {}): MessageView {
  return {
    seq: 1, id: 'msg_1', project_id: 'tortuga', thread: 'dm:ag_CAPTAIN:ag_JAMES', from_id: 'ag_CAPTAIN', kind: 'task',
    text: 'Build the login page', mentions: ['ag_JAMES'], card_id: null, meta: {}, created_at: T0,
    from_handle: 'captain', thread_label: 'dm @captain ↔ @james', to_handles: ['james'], ...over,
  };
}

/** A TCP port that is free right now (OS-assigned), so tests never collide with other instances. Never 4040. */
export async function freePort(): Promise<number> {
  for (;;) {
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = srv.port as number;
    srv.stop(true);
    if (port !== 4040) return port;
  }
}
