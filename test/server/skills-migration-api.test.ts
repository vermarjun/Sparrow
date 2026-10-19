// Migration API: plan id, apply with backup, rollback to a byte-identical HOME. Sandbox HOME only (SPARROW_SKILLS_HOME).
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLibrary } from '../../src/skills/git';
import { snapshotTree } from '../../src/skills/migrate';
import { makeSkill, sandbox } from '../skills/helpers';
import { setup } from './helpers';

const sh = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${args.join(' ')}: ${p.stderr.toString()}`);
};
const kind = (p: string) => { try { return lstatSync(p).isSymbolicLink() ? 'link' : lstatSync(p).isDirectory() ? 'dir' : 'file'; } catch { return 'none'; } };

/** A realistic old HOME: links into a Desktop/Skills-style folder, a real folder, variants, an External-identical copy. */
async function fixture(opts: { library?: boolean } = {}) {
  const sb = sandbox();
  const { paths } = sb;
  const desk = paths.desktopSkills;
  makeSkill(join(desk, 'desk-skill'), 'desk-skill', 'Lives on the Desktop.\n');
  mkdirSync(paths.roots.claude, { recursive: true });
  symlinkSync(join(desk, 'desk-skill'), join(paths.roots.claude, 'desk-skill'), 'dir');
  makeSkill(join(paths.roots.claude, 'plain'), 'plain', 'A real folder.\n', '');
  makeSkill(join(paths.roots.agents, 'aws-x'), 'aws-x', 'External copy.\n');
  makeSkill(join(paths.roots.claude, 'aws-x'), 'aws-x', 'External copy.\n');              // identical to External
  const old = makeSkill(join(paths.roots.claude, 'variant'), 'variant', 'Claude variant (older).\n');
  const fresh = makeSkill(join(paths.roots.codex, 'variant'), 'variant', 'Codex variant (newer).\n');
  utimesSync(old, new Date(1_000_000), new Date(1_000_000));
  utimesSync(fresh, new Date(2_000_000), new Date(2_000_000));
  if (opts.library) {
    ensureLibrary(paths);
    sh(paths.library, 'git', 'config', 'user.email', 't@example.com');
    sh(paths.library, 'git', 'config', 'user.name', 'T');
    makeSkill(join(paths.library, 'already'), 'already', 'Already in the library.\n');
    sh(paths.library, 'git', 'add', '--all');
    sh(paths.library, 'git', 'commit', '-q', '-m', 'seed');
  }
  const ctx = await setup();
  const seen: string[] = [];
  ctx.core.events.subscribe((e) => { if (e.type === 'skills.updated') seen.push(e.type); });
  const plan = async () => (await ctx.req('POST', '/api/skills/migration/plan')).body;
  // The HOME as the user would compare it: everything except Sparrow's own state dir (backups live there).
  const snap = () => snapshotTree(sb.home).filter((n) => n.path !== '.sparrow' && !n.path.startsWith('.sparrow/'));
  return { ...sb, ...ctx, seen, plan, snap, old, fresh };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const apply = (f: Fx, plan_id: string, choices: Record<string, string> = {}, confirm: unknown = 'migrate') =>
  f.req('POST', '/api/skills/migration/apply', { plan_id, choices, confirm });

describe('plan', () => {
  test('returns a stable plan_id and the backup root, and writes nothing', async () => {
    const f = await fixture();
    const before = f.snap();
    const a = await f.plan();
    const b = await f.plan();
    expect(a.plan_id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.plan_id).toBe(b.plan_id);
    expect(a.backup_root).toBe(f.paths.backup);
    expect(a.decisions.map((d: any) => d.name)).toEqual(['aws-x', 'desk-skill', 'plain', 'variant']);
    expect(f.snap()).toEqual(before);
    expect(existsSync(f.paths.backup)).toBe(false);
  });

  test('the id changes when a candidate folder is edited', async () => {
    const f = await fixture();
    const a = await f.plan();
    writeFileSync(join(f.paths.roots.claude, 'plain', 'SKILL.md'), 'edited\n');
    expect((await f.plan()).plan_id).not.toBe(a.plan_id);
  });
});

describe('variant diff', () => {
  test('compares two planned variants; any other path or name is 404', async () => {
    const f = await fixture();
    const q = (name: string, a: string, b: string) => f.req('GET', `/api/skills/migration/diff?name=${name}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    const r = await q('variant', f.old, f.fresh);
    expect(r.status).toBe(200);
    expect(r.body.diff).toContain('-Claude variant (older).');
    expect(r.body.diff).toContain('+Codex variant (newer).');
    expect((await q('variant', f.old, join(f.paths.roots.claude, 'plain'))).status).toBe(404);
    expect((await q('variant', f.old, '/etc')).status).toBe(404);
    expect((await q('nope', f.old, f.fresh)).status).toBe(404);
  });
});

