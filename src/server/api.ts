// Hono routes (CONTRACT §4). Identity: x-sparrow-agent; hooks add x-sparrow-call.
// Every response to an identified caller carries `inbox` (piggyback) — except hooks.
import { Hono, type Context } from 'hono';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve as resolvePath } from 'node:path';
import { launchCaptain as defaultLaunchCaptain } from '../harness/captain';
import type { Agent, CaptainStartReq, ResumeWriteReq } from '../shared/types';
import type { CatalogService } from './catalog';
import { Core, DOCTOR_PROJECT, HttpError } from './core';
import type { Doctor } from './doctor';
import { sseHandler } from './events';
import { SLUG_RE, validateResumeReq } from './resumes';
import { mountSkillsApi } from './skills-api';
import { mountSkillAddRoutes } from './skills-add-routes';

type Vars = { caller: Agent | null; callHeader: string | null };

export interface ApiOpts {
  version?: string;
  startedAt?: number;
  webDist?: string | null;
  port?: number;               // this server's own port for the Origin check (default: the Host header's)
  pingMs?: number;
  catalogs?: CatalogService;
  doctor?: Doctor;
  launchCaptain?: typeof defaultLaunchCaptain;
}

async function body<T = any>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
  // null, arrays and scalars are treated as an empty object (then field validation answers 400).
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Write routes whose body is multipart/form-data (the skills upload); every other write body must be JSON. */
const MULTIPART_ROUTES = new Set(['/api/skills/upload']);

/**
 * CSRF / DNS-rebinding guard for every state-changing /api request (dogfood D13).
 * Browsers always send Origin (and Sec-Fetch-Site) on cross-site writes; the CLI and hooks send neither, so they pass.
 * - Sec-Fetch-Site must be same-origin (or none): cross-site and same-site (another localhost app) are refused.
 * - Origin, when present, must be http://127.0.0.1|localhost:<this server's port> (`null` is refused).
 * - A request that sends a body must declare application/json: a text/plain or form POST needs no CORS
 *   preflight, so the content type is the second line of defence. The one exception is the skills upload
 *   (MULTIPART_ROUTES), which takes multipart/form-data; the Sec-Fetch-Site/Origin checks above still apply to it.
 */
export function guardWrites(ownPort?: number) {
  return async (c: Context, next: () => Promise<void>) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      throw new HttpError(403, `Refused: ${c.req.method} ${c.req.path} came from a ${site} page (Sec-Fetch-Site: ${site}). The Sparrow API only accepts writes from its own UI or the CLI.`);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      const port = ownPort ?? Number(new URL(c.req.url).port || 80);
      let ok = false;
      try {
        const u = new URL(origin);
        ok = u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && Number(u.port || 80) === port;
      } catch { /* "null" and junk are refused */ }
      if (!ok) throw new HttpError(403, `Refused: ${c.req.method} ${c.req.path} has Origin "${origin}", which is not this server (http://127.0.0.1:${port}).`);
    }
    const hasBody = c.req.raw.body !== null || (c.req.header('transfer-encoding') ?? '') !== '' || Number(c.req.header('content-length') ?? 0) > 0;
    const type = c.req.header('content-type') ?? '';
    const multipartOk = MULTIPART_ROUTES.has(c.req.path) && /^multipart\/form-data\s*(?:;|$)/i.test(type);
    if (hasBody && !multipartOk && !/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type)) {
      throw new HttpError(415, `Unsupported content type "${c.req.header('content-type') ?? ''}": this endpoint takes application/json.`);
    }
    return next();
  };
}

