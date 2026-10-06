// Hono routes (CONTRACT §4). Identity: x-sparrow-agent; hooks add x-sparrow-call.
// Every response to an identified caller carries `inbox` (piggyback) — except hooks.
import { Hono, type Context } from 'hono';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve as resolvePath } from 'node:path';
import type { Agent } from '../shared/types';
import { Core, HttpError } from './core';
import { sseHandler } from './events';

type Vars = { caller: Agent | null; callHeader: string | null };

export interface ApiOpts {
  version?: string;
  startedAt?: number;
  webDist?: string | null;
  pingMs?: number;
}

async function body<T = any>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
  // null, arrays and scalars are treated as an empty object (then field validation answers 400).
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
}

export function createApi(core: Core, opts: ApiOpts = {}) {
  const app = new Hono<{ Variables: Vars }>();
  const startedAt = opts.startedAt ?? Date.now();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
    console.error('[sparrow] internal error:', err);
    return c.json({ error: `Internal server error: ${(err as Error)?.message ?? err}` }, 500);
  });

  // Identity
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') { c.set('caller', null); c.set('callHeader', null); return next(); }
    const id = c.req.header('x-sparrow-agent') || null;
    c.set('callHeader', c.req.header('x-sparrow-call') || null);
    if (id) {
      const a = core.identify(id);
      c.set('caller', core.touch(a));
    } else c.set('caller', null);
    await next();
  });

  const need = (c: Context<{ Variables: Vars }>): Agent => {
    const a = c.get('caller');
    if (!a) throw new HttpError(401, 'This endpoint needs an identified caller (x-sparrow-agent header). Use the sparrow CLI.');
    // Re-read: the row may have changed since the middleware ran.
    return core.store.getAgent(a.id)!;
  };

  /** JSON reply + piggyback inbox for identified callers. */
  const reply = (c: Context<{ Variables: Vars }>, data: any, status = 200) => {
    const caller = c.get('caller');
    // Array responses (lists) stay arrays per the types; their caller's deliveries stay pending for the next object response.
    if (caller && data && typeof data === 'object' && !Array.isArray(data)) {
      data = { ...data, inbox: core.takeInbox(caller.id, c.get('callHeader')) };
    }
    return c.json(data, status as any);
  };

  // ---------------------------------------------------------------- meta
  app.get('/api/health', (c) => c.json({ ok: true, version: opts.version ?? '0.0.0', pid: process.pid, started_at: startedAt }));

  app.post('/api/captains/register', async (c) => {
    const res = core.registerCaptain(await body(c));
    c.set('caller', res.agent);
    return reply(c, res);
  });

  app.get('/api/whoami', (c) => reply(c, core.whoami(need(c))));
  app.get('/api/resumes', (c) => c.json(core.resumes.list()));
  app.get('/api/projects', (c) => c.json(core.listProjects()));

  // ---------------------------------------------------------------- agents
  app.get('/api/agents', (c) => {
    const project = c.req.query('project') || null;
    return c.json(core.store.listAgents(project));
  });

  const agentRef = (c: Context<{ Variables: Vars }>) => {
    const ref = decodeURIComponent(c.req.param('id') ?? '');
    const project = c.req.query('project') || c.get('caller')?.project_id || null;
    const a = core.resolveAgent(project, ref);
    if (!a) throw new HttpError(404, `No agent ${ref}.`);
    return a;
  };

  app.get('/api/agents/:id', (c) => reply(c, core.agentDetail(agentRef(c).id)));
  app.get('/api/agents/:id/screen', async (c) => {
    const lines = Math.min(Math.max(Number(c.req.query('lines')) || 200, 1), 5000);
    return reply(c, await core.screen(agentRef(c).id, lines));
  });

  // ---------------------------------------------------------------- hire / messages
  app.post('/api/hire', async (c) => reply(c, await core.hire(need(c), await body(c))));
  app.post('/api/send', async (c) => reply(c, { message: await core.send(need(c), await body(c)) }));
  app.post('/api/update', async (c) => reply(c, { message: core.update(need(c), await body(c)) }));
  app.post('/api/ask', async (c) => reply(c, await core.ask(need(c), await body(c), c.get('callHeader'))));
  app.post('/api/done', async (c) => reply(c, await core.done(need(c), await body(c), c.get('callHeader'))));
  app.post('/api/wait', async (c) => reply(c, await core.wait(need(c), await body(c), c.get('callHeader'))));

  app.get('/api/inbox', async (c) => {
    const caller = need(c);
    const wait = Math.min(Math.max(Number(c.req.query('wait')) || 0, 0), 600);
    if (wait > 0) await core.waitForPending(caller.id, wait, c.req.raw.signal);
    return reply(c, {});
  });

  app.get('/api/messages', (c) => {
    const after = c.req.query('after');
    return c.json(core.messages({
      project: c.req.query('project') || null,
      thread: c.req.query('thread') || null,
      after: after != null && after !== '' ? Number(after) : null,
      limit: Number(c.req.query('limit')) || 100,
      caller: c.get('caller'),
    }));
  });

  app.get('/api/threads', (c) => c.json(core.threads(c.req.query('project') || c.get('caller')?.project_id || '')));

  // ---------------------------------------------------------------- cards
  app.post('/api/propose', async (c) => reply(c, { card: core.propose(need(c), await body(c)) }));
  app.get('/api/cards', (c) => c.json(core.store.listCards(c.req.query('project') || c.get('caller')?.project_id || null)));
  app.post('/api/cards', async (c) => {
    const caller = c.get('caller') ? need(c) : null;
    return reply(c, { card: core.createCard(caller, await body(c)) });
  });
  app.patch('/api/cards/:id', async (c) => {
    const caller = c.get('caller') ? need(c) : null;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) throw new HttpError(400, 'card id must be a number');
    return reply(c, { card: core.patchCard(caller, id, await body(c)) });
  });

  app.post('/api/release', async (c) => {
    const b = await body<{ agent: string }>(c);
    return reply(c, { agent: await core.release(need(c), b.agent) });
  });

  // ---------------------------------------------------------------- hooks (no piggyback: never steal deliveries from a dying window)
  app.post('/api/hooks/turn-end', async (c) => c.json(await core.turnEnd(need(c), c.get('callHeader'), await body(c))));
  app.post('/api/hooks/exit', async (c) => {
    const b = await body<{ code: unknown }>(c);
    const code = typeof b.code === 'number' ? b.code : typeof b.code === 'string' && /^-?\d+$/.test(b.code.trim()) ? Number(b.code) : NaN;
    if (!Number.isInteger(code)) throw new HttpError(400, 'exit needs {code: integer}');
    return c.json(await core.exitHook(need(c), c.get('callHeader'), code));
  });
  app.post('/api/hooks/session', async (c) => {
    const b = await body<{ session_id: string }>(c);
    return c.json(core.session(need(c), c.get('callHeader'), b.session_id));
  });

  // ---------------------------------------------------------------- SSE
  app.get('/api/events', sseHandler(core.events, opts.pingMs));

  app.all('/api/*', (c) => c.json({ error: `No such endpoint: ${c.req.method} ${c.req.path}` }, 404));

  // ---------------------------------------------------------------- static web/dist with SPA fallback
  const dist = opts.webDist ? resolvePath(opts.webDist) : null;
  app.get('*', (c) => {
    if (!dist || !existsSync(join(dist, 'index.html'))) {
      return c.text('Sparrow server is running. The web UI is not built yet (cd web && bun run build).', 200);
    }
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = join(dist, rel);
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    return new Response(Bun.file(join(dist, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });

  return app;
}