describe('apply + rollback', () => {
  test('migrates (links, External match, explicit variant choice), backs up first, then rolls back byte-identically', async () => {
    const f = await fixture();
    const before = f.snap();
    const plan = await f.plan();
    expect(existsSync(f.paths.library)).toBe(false);
    const r = await apply(f, plan.plan_id, { variant: f.old });                 // not the default (newest) variant
    expect(r.status).toBe(200);
    expect(r.body.backup.sha256).toBe(createHash('sha256').update(readFileSync(join(r.body.backup.path, 'backup.tar'))).digest('hex'));
    expect(r.body.backup.size).toBeGreaterThan(0);
    expect(r.body.backup.path).toStartWith(f.paths.backup);
    expect(r.body.skipped).toEqual([]);
    expect(r.body.conflicts_left).toEqual([]);
    // library created and initialised, copies verified
    expect(existsSync(join(f.paths.library, '.git'))).toBe(true);
    expect(readFileSync(join(f.paths.library, 'plain', 'SKILL.md'), 'utf8')).toContain('A real folder.');
    expect(readFileSync(join(f.paths.library, 'variant', 'SKILL.md'), 'utf8')).toContain('Claude variant (older)');
    expect(readFileSync(join(f.paths.library, 'desk-skill', 'SKILL.md'), 'utf8')).toContain('Lives on the Desktop.');
    // the library is the single copy: the identical ~/.agents/skills copy moved to the backup, no link to ~/.agents any more
    expect(readFileSync(join(f.paths.library, 'aws-x', 'SKILL.md'), 'utf8')).toContain('External copy.');
    expect(existsSync(join(f.paths.roots.agents, 'aws-x'))).toBe(false);
    expect(existsSync(join(r.body.backup.path, 'agents', 'aws-x', 'SKILL.md'))).toBe(true);
    expect(r.body.link_conflicts).toEqual([]);
    // entries are links now
    expect(kind(join(f.paths.roots.claude, 'plain'))).toBe('link');
    expect(kind(join(f.paths.roots.claude, 'desk-skill'))).toBe('link');
    expect(kind(join(f.paths.roots.codex, 'variant'))).toBe('link');
    expect(kind(join(f.paths.roots.claude, 'variant'))).toBe('link');
    expect(kind(join(f.paths.roots.claude, 'aws-x'))).toBe('link');
    expect(readlinkSync(join(f.paths.roots.claude, 'aws-x'))).toBe(join(f.paths.library, 'aws-x'));
    // the Desktop original became a link to the library; the real folder is in the backup
    expect(kind(join(f.paths.desktopSkills, 'desk-skill'))).toBe('link');
    expect(readFileSync(join(r.body.backup.path, 'desktop', 'desk-skill', 'SKILL.md'), 'utf8')).toContain('Lives on the Desktop.');
    expect(f.seen.length).toBe(1);

    const list = await f.req('GET', '/api/skills/migration/backups');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: r.body.backup.id, sha256: r.body.backup.sha256, rolled_back_at: null });
    expect(list.body[0].moved).toBeGreaterThanOrEqual(5);

    const back = await f.req('POST', '/api/skills/migration/rollback', { backup_id: r.body.backup.id, confirm: 'rollback' });
    expect(back.status).toBe(200);
    expect(f.snap()).toEqual(before);                                             // hash + lstat kind + link targets, whole HOME
    expect(existsSync(f.paths.library)).toBe(false);
    expect(f.seen.length).toBe(2);
    expect((await f.req('GET', '/api/skills/migration/backups')).body[0].rolled_back_at).toBeGreaterThan(0);
    // once only
    const again = await f.req('POST', '/api/skills/migration/rollback', { backup_id: r.body.backup.id, confirm: 'rollback' });
    expect(again.status).toBe(409);
    expect(f.snap()).toEqual(before);
  });

  test('with an existing library the rollback also restores it exactly (and keeps what was added since)', async () => {
    const f = await fixture({ library: true });
    const before = f.snap();
    const plan = await f.plan();
    const r = await apply(f, plan.plan_id);
    expect(r.status).toBe(200);
    expect(existsSync(join(f.paths.library, 'already', 'SKILL.md'))).toBe(true);
    makeSkill(join(f.paths.library, 'added-later'), 'added-later');
    const back = await f.req('POST', '/api/skills/migration/rollback', { backup_id: r.body.backup.id, confirm: 'rollback' });
    expect(back.status).toBe(200);
    expect(back.body.addedSkills).toEqual(['added-later']);
    expect(back.body.preservedAt).toStartWith(r.body.backup.path);
    expect(existsSync(join(back.body.preservedAt, 'library', 'added-later', 'SKILL.md'))).toBe(true);
    expect(f.snap()).toEqual(before);
  });

  test('without a choice, differing copies are never picked: nothing is copied, every copy stays byte-identical', async () => {
    const f = await fixture();
    const plan = await f.plan();
    const variant = plan.decisions.find((d: any) => d.name === 'variant');
    expect(variant).toMatchObject({ needsChoice: true, defaultPath: null, defaultHash: null });
    expect(plan.defaultChoices.variant).toBeUndefined();
    const copies = [f.old, f.fresh];
    const treeOf = (p: string) => snapshotTree(p);
    const trees = copies.map(treeOf);
    const r = await apply(f, plan.plan_id);
    expect(r.status).toBe(200);
    expect(existsSync(join(f.paths.library, 'variant'))).toBe(false);
    expect(r.body.selected.variant).toBeUndefined();
    expect(r.body.kept_as_conflict).toEqual([{ name: 'variant', paths: [f.old, f.fresh] }]);
    expect(copies.map(kind)).toEqual(['dir', 'dir']);
    expect(copies.map(treeOf)).toEqual(trees);
    expect(r.body.applied).not.toContain(f.old);
    expect(r.body.applied).not.toContain(f.fresh);
    // other skills migrated
    expect(kind(join(f.paths.roots.claude, 'plain'))).toBe('link');
    // the copies are still reported by the library state, as Unmanaged entries
    const state = (await f.req('GET', '/api/skills')).body;
    expect(state.unmanaged.filter((e: any) => e.name === 'variant').map((e: any) => e.root).sort()).toEqual(['claude', 'codex']);
  });

  test('choosing either copy installs exactly that copy; the other original is in the backup', async () => {
    for (const pick of ['old', 'fresh'] as const) {
      const f = await fixture();
      const plan = await f.plan();
      const chosen = pick === 'old' ? f.old : f.fresh;
      const r = await apply(f, plan.plan_id, { variant: chosen });
      expect(r.status).toBe(200);
      expect(readFileSync(join(f.paths.library, 'variant', 'SKILL.md'), 'utf8')).toContain(pick === 'old' ? 'Claude variant (older).' : 'Codex variant (newer).');
      expect(r.body.kept_as_conflict).toEqual([]);
      const otherRoot = pick === 'old' ? 'codex' : 'claude';
      expect(readFileSync(join(r.body.backup.path, otherRoot, 'variant', 'SKILL.md'), 'utf8')).toContain(pick === 'old' ? 'Codex variant (newer).' : 'Claude variant (older).');
    }
  });

  test('a skill edited after the plan is refused with 409 and nothing is touched', async () => {
    const f = await fixture();
    const plan = await f.plan();
    writeFileSync(join(f.paths.roots.claude, 'plain', 'SKILL.md'), 'edited after the plan\n');
    const before = f.snap();
    const r = await apply(f, plan.plan_id);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('plan changed');
    expect(f.snap()).toEqual(before);
    expect(existsSync(f.paths.backup)).toBe(false);
    expect(existsSync(f.paths.library)).toBe(false);
    expect(f.seen.length).toBe(0);
    // planning again and applying works, and the edit is what gets migrated
    const again = await apply(f, (await f.plan()).plan_id);
    expect(again.status).toBe(200);
    expect(readFileSync(join(f.paths.library, 'plain', 'SKILL.md'), 'utf8')).toBe('edited after the plan\n');
  });
});

