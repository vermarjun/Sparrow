// D13: every non-GET /api/* route refuses cross-site pages (Sec-Fetch-Site, Origin) and non-JSON bodies;
// the CLI (no Origin, JSON) and the same-origin UI keep working.
import { describe, expect, test } from 'bun:test';
import { sandbox } from '../skills/helpers';
import { agentOf, setup } from './helpers';

const BASE = 'http://127.0.0.1:4040';

async function raw(ctx: Awaited<ReturnType<typeof setup>>, method: string, path: string, headers: Record<string, string>, body?: string) {
  const res = await ctx.app.request(BASE + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const routes: [string, string, unknown][] = [
  ['POST', '/api/cards', { title: 'x' }],
  ['PATCH', '/api/cards/1', { state: 'done' }],
  ['POST', '/api/resumes', { slug: 'zz', title: 'Z', description: 'd', harness: 'fake', body: 'b' }],
  ['PUT', '/api/resumes/builder', { title: 'B', description: 'd', harness: 'claude', body: 'b' }],
  ['DELETE', '/api/resumes/builder', undefined],
  ['POST', '/api/captain/start', { cwd: '/tmp' }],
  ['POST', '/api/catalog/refresh', undefined],
  ['POST', '/api/doctor/run', undefined],
  ['POST', '/api/skills/updates', undefined],
  ['POST', '/api/hire', { resume: 'fake', task: 'x' }],
  ['POST', '/api/send', { to: '@x', text: 'x' }],
  ['POST', '/api/hooks/turn-end', {}],
  ['POST', '/api/hooks/exit', { code: 0 }],
  ['POST', '/api/hooks/session', { session_id: 's' }],
];

describe('cross-site writes are refused', () => {
  test('Sec-Fetch-Site: cross-site / same-site → 403 on every sampled route', async () => {
    const ctx = await setup();
    for (const site of ['cross-site', 'same-site']) {
      for (const [m, p, b] of routes) {
        const r = await raw(ctx, m, p, { 'content-type': 'application/json', 'sec-fetch-site': site }, b === undefined ? undefined : JSON.stringify(b));
        expect([m, p, r.status]).toEqual([m, p, 403]);
        expect(r.body.error).toContain(site);
      }
    }
  });

  test('foreign, wrong-port and null Origins → 403', async () => {
    const ctx = await setup();
    for (const origin of ['https://evil.example', 'http://evil.example:4040', 'http://127.0.0.1:5173', 'http://localhost:9999', 'https://127.0.0.1:4040', 'null', 'garbage']) {
      for (const [m, p, b] of routes) {
        const r = await raw(ctx, m, p, { 'content-type': 'application/json', origin }, b === undefined ? undefined : JSON.stringify(b));
        expect([origin, m, p, r.status]).toEqual([origin, m, p, 403]);
        expect(r.body.error).toContain('Origin');
      }
    }
  });

  test('a cross-site text/plain "simple request" creates nothing', async () => {
    const ctx = await setup();
    const r = await raw(ctx, 'POST', '/api/cards', { 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      JSON.stringify({ project: ctx.captain.project_id, title: 'pwned' }));
    expect(r.status).toBe(403);
    expect(ctx.store.listCards(ctx.captain.project_id)).toEqual([]);
  });
});

describe('request bodies must be JSON', () => {
  test('text/plain, form posts and a missing content type → 415', async () => {
    const ctx = await setup();
    for (const ct of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      for (const [m, p] of routes.filter((r) => r[2] !== undefined)) {
        const headers: Record<string, string> = ct ? { 'content-type': ct } : {};
        const r = await raw(ctx, m, p, headers, ct.startsWith('application/x-www') ? 'a=b' : '{"a":1}');
        expect([ct, m, p, r.status]).toEqual([ct, m, p, 415]);
      }
    }
  });

  test('body-less writes need no content type; JSON (+charset, +json) is accepted', async () => {
    const ctx = await setup();
    expect((await raw(ctx, 'POST', '/api/doctor/run', {})).status).toBe(200);
    const ok = await raw(ctx, 'POST', '/api/cards', { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ project: ctx.captain.project_id, title: 'a' }));
    expect(ok.status).toBe(200);
    const ld = await raw(ctx, 'POST', '/api/cards', { 'content-type': 'application/vnd.sparrow+json' }, JSON.stringify({ project: ctx.captain.project_id, title: 'b' }));
    expect(ld.status).toBe(200);
  });
});

describe('the skills upload is the one multipart route', () => {
  test('same-origin multipart reaches the upload handler; cross-site / foreign Origin multipart → 403', async () => {
    const ctx = await setup();
    const mp = { 'content-type': 'multipart/form-data; boundary=x' };
    // Malformed body: the guard lets it through and the upload handler answers 400 (not the guard's 415).
    expect((await raw(ctx, 'POST', '/api/skills/upload', { ...mp, origin: 'http://127.0.0.1:4040', 'sec-fetch-site': 'same-origin' }, '--y')).status).toBe(400);
    expect((await raw(ctx, 'POST', '/api/skills/upload', { ...mp, 'sec-fetch-site': 'cross-site' }, '--y')).status).toBe(403);
    expect((await raw(ctx, 'POST', '/api/skills/upload', { ...mp, origin: 'https://evil.example' }, '--y')).status).toBe(403);
    // ...and only there: multipart on any other write route is still 415.
    expect((await raw(ctx, 'POST', '/api/cards', mp, '--y')).status).toBe(415);
  });
});

describe('the skills update check is a guarded write, not a GET', () => {
  test('cross-site page: POST → 403 and GET never reaches the check (it falls to the skill detail route: 404)', async () => {
    sandbox(); // sandboxed skills home: nothing here may read the real library or clone its sources
    const ctx = await setup();
    const site = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };
    expect((await raw(ctx, 'POST', '/api/skills/updates', site)).status).toBe(403);
    const get = await raw(ctx, 'GET', '/api/skills/updates', site);
    expect(get.status).toBe(404);
    expect(get.body.error).toContain('No library skill');
    const same = await raw(ctx, 'POST', '/api/skills/updates', { origin: 'http://127.0.0.1:4040', 'sec-fetch-site': 'same-origin' });
    expect(same.status).toBe(200);
    expect(same.body).toEqual([]);
  });
});

describe('legitimate callers still work', () => {
  test('CLI-shaped requests (identity header, JSON, no Origin) → 200', async () => {
    const ctx = await setup();
    const a = await ctx.req('POST', '/api/hire', { resume: 'fake', task: 'FAKE:idle' }, ctx.captain.id);
    expect(a.status).toBe(200);
    const id = a.body.agent.id;
    const call = agentOf(ctx, id).call_id;
    const up = await raw(ctx, 'POST', '/api/update', { 'content-type': 'application/json', 'x-sparrow-agent': id, 'x-sparrow-call': call! }, JSON.stringify({ text: 'hi' }));
    expect(up.status).toBe(200);
    const te = await raw(ctx, 'POST', '/api/hooks/turn-end', { 'content-type': 'application/json', 'x-sparrow-agent': id, 'x-sparrow-call': call! }, JSON.stringify({ harness: 'fake' }));
    expect(te.status).toBe(200);
  });

  test('same-origin UI requests (Origin = own host, Sec-Fetch-Site: same-origin) → 200; localhost and 127.0.0.1 both fine', async () => {
    const ctx = await setup();
    for (const origin of ['http://127.0.0.1:4040', 'http://localhost:4040']) {
      const r = await raw(ctx, 'POST', '/api/cards', { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' }, JSON.stringify({ project: ctx.captain.project_id, title: origin }));
      expect(r.status).toBe(200);
    }
    const patch = await raw(ctx, 'PATCH', '/api/cards/1', { 'content-type': 'application/json', origin: 'http://127.0.0.1:4040', 'sec-fetch-site': 'same-origin' }, JSON.stringify({ state: 'done' }));
    expect(patch.status).toBe(200);
  });

  test('GETs are never guarded', async () => {
    const ctx = await setup();
    const r = await raw(ctx, 'GET', '/api/health', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(200);
  });
});

describe('over real HTTP (Bun.serve)', () => {
  test('body-less POST, JSON POST and a same-origin Origin pass; text/plain and a foreign Origin do not', async () => {
    const ctx = await setup();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: ctx.app.fetch });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const post = (path: string, headers: Record<string, string>, body?: string) => fetch(url + path, { method: 'POST', headers, body });
      expect((await post('/api/doctor/run', {})).status).toBe(200);
      expect((await post('/api/cards', { 'content-type': 'application/json', origin: url }, JSON.stringify({ project: ctx.captain.project_id, title: 'a' }))).status).toBe(200);
      expect((await post('/api/cards', { 'content-type': 'text/plain' }, '{}')).status).toBe(415);
      expect((await post('/api/cards', { 'content-type': 'application/json', origin: 'http://evil.example' }, '{}')).status).toBe(403);
      expect((await post('/api/cards', { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port! + 1}` }, '{}')).status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});