export function createApi(core: Core, opts: ApiOpts = {}) {
  const app = new Hono<{ Variables: Vars }>();
  const startedAt = opts.startedAt ?? Date.now();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
    console.error('[sparrow] internal error:', err);
    return c.json({ error: `Internal server error: ${(err as Error)?.message ?? err}` }, 500);
  });

  app.use('/api/*', guardWrites(opts.port));

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

  // Skills writes are browser reachable and unauthenticated. Cross-site / foreign-Origin refusal is guardWrites'
  // job (D13, every /api write, run above). This adds the skills-only content-type rules guardWrites does not have:
  // strict application/json (no +json), a Content-Type header counts as a body, and the upload must be multipart.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const method = c.req.method.toUpperCase();
    if (!path.startsWith('/api/skills') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
    // Every skills write that sends a body is JSON, except the multipart upload. Rule-based, so new routes are covered:
    // a cross-site "simple" request (text/plain, form) always carries a non-JSON Content-Type.
    const type = c.req.header('content-type');
    const hasBody = !!type || Number(c.req.header('content-length') ?? '0') > 0 || !!c.req.header('transfer-encoding');
    if (path !== '/api/skills/upload' && hasBody && !/^application\/json(?:\s*;|$)/i.test(type ?? '')) {
      return c.json({ error: 'Content-Type must be application/json.' }, 415);
    }
    if (path === '/api/skills/upload' && !/^multipart\/form-data(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: 'Content-Type must be multipart/form-data.' }, 415);
    }
    return next();
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
    // Recovery inbox reads must not consume pending messages as a side effect of captain registration.
    if (c.req.query('no_inbox') === '1') return c.json({ ...res, inbox: [] });
    return reply(c, res);
  });

  app.get('/api/whoami', (c) => reply(c, core.whoami(need(c))));
  app.get('/api/projects', (c) => c.json(core.listProjects()));

  // ---------------------------------------------------------------- U1: catalog, doctor, resumes, captain
  const catalogs = opts.catalogs ?? null;
  const doctor = opts.doctor ?? null;
  const needSvc = <T>(x: T | null, what: string): T => {
    if (!x) throw new HttpError(503, `${what} is not available in this server.`);
    return x;
  };

  app.get('/api/catalog', (c) => c.json(catalogs?.list() ?? []));
  app.post('/api/catalog/refresh', async (c) => {
    const svc = needSvc(catalogs, 'The model catalog');
    // Wait for the fetch, but answer within ~30 s with whatever is cached.
    const done = svc.refresh();
    const res = await Promise.race([done, Bun.sleep(30_000).then(() => svc.list())]);
    return c.json(res);
  });

  app.get('/api/doctor', (c) => {
    const d = needSvc(doctor, 'The doctor');
    return c.json({ run: d.latest(), health: d.healthAll(), providers: core.providers.list() });
  });
  app.post('/api/doctor/run', (c) => c.json({ run: needSvc(doctor, 'The doctor').start() }));

  const resumeOr404 = (slug: string) => {
    const r = core.resumes.get(slug);
    if (!r) throw new HttpError(404, `No resume "${slug}". Available: ${core.resumes.list().map((x) => x.slug).join(', ') || '(none)'}`);
    return r;
  };
  /** Shape validation (400 with the field) + catalog validation (400: model/effort the harness does not offer). */
  const checkWrite = (b: unknown, create: boolean): ResumeWriteReq => {
    const v = validateResumeReq(b, { create });
    if ('error' in v) throw new HttpError(400, v.error);
    const r = v.value;
    const cat = catalogs?.get(r.harness) ?? null;
    const p = r.harness === 'fake' ? null : (() => {
      const refusal = core.gate(r.harness, r.model, r.effort);
      // Install/login problems don't block editing (the UI greys those harnesses); a dead model or effort does.
      return refusal && cat?.ok && /no longer offered|effort/.test(refusal) ? refusal : null;
    })();
    if (p) throw new HttpError(400, `${/effort/.test(p) && !/no longer offered/.test(p) ? 'effort' : 'model'}: ${p}`);
    return r;
  };

  app.get('/api/resumes', (c) => c.json(core.resumeViews()));
  app.get('/api/resumes/:slug', (c) => c.json(core.resumeView(resumeOr404(c.req.param('slug')))));
  app.post('/api/resumes', async (c) => {
    const r = checkWrite(await body(c), true);
    const slug = r.slug!;
    if (core.resumes.get(slug)) throw new HttpError(409, `Resume "${slug}" already exists; pick another slug or edit it.`);
    const { slug: _s, ...rest } = r;
    core.resumes.write(slug, rest);
    core.emitResume(slug);
    return c.json(core.resumeView(core.resumes.get(slug)!), 201);
  });
  app.put('/api/resumes/:slug', async (c) => {
    const slug = c.req.param('slug');
    const cur = resumeOr404(slug);
    const { slug: _s, ...rest } = checkWrite(await body(c), false);
    // A client that does not know about skills (older UI) must not wipe them: absent = unchanged, [] = clear.
    if (rest.skills === undefined) rest.skills = cur.skills ?? [];
    const before = JSON.stringify(cur.skills ?? []);
    core.resumes.write(slug, rest);
    core.emitResume(slug);
    if (JSON.stringify(rest.skills) !== before) core.events.emit({ type: 'skills.updated', project_id: '*' }); // open matrices refetch
    return c.json(core.resumeView(core.resumes.get(slug)!));
  });
  app.delete('/api/resumes/:slug', (c) => {
    const slug = c.req.param('slug');
    resumeOr404(slug);
    core.resumes.delete(slug);
    core.emitResume(slug);
    return c.json({ ok: true });
  });
  app.post('/api/resumes/:slug/duplicate', async (c) => {
    const src = resumeOr404(c.req.param('slug'));
    const b = await body<{ slug?: unknown }>(c);
    if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) throw new HttpError(400, `slug must match ${SLUG_RE}`);
    if (core.resumes.get(b.slug)) throw new HttpError(409, `Resume "${b.slug}" already exists; pick another slug.`);
    core.resumes.write(b.slug, {
      title: src.title, description: src.description, harness: src.harness, model: src.model, effort: src.effort,
      can_hire: src.can_hire, limits: src.limits, body: src.body, skills: src.skills ?? [],
    });
    core.emitResume(b.slug);
    return c.json(core.resumeView(core.resumes.get(b.slug)!), 201);
  });
  app.post('/api/resumes/:slug/apply', (c) => c.json({ updated: core.applyResume(c.req.param('slug')) }));
  app.post('/api/resumes/:slug/test', (c) => c.json({ check: needSvc(doctor, 'The doctor').startTest(c.req.param('slug')) }));
  app.get('/api/resumes/:slug/test', (c) => {
    const check = needSvc(doctor, 'The doctor').getTest(c.req.param('slug'));
    if (!check) throw new HttpError(404, `Resume "${c.req.param('slug')}" has not been tested yet.`);
    return c.json(check);
  });

  mountSkillAddRoutes(app, { onSkillsChanged: () => core.events.emit({ type: 'skills.updated', project_id: '*' }) });
  mountSkillsApi(app, core);

  app.get('/api/captain/recent', (c) => c.json(core.recentRoots()));
  app.post('/api/captain/start', async (c) => {
    const b = await body<CaptainStartReq>(c);
    if (typeof b.cwd !== 'string' || !b.cwd.trim()) throw new HttpError(400, 'captain start needs {cwd}');
    const cwd = resolvePath(b.cwd.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, `cwd ${cwd} does not exist or is not a directory.`);
    if (b.model != null && typeof b.model !== 'string') throw new HttpError(400, 'model must be a string or null');
    if (b.effort != null && typeof b.effort !== 'string') throw new HttpError(400, 'effort must be a string or null');
    const refusal = core.gate('claude', b.model ?? null, b.effort ?? null);
    if (refusal) throw new HttpError(409, refusal);
    try {
      return c.json(await (opts.launchCaptain ?? defaultLaunchCaptain)({ cwd, model: b.model ?? null, effort: b.effort ?? null }));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, `Could not start the captain: ${(e as Error).message}`);
    }
  });

  // ---------------------------------------------------------------- agents
  app.get('/api/agents', (c) => {
    const project = c.req.query('project') || null;
    const rows = core.store.listAgents(project);
    // The _doctor project (probes + its captain) stays hidden unless asked for.
    return c.json(core.withResults(project ? rows : rows.filter((a) => a.project_id !== DOCTOR_PROJECT), project));
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
    const last = c.req.query('last');
    if (last !== undefined) {
      const n = last === '' ? 10 : Number(last);
      if ((last !== '' && !/^\d+$/.test(last)) || !Number.isInteger(n) || n < 1 || n > 50)
        throw new HttpError(400, 'last must be between 1 and 50');
      // Deliberately bypass reply(): recovery must never piggyback pending deliveries.
      return c.json({ inbox: core.deliveredInbox(caller.id, n), team: core.team(caller.id) });
    }
    const wait = Math.min(Math.max(Number(c.req.query('wait')) || 0, 0), 600);
    if (wait > 0) {
      const result = await core.waitForPending(caller.id, wait, c.req.raw.signal);
      if (result === 'superseded') return c.json({ inbox: [], team: core.team(caller.id), superseded: true });
      if (result === 'aborted') return new Response(null, { status: 204 });
    }
    // `team`: the caller's children that are still busy, so a timed-out wait shows each one's latest update.
    return reply(c, { team: core.team(caller.id) });
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
  app.post('/api/hooks/provider-error', async (c) => c.json(core.providerErrorHook(need(c), c.get('callHeader'), await body(c))));
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