describe('validation and refusals', () => {
  test('confirm, plan_id and choices are checked before anything happens', async () => {
    const f = await fixture();
    const plan = await f.plan();
    const before = f.snap();
    expect((await f.req('POST', '/api/skills/migration/apply', { plan_id: plan.plan_id, choices: {} })).status).toBe(400);
    expect((await apply(f, plan.plan_id, {}, 'yes')).status).toBe(400);
    expect((await apply(f, plan.plan_id, {}, 'rollback')).status).toBe(400);
    expect((await f.req('POST', '/api/skills/migration/apply', { confirm: 'migrate' })).status).toBe(400);
    expect((await apply(f, 'deadbeef')).status).toBe(409);
    expect((await f.req('POST', '/api/skills/migration/apply', { plan_id: plan.plan_id, choices: ['x'], confirm: 'migrate' })).status).toBe(400);
    expect((await f.req('POST', '/api/skills/migration/apply', { plan_id: plan.plan_id, choices: { variant: 7 }, confirm: 'migrate' })).status).toBe(400);
    expect((await apply(f, plan.plan_id, { nope: f.old })).status).toBe(400);
    expect((await apply(f, plan.plan_id, { variant: join(f.paths.roots.claude, 'plain') })).status).toBe(400);
    expect((await apply(f, plan.plan_id, { variant: '/etc' })).status).toBe(400);
    expect(f.snap()).toEqual(before);
    expect(existsSync(f.paths.backup)).toBe(false);
    expect(f.seen.length).toBe(0);
  });

  test('rollback: 400 without confirm, 404 for unknown or path-like ids, 409 for a tampered archive (nothing restored)', async () => {
    const f = await fixture();
    const r = await apply(f, (await f.plan()).plan_id);
    const after = f.snap();
    const id = r.body.backup.id;
    expect((await f.req('POST', '/api/skills/migration/rollback', { backup_id: id })).status).toBe(400);
    expect((await f.req('POST', '/api/skills/migration/rollback', { backup_id: id, confirm: 'migrate' })).status).toBe(400);
    expect((await f.req('POST', '/api/skills/migration/rollback', { confirm: 'rollback' })).status).toBe(400);
    expect((await f.req('POST', '/api/skills/migration/rollback', { backup_id: 'nope', confirm: 'rollback' })).status).toBe(404);
    expect((await f.req('POST', '/api/skills/migration/rollback', { backup_id: '../..', confirm: 'rollback' })).status).toBe(404);
    expect((await f.req('POST', '/api/skills/migration/rollback', { backup_id: '/etc', confirm: 'rollback' })).status).toBe(404);
    writeFileSync(join(r.body.backup.path, 'backup.tar'), 'not the archive');
    const t = await f.req('POST', '/api/skills/migration/rollback', { backup_id: id, confirm: 'rollback' });
    expect(t.status).toBe(409);
    expect(t.body.error).toContain('SHA-256');
    expect(f.snap()).toEqual(after);
  });

  test('backups list ignores adopt/resolve backup folders and is empty before any migration', async () => {
    const f = await fixture();
    expect((await f.req('GET', '/api/skills/migration/backups')).body).toEqual([]);
    mkdirSync(join(f.paths.backup, '2026-01-01T00-00-00.000Z', 'claude', 'x'), { recursive: true });
    expect((await f.req('GET', '/api/skills/migration/backups')).body).toEqual([]);
  });
});
