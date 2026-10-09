// Minimal stand-in for the Sparrow server, for harness tests. Records every request and answers the
// endpoints agents and hooks use. Turn-end replies follow a scriptable policy.
import type { TurnEndReq, TurnEndRes } from '../../src/shared/types';

export interface Rec {
  method: string;
  path: string;
  agent: string | null;
  call: string | null;
  body: any;
  at: number;
}

export type TurnEndPolicy = (req: TurnEndReq, rec: Rec, n: number) => TurnEndRes | Promise<TurnEndRes>;

export interface Stub {
  url: string;
  port: number;
  records: Rec[];
  setTurnEnd(p: TurnEndPolicy): void;
  find(path: string, pred?: (r: Rec) => boolean): Rec[];
  waitFor(path: string, pred?: (r: Rec) => boolean, timeoutMs?: number): Promise<Rec>;
  clear(): void;
  stop(): void;
}

let seq = 0;
const fakeMessage = (kind: string, text: string, from: string | null) => ({
  seq: ++seq,
  id: `msg_stub${seq}`,
  project_id: 'stub',
  thread: 'group',
  from_id: from ?? 'unknown',
  kind,
  text,
  mentions: [],
  card_id: null,
  meta: {},
  created_at: Date.now(),
  from_handle: 'agent',
  thread_label: 'group',
  to_handles: [],
});

export function startStub(port: number, policy?: TurnEndPolicy): Stub {
  const records: Rec[] = [];
  let turnEnd: TurnEndPolicy = policy ?? (() => ({ action: 'allow' }));
  let turnEnds = 0;
  const agentStub = (id: string | null) => ({
    id: id ?? 'ag_stub', project_id: 'stub', handle: 'agent', kind: 'agent', resume: 'fake', title: 'Fake',
    harness: 'fake', model: null, effort: null, can_hire: [], parent_id: null, depth: 1, cwd: '/', tmux_session: 's',
    tmux_window: 'w', tmux_window_id: null, session_id: null, state: 'working', call_id: null, last_end_reason: null,
    last_update: null, last_update_at: null, last_seen_at: null, created_at: 0, updated_at: 0,
  });

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      let body: any = null;
      if (req.method !== 'GET') {
        const t = await req.text();
        try {
          body = t ? JSON.parse(t) : null;
        } catch {
          body = t;
        }
      }
      const rec: Rec = {
        method: req.method,
        path: u.pathname,
        agent: req.headers.get('x-sparrow-agent'),
        call: req.headers.get('x-sparrow-call'),
        body,
        at: Date.now(),
      };
      records.push(rec);
      const j = (x: unknown, status = 200) => Response.json(x, { status });
      switch (u.pathname) {
        case '/api/health':
          return j({ ok: true, version: 'stub', pid: process.pid, started_at: 0 });
        case '/api/whoami':
          return j({ agent: agentStub(rec.agent), project: { id: 'stub', name: 'stub', root: '/', created_at: 0 }, parent: null, inbox: [] });
        case '/api/update':
          return j({ message: fakeMessage('update', body?.text ?? '', rec.agent), inbox: [] });
        case '/api/send':
          return j({ message: fakeMessage('chat', body?.text ?? '', rec.agent), inbox: [] });
        case '/api/done':
          return j({ ended: true, message: fakeMessage('result', body?.summary ?? '', rec.agent), inbox: [] });
        case '/api/ask':
          return j({ ended: true, message: fakeMessage('question', body?.question ?? '', rec.agent), inbox: [] });
        case '/api/wait':
          return j({ ended: true, message: fakeMessage('update', 'waiting: ' + (body?.reason ?? ''), rec.agent), inbox: [] });
        case '/api/inbox':
          return j({ inbox: [] });
        case '/api/hooks/turn-end':
          return j(await turnEnd(body as TurnEndReq, rec, ++turnEnds));
        case '/api/hooks/exit':
        case '/api/hooks/session':
          return j({ ok: true });
        default:
          return j({ error: `stub: no route ${u.pathname}` }, 404);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? port,
    records,
    setTurnEnd(p) {
      turnEnd = p;
      turnEnds = 0;
    },
    find(path, pred = () => true) {
      return records.filter((r) => r.path === path && pred(r));
    },
    async waitFor(path, pred = () => true, timeoutMs = 15_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const r = records.find((x) => x.path === path && pred(x));
        if (r) return r;
        await Bun.sleep(100);
      }
      throw new Error(`stub: timed out waiting for ${path}; saw: ${records.map((r) => r.path + ' ' + JSON.stringify(r.body)?.slice(0, 120)).join('\n  ')}`);
    },
    clear() {
      records.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}

// Run standalone: `bun test/harness/stub-server.ts [port]` — prints records as they arrive.
if (import.meta.main) {
  const port = Number(process.argv[2] ?? 4129);
  const s = startStub(port, (req) => {
    console.log('turn-end', JSON.stringify(req));
    return { action: 'allow' };
  });
  console.log(`stub listening on ${s.url}`);
  setInterval(() => {
    while (s.records.length) {
      const r = s.records.shift()!;
      console.log(new Date(r.at).toISOString(), r.method, r.path, r.agent, r.call, JSON.stringify(r.body));
    }
  }, 300);
}
