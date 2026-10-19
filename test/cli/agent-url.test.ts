// D19(a): an agent's reporting goes to SPARROW_AGENT_URL (the server that spawned it), not to a changed SPARROW_PORT/HOME.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { StubServer, agent, captain, msg, project, run, freePort } from './helpers';

const stub = new StubServer(await freePort());
const other = new StubServer(await freePort());   // what a changed SPARROW_PORT/SPARROW_URL would point at
afterAll(() => { stub.stop(); other.stop(); });
beforeEach(() => {
  for (const s of [stub, other]) {
    s.reset();
    s.on('GET', '/api/whoami', { agent: agent(), project, parent: captain, inbox: [] });
    s.on('POST', '/api/update', { message: msg({ kind: 'update' }), inbox: [] });
    s.on('POST', '/api/done', { ended: true, inbox: [] });
    s.on('POST', '/api/ask', { ended: true, inbox: [] });
    s.on('POST', '/api/wait', { ended: true, inbox: [] });
    s.on('GET', '/api/inbox', { inbox: [], team: [] });
  }
});

const AGENT = { SPARROW_AGENT_ID: 'ag_JAMES', SPARROW_CALL_ID: 'call_1' };
const redirected = () => ({ SPARROW_PORT: String(other.port), SPARROW_HOME: '/tmp/some-sandbox-home' });

describe('agent mode reports to SPARROW_AGENT_URL', () => {
  const cmds: [string, string[], string][] = [
    ['update', ['update', 'x'], '/api/update'], ['done', ['done', 'x'], '/api/done'], ['ask', ['ask', 'q?'], '/api/ask'],
    ['wait', ['wait', 'r'], '/api/wait'], ['inbox', ['inbox'], '/api/inbox'], ['whoami', ['whoami'], '/api/whoami'],
  ];
  for (const [name, args, path] of cmds) {
    test(`${name} goes to the launch server even with SPARROW_PORT/SPARROW_HOME/SPARROW_URL pointing elsewhere`, async () => {
      const r = await run(args, { env: { ...AGENT, SPARROW_AGENT_URL: stub.url, SPARROW_URL: other.url, ...redirected() } });
      expect(r.stderr).toBe('');
      expect(stub.requests.filter((q) => q.path.split('?')[0] === path).length).toBeGreaterThan(0);
      expect(other.requests.length).toBe(0);
    });
  }
  test('without SPARROW_AGENT_URL the old behaviour (SPARROW_URL) is unchanged', async () => {
    const r = await run(['update', 'x'], { env: { ...AGENT, SPARROW_URL: stub.url } });
    expect(r.stderr).toBe('');
    expect(stub.find('POST', '/api/update').length).toBe(1);
  });
  test('captain mode (no SPARROW_AGENT_ID) ignores SPARROW_AGENT_URL', async () => {
    stub.on('POST', '/api/captains/register', { agent: captain, project, inbox: [] });
    other.on('POST', '/api/captains/register', { agent: captain, project, inbox: [] });
    const r = await run(['update', 'x'], { env: { SPARROW_AGENT_URL: other.url, SPARROW_URL: stub.url } });
    expect(r.stderr).toBe('');
    expect(stub.find('POST', '/api/captains/register').length).toBe(1);
    expect(other.requests.length).toBe(0);
  });
});
