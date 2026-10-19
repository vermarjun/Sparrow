// Per-agent skills end to end on the server with the fake spawner: hire snapshots the grants, call start passes
// them, a resume edit changes nothing until "apply", and missing skills are reported without failing the hire.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSnapshot } from '../../src/skills/grant';
import { flush, hire, setup } from './helpers';

let lib: string;
let oldDir: string | undefined;
beforeAll(() => {
  oldDir = process.env.SPARROW_SKILLS_DIR;
  lib = mkdtempSync(join(tmpdir(), 'sp-srv-lib-'));
  for (const n of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(lib, n));
    writeFileSync(join(lib, n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n}\n---\n`);
  }
  process.env.SPARROW_SKILLS_DIR = lib;
});
afterAll(() => {
  if (oldDir === undefined) delete process.env.SPARROW_SKILLS_DIR; else process.env.SPARROW_SKILLS_DIR = oldDir;
  rmSync(lib, { recursive: true, force: true });
});

const WRITE = (skills: string[] | undefined) => ({
  title: 'Skilled', description: 'd', harness: 'fake', model: null, effort: null, can_hire: [],
  limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: 'You are skilled.\n', ...(skills ? { skills } : {}),
});
const names = (s: { skills?: { name: string }[] }) => (s.skills ?? []).map((g) => g.name);
const SP = ['sparrow-worker', 'sparrow-captain'];

async function nextCall(ctx: Awaited<ReturnType<typeof setup>>, agentId: string, text: string) {
  await ctx.req('POST', '/api/done', { summary: 'ok' }, agentId, ctx.store.getAgent(agentId)!.call_id);
  await ctx.clock.advance(10_000);
  await ctx.req('POST', '/api/send', { to: `@${ctx.store.getAgent(agentId)!.handle}`, text }, ctx.captain.id);
  await flush();
}

describe('skills grants on the server', () => {
  test('hire snapshots; start passes the grants; a resume edit waits for apply; apply refreshes', async () => {
    const ctx = await setup();
    expect((await ctx.req('POST', '/api/resumes', { slug: 'skilled', ...WRITE(['alpha', 'beta']) })).status).toBe(201);
    const a = await hire(ctx, 'skilled', 'go');
    await flush();
    const first = ctx.sp.startsFor(a.id)[0];
    expect(names(first)).toEqual([...SP, 'alpha', 'beta']);
    expect(first.skills!.find((g) => g.name === 'alpha')!.path).toBe(join(lib, 'alpha'));
    expect(names({ skills: readSnapshot(a.id)!.grants })).toEqual([...SP, 'alpha', 'beta']);

    // edit the resume: no effect on this agent's next call (snapshot semantics)
    const upd = await ctx.req('PUT', '/api/resumes/skilled', WRITE(['gamma']));
    expect(upd.status).toBe(200);
    expect(upd.body.skills).toEqual(['gamma']);
    expect(upd.body.stale_agents).toEqual([a.id]);
    await nextCall(ctx, a.id, 'second');
    expect(names(ctx.sp.startsFor(a.id).at(-1)!)).toEqual([...SP, 'alpha', 'beta']);

    // apply refreshes the snapshot; the next call sees the new set
    expect((await ctx.req('POST', '/api/resumes/skilled/apply')).body).toEqual({ updated: [a.id] });
    expect(names({ skills: readSnapshot(a.id)!.grants })).toEqual([...SP, 'gamma']);
    await nextCall(ctx, a.id, 'third');
    expect(names(ctx.sp.startsFor(a.id).at(-1)!)).toEqual([...SP, 'gamma']);

    // clearing the list leaves Sparrow's two
    await ctx.req('PUT', '/api/resumes/skilled', WRITE([]));
    await ctx.req('POST', '/api/resumes/skilled/apply');
    await nextCall(ctx, a.id, 'fourth');
    expect(names(ctx.sp.startsFor(a.id).at(-1)!)).toEqual(SP);
  });

  test('a resume without skills gets Sparrow\'s two only', async () => {
    const ctx = await setup();
    const a = await hire(ctx, 'fake', 'go');
    await flush();
    expect(names(ctx.sp.startsFor(a.id)[0])).toEqual(SP);
  });

  test('missing/invalid skills: hire still succeeds, warnings in the task message meta and the log', async () => {
    const ctx = await setup();
    await ctx.req('POST', '/api/resumes', { slug: 'skilled', ...WRITE(['alpha', 'ghost', '../evil']) });
    const r = await ctx.req('POST', '/api/hire', { resume: 'skilled', task: 'go' }, ctx.captain.id);
    expect(r.status).toBe(200);
    const w = r.body.message.meta.skills_warnings as string[];
    expect(w.length).toBe(2);
    expect(w[0]).toContain('"ghost" is not in the library');
    expect(w[1]).toContain('"../evil" is not a valid skill name');
    expect(ctx.logs.some((l) => l.includes('"ghost" is not in the library'))).toBe(true);
    await flush();
    expect(names(ctx.sp.startsFor(r.body.agent.id)[0])).toEqual([...SP, 'alpha']);
  });

  test('an agent hired before the feature (no snapshot) falls back to the current resume', async () => {
    const ctx = await setup();
    await ctx.req('POST', '/api/resumes', { slug: 'skilled', ...WRITE(['beta']) });
    const a = await hire(ctx, 'skilled', 'go');
    await flush();
    rmSync(join(process.env.SPARROW_HOME!, 'agents', a.id, 'skills.json'));
    await ctx.req('PUT', '/api/resumes/skilled', WRITE(['gamma']));
    await nextCall(ctx, a.id, 'again');
    expect(names(ctx.sp.startsFor(a.id).at(-1)!)).toEqual([...SP, 'gamma']);
  });

  test('PUT without skills leaves them unchanged; an explicit [] clears; a save keeps what the API returned', async () => {
    const ctx = await setup();
    await ctx.req('POST', '/api/resumes', { slug: 'skilled', ...WRITE(['alpha', 'beta']) });
    const { skills: _omit, ...noSkills } = WRITE(['x']);
    const kept = await ctx.req('PUT', '/api/resumes/skilled', { ...noSkills, title: 'Renamed' });
    expect(kept.status).toBe(200);
    expect(kept.body.title).toBe('Renamed');
    expect(kept.body.skills).toEqual(['alpha', 'beta']);
    expect(ctx.core.resumes.get('skilled')!.skills).toEqual(['alpha', 'beta']);
    const cleared = await ctx.req('PUT', '/api/resumes/skilled', WRITE([]));
    expect(cleared.body.skills).toEqual([]);
    const still = await ctx.req('PUT', '/api/resumes/skilled', noSkills);
    expect(still.body.skills).toEqual([]);
  });

  test('duplicate copies skills', async () => {
    const ctx = await setup();
    await ctx.req('POST', '/api/resumes', { slug: 'skilled', ...WRITE(['alpha']) });
    const d = await ctx.req('POST', '/api/resumes/skilled/duplicate', { slug: 'skilled-2' });
    expect(d.body.skills).toEqual(['alpha']);
    const bad = await ctx.req('PUT', '/api/resumes/skilled', { ...WRITE(['alpha']), skills: 'alpha' });
    expect(bad.status).toBe(400);
  });
});
