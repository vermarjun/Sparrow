// Skills HTTP API: every route against a sandbox library, sandbox harness roots (SPARROW_SKILLS_HOME) and a local bare remote.
import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLibrary } from '../../src/skills/git';
import { writeManifest } from '../../src/skills/manifest';
import type { SkillsState } from '../../src/skills/types';
import { makeSkill, sandbox } from '../skills/helpers';
import { setup } from './helpers';

function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const identify = (dir: string) => { sh(dir, 'config', 'user.email', 't@example.com'); sh(dir, 'config', 'user.name', 'Test'); };
const kind = (p: string) => { try { return lstatSync(p).isSymbolicLink() ? 'link' : lstatSync(p).isDirectory() ? 'dir' : 'file'; } catch { return 'none'; } };

/** Library (git, 2 skills, bare origin) + a managed link, an unmanaged real folder, an External entry, a conflict, a broken link. */
async function fixture(opts: { library?: boolean; upstream?: boolean } = {}) {
  const sb = sandbox();
  const { paths } = sb;
  const origin = join(sb.root, 'origin.git');
  if (opts.library !== false) {
    ensureLibrary(paths);
    identify(paths.library);
    makeSkill(join(paths.library, 'alpha'), 'alpha', 'Alpha body\n');
    makeSkill(join(paths.library, 'beta'), 'beta', 'Beta body\n');
    writeManifest({ version: 1, skills: { alpha: { harnesses: ['claude'] }, beta: { harnesses: [] } } }, paths.library, paths);
    sh(paths.library, 'add', '--all');
    sh(paths.library, 'commit', '-m', 'seed');
    Bun.spawnSync(['git', 'init', '--bare', origin]);
    sh(paths.library, 'remote', 'add', 'origin', origin);
    if (opts.upstream !== false) sh(paths.library, 'push', '-u', 'origin', 'HEAD');
    mkdirSync(paths.roots.claude, { recursive: true });
    symlinkSync(join(paths.library, 'alpha'), join(paths.roots.claude, 'alpha'), 'dir');
    makeSkill(join(paths.roots.claude, 'gamma'), 'gamma', 'Gamma body\n');                    // unmanaged
    makeSkill(join(paths.roots.agents, 'delta'), 'delta', 'Delta body\n');                    // external
    makeSkill(join(paths.roots.codex, 'beta'), 'beta', 'Different beta body\n');              // conflict (diff)
    mkdirSync(paths.roots.opencode, { recursive: true });
    symlinkSync(join(sb.home, 'nowhere'), join(paths.roots.opencode, 'ghost'), 'dir');                // broken
  }
  const ctx = await setup();
  const seen: string[] = [];
  ctx.core.events.subscribe((e) => { if (e.type === 'skills.updated') seen.push(e.type); });
  return { ...sb, ...ctx, origin, seen };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const state = async (f: Fx) => (await f.req<SkillsState>('GET', '/api/skills')).body;

describe('GET /api/skills', () => {
  test('lists the library with locked Sparrow skills, link chips and the classified buckets', async () => {
    const f = await fixture();
    const s = await state(f);
    expect(s.library_missing).toBe(false);
    expect(s.paths.home).toBe(f.home);
    expect(s.paths.library).toBe(join(f.home, 'Skills'));
    expect(s.library.map((x) => x.name)).toEqual(['alpha', 'beta', 'sparrow-captain', 'sparrow-worker']);
    const alpha = s.library.find((x) => x.name === 'alpha')!;
    expect(alpha.source).toBe('local');
    expect(alpha.description).toBe('A test skill description.');
    expect(alpha.harnesses).toEqual(['claude']);
    const byHarness = Object.fromEntries(alpha.links.map((l) => [l.harness, l]));
    expect(byHarness.claude).toMatchObject({ wanted: true, state: 'linked', alsoReadBy: ['opencode'] });
    expect(byHarness.codex).toMatchObject({ wanted: false, state: 'off' });
    expect(byHarness.opencode).toMatchObject({ state: 'off', viaRoot: 'claude' });
    // beta is off in the manifest but a real folder sits in the codex root
    expect(s.library.find((x) => x.name === 'beta')!.links.find((l) => l.harness === 'codex')!.state).toBe('conflict');
    const worker = s.library.find((x) => x.name === 'sparrow-worker')!;
    expect(worker).toMatchObject({ locked: true, source: 'sparrow', harnesses: ['claude', 'codex', 'opencode'] });
    expect(worker.links.every((l) => l.state === 'locked')).toBe(true);
    expect(s.unmanaged.map((e) => e.name)).toEqual(['gamma']);
    expect(s.external.map((e) => e.name)).toEqual(['delta']);
    expect(s.conflicts.map((e) => `${e.root}/${e.name}/${e.conflict}`)).toEqual(['codex/beta/diff']);
    expect(s.broken.map((e) => e.name)).toEqual(['ghost']);
    expect(s.git).toMatchObject({ available: true, remote: f.origin, dirty: [] });
  });

  test('library missing: reports it, creates nothing on GET, refuses writes, init creates the repo', async () => {
    const f = await fixture({ library: false });
    const s = await state(f);
    expect(s.library_missing).toBe(true);
    expect(s.git.available).toBe(false);
    expect(s.library.map((x) => x.name)).toEqual(['sparrow-captain', 'sparrow-worker']);
    expect(s.warnings.join('\n')).toContain('not set up');
    expect(existsSync(f.paths.library)).toBe(false);
    makeSkill(join(f.paths.roots.claude, 'gamma'), 'gamma');
    const adopt = await f.req('POST', '/api/skills/adopt', { path: join(f.paths.roots.claude, 'gamma') });
    expect(adopt.status).toBe(409);
    expect(adopt.body.error).toContain('library/init');
    expect((await f.req('POST', '/api/skills/sync')).status).toBe(409);
    expect((await f.req('POST', '/api/skills/git/commit', { message: 'x' })).status).toBe(409);
    expect(existsSync(f.paths.library)).toBe(false);
    const init = await f.req<SkillsState>('POST', '/api/skills/library/init');
    expect(init.status).toBe(200);
    expect(init.body.library_missing).toBe(false);
    expect(existsSync(join(f.paths.library, '.git'))).toBe(true);
    expect(existsSync(join(f.paths.library, 'skills.json'))).toBe(true);
    expect(f.seen.length).toBe(1);
    // idempotent
    expect((await f.req('POST', '/api/skills/library/init')).status).toBe(200);
  });

  test('warns about library folders missing from skills.json and manifest entries without a folder', async () => {
    const f = await fixture();
    makeSkill(join(f.paths.library, 'orphan'), 'orphan');
    writeManifest({ version: 1, skills: { alpha: { harnesses: ['claude'] }, beta: { harnesses: [] }, vanished: { harnesses: ['codex'] } } }, f.paths.library, f.paths);
    const s = await state(f);
    expect(s.warnings.some((w) => w.startsWith('orphan:'))).toBe(true);
    expect(s.warnings.some((w) => w.startsWith('vanished:'))).toBe(true);
    expect(s.library.find((x) => x.name === 'orphan')!.inManifest).toBe(false);
  });

  test('invalid manifest names are surfaced as warnings and skipped by sync', async () => {
    const f = await fixture();
    const file = join(f.paths.library, 'skills.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      skills: {
        alpha: { harnesses: ['claude'] },
        '../../escape': { harnesses: ['codex'] },
        beta: { harnesses: [] },
      },
    }));
    const s = await state(f);
    expect(s.warnings.some((warning) => warning.includes('invalid skill name') && warning.includes('../../escape'))).toBe(true);
    const synced = await f.req('POST', '/api/skills/sync');
    expect(synced.status).toBe(200);
    expect(synced.body.conflicts.some((item: any) => item.reason.includes('invalid skill name'))).toBe(true);
  });
});

describe('GET /api/skills/:name', () => {
  test('detail: rendered source, file tree, git log of the folder, entries, 404', async () => {
    const f = await fixture();
    mkdirSync(join(f.paths.library, 'alpha', 'scripts'));
    writeFileSync(join(f.paths.library, 'alpha', 'scripts', 'run.sh'), 'echo hi\n');
    const r = await f.req('GET', '/api/skills/alpha');
    expect(r.status).toBe(200);
    expect(r.body.skill.name).toBe('alpha');
    expect(r.body.skill_md).toContain('Alpha body');
    const names = r.body.files.map((n: any) => `${n.type}:${n.name}`);
    expect(names).toEqual(['dir:scripts', 'file:SKILL.md']);
    expect(r.body.files[0].children[0]).toMatchObject({ name: 'run.sh', path: 'scripts/run.sh', type: 'file' });
    expect(r.body.log.map((c: any) => c.subject)).toEqual(['seed']);
    expect(r.body.entries.map((e: any) => `${e.root}/${e.name}`).sort()).toEqual(['claude/alpha', 'library/alpha']);
    const locked = await f.req('GET', '/api/skills/sparrow-worker');
    expect(locked.status).toBe(200);
    expect(locked.body.skill.locked).toBe(true);
    expect(locked.body.log).toEqual([]);
    expect(locked.body.skill_md.length).toBeGreaterThan(10);
    expect((await f.req('GET', '/api/skills/nope')).status).toBe(404);
    expect((await f.req('GET', '/api/skills/..%2F..%2Fetc')).status).toBe(400);
    expect((await f.req('GET', '/api/skills/Bad_Name')).status).toBe(400);
  });
});

describe('PUT /api/skills/:name/harnesses', () => {
  test('toggles links on and off, updates skills.json, emits a skills event', async () => {
    const f = await fixture();
    const codexLink = join(f.paths.roots.codex, 'alpha');
    let r = await f.req('PUT', '/api/skills/alpha/harnesses', { harnesses: ['claude', 'codex'] });
    expect(r.status).toBe(200);
    expect(r.body.actions.map((a: any) => `${a.type}:${a.root}`)).toEqual(['create:codex']);
    expect(r.body.conflicts).toEqual([]);
    expect(readlinkSync(codexLink)).toBe(join(f.paths.library, 'alpha'));
    expect(r.body.skill.harnesses).toEqual(['claude', 'codex']);
    expect(r.body.skill.links.find((l: any) => l.harness === 'codex').state).toBe('linked');
    expect(JSON.parse(readFileSync(join(f.paths.library, 'skills.json'), 'utf8')).skills.alpha.harnesses).toEqual(['claude', 'codex']);
    expect(f.seen.length).toBe(1);
    r = await f.req('PUT', '/api/skills/alpha/harnesses', { harnesses: ['claude'] });
    expect(r.body.actions.map((a: any) => `${a.type}:${a.root}`)).toEqual(['remove-own-link:codex']);
    expect(kind(codexLink)).toBe('none');
    r = await f.req('PUT', '/api/skills/alpha/harnesses', { harnesses: [] });
    expect(kind(join(f.paths.roots.claude, 'alpha'))).toBe('none');
    expect(r.body.skill.links.every((l: any) => l.state === 'off')).toBe(true);
  });

  test('only the toggled skill changes; a real folder in the way is a conflict and stays untouched', async () => {
    const f = await fixture();
    const real = join(f.paths.roots.codex, 'beta');
    const before = readFileSync(join(real, 'SKILL.md'), 'utf8');
    const r = await f.req('PUT', '/api/skills/beta/harnesses', { harnesses: ['codex'] });
    expect(r.status).toBe(200);
    expect(r.body.actions).toEqual([]);
    expect(r.body.conflicts).toHaveLength(1);
    expect(r.body.conflicts[0]).toMatchObject({ type: 'conflict', root: 'codex', name: 'beta' });
    expect(kind(real)).toBe('dir');
    expect(readFileSync(join(real, 'SKILL.md'), 'utf8')).toBe(before);
    expect(r.body.skill.links.find((l: any) => l.harness === 'codex').state).toBe('conflict');
    // unrelated: alpha's link was not touched, gamma stays a real folder
    expect(kind(join(f.paths.roots.claude, 'alpha'))).toBe('link');
    expect(kind(join(f.paths.roots.claude, 'gamma'))).toBe('dir');
  });

  test('validation and refusals: 400 bad body, 404 unknown, 409 locked Sparrow skills', async () => {
    const f = await fixture();
    expect((await f.req('PUT', '/api/skills/alpha/harnesses', { harnesses: 'claude' })).status).toBe(400);
    expect((await f.req('PUT', '/api/skills/alpha/harnesses', { harnesses: ['claude', 'vim'] })).status).toBe(400);
    expect((await f.req('PUT', '/api/skills/alpha/harnesses', {})).status).toBe(400);
    expect((await f.req('PUT', '/api/skills/nope/harnesses', { harnesses: [] })).status).toBe(404);
    expect((await f.req('PUT', '/api/skills/Bad_Name/harnesses', { harnesses: [] })).status).toBe(400);
    for (const name of ['sparrow-worker', 'sparrow-captain']) {
      const r = await f.req('PUT', `/api/skills/${name}/harnesses`, { harnesses: [] });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain('Sparrow skill');
    }
    expect(JSON.parse(readFileSync(join(f.paths.library, 'skills.json'), 'utf8')).skills['sparrow-worker']).toBeUndefined();
    expect(f.seen.length).toBe(0);
  });
});

describe('POST /api/skills/sync', () => {
  test('recreates a missing link from the manifest', async () => {
    const f = await fixture();
    unlinkSync(join(f.paths.roots.claude, 'alpha'));
    expect(kind(join(f.paths.roots.claude, 'alpha'))).toBe('none');
    const r = await f.req('POST', '/api/skills/sync');
    expect(r.status).toBe(200);
    expect(r.body.actions.map((a: any) => `${a.type}:${a.root}:${a.name}`)).toEqual(['create:claude:alpha']);
    expect(kind(join(f.paths.roots.claude, 'alpha'))).toBe('link');
    expect(f.seen.length).toBe(1);
  });
});

describe('POST /api/skills/adopt', () => {
  test('Unmanaged: copied into the library, original moved to the backup and replaced by a link', async () => {
    const f = await fixture();
    const path = join(f.paths.roots.claude, 'gamma');
    const r = await f.req('POST', '/api/skills/adopt', { path });
    expect(r.status).toBe(200);
    expect(r.body.skill).toMatchObject({ name: 'gamma', harnesses: ['claude'] });
    expect(kind(join(f.paths.library, 'gamma'))).toBe('dir');
    expect(kind(path)).toBe('link');
    expect(r.body.backup).toContain(f.paths.backup);
    expect(readFileSync(join(r.body.backup, 'SKILL.md'), 'utf8')).toContain('Gamma body');
    expect((await state(f)).unmanaged).toEqual([]);
    expect((await state(f)).git.dirty.some((d) => d.includes('gamma'))).toBe(true);
    expect(f.seen.length).toBe(1);
  });

  test('External: copied, the original stays where it is, nothing is linked until toggled', async () => {
    const f = await fixture();
    const path = join(f.paths.roots.agents, 'delta');
    const r = await f.req('POST', '/api/skills/adopt', { path });
    expect(r.status).toBe(200);
    expect(r.body.backup).toBeNull();
    expect(r.body.skill).toMatchObject({ name: 'delta', harnesses: [] });
    expect(kind(path)).toBe('dir');
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toContain('Delta body');
    expect(kind(join(f.paths.library, 'delta'))).toBe('dir');
  });

  test('errors: 400 without path, 404 for a path no scan lists (even a real folder), 409 for managed/conflict/broken', async () => {
    const f = await fixture();
    expect((await f.req('POST', '/api/skills/adopt', {})).status).toBe(400);
    expect((await f.req('POST', '/api/skills/adopt', { path: join(f.paths.roots.claude, 'gamma'), harnesses: ['x'] })).status).toBe(400);
    const outside = join(f.root, 'elsewhere');
    makeSkill(outside, 'elsewhere');
    expect((await f.req('POST', '/api/skills/adopt', { path: outside })).status).toBe(404);
    expect((await f.req('POST', '/api/skills/adopt', { path: '/etc' })).status).toBe(404);
    expect(existsSync(join(f.paths.library, 'elsewhere'))).toBe(false);
    for (const p of [join(f.paths.roots.claude, 'alpha'), join(f.paths.roots.codex, 'beta'), join(f.paths.roots.opencode, 'ghost')]) {
      const r = await f.req('POST', '/api/skills/adopt', { path: p });
      expect(r.status).toBe(409);
    }
    expect(kind(join(f.paths.roots.codex, 'beta'))).toBe('dir');
  });
});

describe('conflicts', () => {
  test('diff: library vs the entry copy; 400 / 404 paths', async () => {
    const f = await fixture();
    const path = join(f.paths.roots.codex, 'beta');
    const r = await f.req('GET', `/api/skills/beta/diff?path=${encodeURIComponent(path)}`);
    expect(r.status).toBe(200);
    expect(r.body.diff).toContain('-Beta body');
    expect(r.body.diff).toContain('+Different beta body');
    expect((await f.req('GET', '/api/skills/beta/diff')).status).toBe(400);
    expect((await f.req('GET', `/api/skills/alpha/diff?path=${encodeURIComponent(path)}`)).status).toBe(404);
    expect((await f.req('GET', `/api/skills/beta/diff?path=${encodeURIComponent(join(f.paths.library, 'beta'))}`)).status).toBe(404);
    expect((await f.req('GET', '/api/skills/beta/diff?path=/etc')).status).toBe(404);
  });

  test('keep library: the entry goes to the backup and becomes a link; the manifest records the harness', async () => {
    const f = await fixture();
    const path = join(f.paths.roots.codex, 'beta');
    const r = await f.req('POST', '/api/skills/conflicts/resolve', { path, keep: 'library' });
    expect(r.status).toBe(200);
    expect(kind(path)).toBe('link');
    expect(readlinkSync(path)).toBe(join(f.paths.library, 'beta'));
    expect(readFileSync(join(f.paths.library, 'beta', 'SKILL.md'), 'utf8')).toContain('Beta body');
    expect(readFileSync(join(r.body.backup, 'codex', 'beta', 'SKILL.md'), 'utf8')).toContain('Different beta body');
    expect(r.body.skill.harnesses).toEqual(['codex']);
    expect((await state(f)).conflicts).toEqual([]);
    expect(f.seen.length).toBe(1);
  });

  test('keep entry: the entry bytes become the library copy; the old library copy is backed up', async () => {
    const f = await fixture();
    const path = join(f.paths.roots.codex, 'beta');
    const r = await f.req('POST', '/api/skills/conflicts/resolve', { path, keep: 'entry' });
    expect(r.status).toBe(200);
    expect(readFileSync(join(f.paths.library, 'beta', 'SKILL.md'), 'utf8')).toContain('Different beta body');
    expect(readFileSync(join(r.body.backup, 'library', 'beta', 'SKILL.md'), 'utf8')).toContain('Beta body');
    expect(readFileSync(join(r.body.backup, 'codex', 'beta', 'SKILL.md'), 'utf8')).toContain('Different beta body');
    expect(kind(path)).toBe('link');
    expect(readdirSync(f.paths.library).filter((n) => n.endsWith('-tmp'))).toEqual([]);
    expect((await state(f)).conflicts).toEqual([]);
  });

  test('identical copy: one click replaces it with a link', async () => {
    const f = await fixture();
    const copy = join(f.paths.roots.codex, 'alpha');
    cpSync(join(f.paths.library, 'alpha'), copy, { recursive: true });
    let s = await state(f);
    expect(s.conflicts.find((e) => e.name === 'alpha')!.conflict).toBe('identical');
    const r = await f.req('POST', '/api/skills/conflicts/resolve', { path: copy, keep: 'library' });
    expect(r.status).toBe(200);
    expect(kind(copy)).toBe('link');
    s = await state(f);
    expect(s.conflicts.map((e) => e.name)).toEqual(['beta']);
    expect(s.library.find((x) => x.name === 'alpha')!.links.find((l) => l.harness === 'codex')!.state).toBe('linked');
  });

  test('errors: 400 keep, 400/404 path, 409 for a non-conflict entry', async () => {
    const f = await fixture();
    const path = join(f.paths.roots.codex, 'beta');
    expect((await f.req('POST', '/api/skills/conflicts/resolve', { path, keep: 'both' })).status).toBe(400);
    expect((await f.req('POST', '/api/skills/conflicts/resolve', { keep: 'library' })).status).toBe(400);
    expect((await f.req('POST', '/api/skills/conflicts/resolve', { path: '/etc', keep: 'library' })).status).toBe(404);
    expect((await f.req('POST', '/api/skills/conflicts/resolve', { path: join(f.paths.roots.claude, 'gamma'), keep: 'library' })).status).toBe(409);
    expect(kind(path)).toBe('dir');
    expect(f.seen.length).toBe(0);
  });
});

describe('imported skills whose name differs from the folder', () => {
  test('GET /api/skills flags the mismatch on a hand-made library folder but not on an imported one', async () => {
    const f = await fixture();
    const { paths } = f;
    makeSkill(join(paths.library, 'hand-made'), 'other-name');
    makeSkill(join(paths.library, 'vercel-imported'), 'Vercel Imported');
    writeManifest({ version: 1, skills: {
      alpha: { harnesses: ['claude'] }, beta: { harnesses: [] }, 'hand-made': { harnesses: [] },
      'vercel-imported': { harnesses: [], source: { source: 'o/r', sourceType: 'github', sourceUrl: 'https://github.com/o/r.git', skillPath: 'skills/x/SKILL.md' } },
    } }, paths.library, paths);
    const s = await state(f);
    const by = (n: string) => s.library.find((x) => x.name === n)!;
    expect(by('hand-made').problems.map((p) => p.code)).toContain('name-folder');
    expect(by('vercel-imported').problems).toEqual([]);
  });
});

describe('git', () => {
  test('GET /api/skills/git reports branch, changes, unpushed', async () => {
    const f = await fixture();
    makeSkill(join(f.paths.library, 'new'), 'new');
    const r = await f.req('GET', '/api/skills/git');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: true, remote: f.origin, ahead: 0 });
    expect(r.body.dirty).toEqual(['new/']);
  });

  test('commit & push goes to origin; the commit shows up in the bare repo', async () => {
    const f = await fixture();
    makeSkill(join(f.paths.library, 'new'), 'new');
    const r = await f.req('POST', '/api/skills/git/commit', { message: 'add new', push: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dirty: [], ahead: 0 });
    expect(sh(f.origin, 'log', '--format=%s', '-n', '1')).toBe('add new');
    expect(f.seen.length).toBe(1);
  });

  test('commit without push leaves it unpushed; a later push-only request pushes it', async () => {
    const f = await fixture();
    makeSkill(join(f.paths.library, 'new'), 'new');
    let r = await f.req('POST', '/api/skills/git/commit', { message: 'local only' });
    expect(r.status).toBe(200);
    expect(r.body.ahead).toBe(1);
    expect(sh(f.origin, 'log', '--format=%s', '-n', '1')).toBe('seed');
    r = await f.req('POST', '/api/skills/git/commit', { message: 'again', push: true });
    expect(r.status).toBe(200);
    expect(r.body.ahead).toBe(0);
    expect(sh(f.origin, 'log', '--format=%s', '-n', '1')).toBe('local only');
    expect((await f.req('POST', '/api/skills/git/commit', { message: 'again' })).status).toBe(409);
  });

  test('manual origin gets an upstream on push and pull explains when none is configured', async () => {
    const f = await fixture({ upstream: false });
    // no upstream: the seed commit exists on no remote branch, so it counts as unpushed
    expect((await f.req('GET', '/api/skills/git')).body).toMatchObject({ remote: f.origin, ahead: 1, behind: null });

    const pull = await f.req('POST', '/api/skills/git/pull');
    expect(pull.status).toBe(409);
    expect(pull.body.error).toBe('Cannot pull skills library: the current branch has no upstream tracking branch. Push to origin first to set one, or configure an upstream branch.');
    expect(pull.body.error).not.toContain('There is no tracking information');

    makeSkill(join(f.paths.library, 'new'), 'new');
    const push = await f.req('POST', '/api/skills/git/commit', { message: 'set manual origin upstream', push: true });
    expect(push.status).toBe(200);
    expect(push.body).toMatchObject({ remote: f.origin, ahead: 0, behind: 0 });
    const branch = sh(f.paths.library, 'branch', '--show-current');
    expect(sh(f.paths.library, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe(`origin/${branch}`);
    expect(sh(f.origin, 'log', '--format=%s', '-n', '1')).toBe('set manual origin upstream');
  });

  test('no upstream yet: commit without push, then Commit & push on the clean tree pushes and sets the upstream', async () => {
    const f = await fixture({ upstream: false });
    makeSkill(join(f.paths.library, 'new'), 'new');
    let r = await f.req('POST', '/api/skills/git/commit', { message: 'local only' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dirty: [], ahead: 2 });
    r = await f.req('POST', '/api/skills/git/commit', { message: 'push now', push: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dirty: [], ahead: 0, behind: 0 });
    expect(sh(f.origin, 'log', '--format=%s', '-n', '1')).toBe('local only');
    expect(sh(f.paths.library, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toContain('origin/');
    expect((await f.req('POST', '/api/skills/git/commit', { message: 'again', push: true })).status).toBe(409);
  });

  test('refusals: 400 message/push/remote fields, 409 nothing to commit, 409 push without a remote (nothing committed)', async () => {
    const f = await fixture();
    expect((await f.req('POST', '/api/skills/git/commit', {})).status).toBe(400);
    expect((await f.req('POST', '/api/skills/git/commit', { message: '  ' })).status).toBe(400);
    expect((await f.req('POST', '/api/skills/git/commit', { message: 'x', push: 'yes' })).status).toBe(400);
    for (const key of ['remote', 'url', 'origin']) {
      const r = await f.req('POST', '/api/skills/git/commit', { message: 'x', push: true, [key]: join(f.root, 'other.git') });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('own origin');
    }
    const nothing = await f.req('POST', '/api/skills/git/commit', { message: 'x' });
    expect(nothing.status).toBe(409);
    expect(nothing.body.error).toContain('Nothing to commit');
    sh(f.paths.library, 'remote', 'remove', 'origin');
    makeSkill(join(f.paths.library, 'new'), 'new');
    const r = await f.req('POST', '/api/skills/git/commit', { message: 'x', push: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('no origin');
    expect(sh(f.paths.library, 'log', '--format=%s', '-n', '1')).toBe('seed');
    expect(sh(f.paths.library, 'status', '--porcelain')).toContain('new/');
    expect((await state(f)).git.remote).toBeNull();
    expect(f.seen.length).toBe(0);
    // a plain local commit still works without a remote
    expect((await f.req('POST', '/api/skills/git/commit', { message: 'local' })).status).toBe(200);
    expect((await f.req('POST', '/api/skills/git/pull')).status).toBe(409);
  });

  test('pull fast-forwards from origin; refused with local changes', async () => {
    const f = await fixture();
    const other = join(f.root, 'other');
    sh(f.root, 'clone', f.origin, other);
    identify(other);
    makeSkill(join(other, 'upstream'), 'upstream');
    sh(other, 'add', '--all');
    sh(other, 'commit', '-m', 'from elsewhere');
    sh(other, 'push', 'origin', 'HEAD');
    makeSkill(join(f.paths.library, 'dirty'), 'dirty');
    const refused = await f.req('POST', '/api/skills/git/pull');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('uncommitted');
    expect(existsSync(join(f.paths.library, 'upstream'))).toBe(false);
    sh(f.paths.library, 'add', '--all');
    sh(f.paths.library, 'commit', '-m', 'wip');
    sh(f.paths.library, 'reset', '--hard', 'HEAD~1');
    const r = await f.req('POST', '/api/skills/git/pull');
    expect(r.status).toBe(200);
    expect(r.body.dirty).toEqual([]);
    expect(existsSync(join(f.paths.library, 'upstream', 'SKILL.md'))).toBe(true);
    expect((await state(f)).library.map((x) => x.name)).toContain('upstream');
    expect(f.seen.length).toBe(1);
  });

  test('a diverged history is a 409, not a merge', async () => {
    const f = await fixture();
    const other = join(f.root, 'other');
    sh(f.root, 'clone', f.origin, other);
    identify(other);
    makeSkill(join(other, 'upstream'), 'upstream');
    sh(other, 'add', '--all');
    sh(other, 'commit', '-m', 'remote side');
    sh(other, 'push', 'origin', 'HEAD');
    makeSkill(join(f.paths.library, 'local'), 'local');
    sh(f.paths.library, 'add', '--all');
    sh(f.paths.library, 'commit', '-m', 'local side');
    const r = await f.req('POST', '/api/skills/git/pull');
    expect(r.status).toBe(409);
    expect(existsSync(join(f.paths.library, 'upstream'))).toBe(false);
  });
});

describe('POST /api/skills/migration/plan', () => {
  test('returns the dry-run plan and writes nothing', async () => {
    const f = await fixture();
    const snapshot = () => Bun.spawnSync(['find', f.home, '-not', '-path', '*/.git/*'], { stdout: 'pipe' }).stdout.toString();
    const before = snapshot();
    const r = await f.req('POST', '/api/skills/migration/plan');
    expect(r.status).toBe(200);
    expect(r.body.home).toBe(f.home);
    expect(r.body.decisions.map((d: any) => d.name)).toContain('gamma');
    expect(snapshot()).toBe(before);
    expect(existsSync(f.paths.backup)).toBe(false);
  });
});

describe('routing', () => {
  test('static skill routes win over :name, and unknown /api/skills paths 404 as JSON', async () => {
    const f = await fixture();
    expect((await f.req('GET', '/api/skills/git')).body).toHaveProperty('available');
    const r = await f.req('DELETE', '/api/skills/alpha');
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('No such endpoint');
  });
});

describe('GET /api/skills/matrix', () => {
  const WRITE = (skills?: string[]) => ({
    title: 'Probe', description: 'd', harness: 'fake', model: null, effort: null, can_hire: [],
    limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: 'You probe.\n', ...(skills ? { skills } : {}),
  });
  type Matrix = { resumes: { slug: string; title: string; harness: string; skills: string[]; hired: number; stale: number }[]; skills: string[]; locked: string[] };

  test('shape: resumes with skills/hired/stale, grantable library names (no locked), the two locked names; not shadowed by /:name', async () => {
    const f = await fixture();
    const r = await f.req<Matrix>('GET', '/api/skills/matrix');
    expect(r.status).toBe(200);
    expect(r.body.skills).toEqual(['alpha', 'beta']);
    expect(r.body.locked).toEqual(['sparrow-worker', 'sparrow-captain']);
    const builder = r.body.resumes.find((x) => x.slug === 'builder')!;
    expect(builder).toEqual({ slug: 'builder', title: 'Builder', harness: 'claude', skills: [], hired: 0, stale: 0 });
    expect(r.body.resumes.map((x) => x.slug)).toContain('researcher');
  });

  test('toggle through PUT /api/resumes round-trips; unknown names are kept and show up as missing; hired/stale counts follow; a skills event is emitted', async () => {
    const f = await fixture();
    await f.req('POST', '/api/resumes', { slug: 'probe', ...WRITE(['alpha']) });
    const agent = (await f.req('POST', '/api/hire', { resume: 'probe', task: 'go' }, f.captain.id)).body.agent;
    let m = (await f.req<Matrix>('GET', '/api/skills/matrix')).body;
    expect(m.resumes.find((x) => x.slug === 'probe')).toMatchObject({ skills: ['alpha'], hired: 1, stale: 0 });
    const before = f.seen.length;
    const put = await f.req('PUT', '/api/resumes/probe', WRITE(['alpha', 'beta', 'ghost']));
    expect(put.status).toBe(200);
    expect(f.seen.length).toBe(before + 1);
    m = (await f.req<Matrix>('GET', '/api/skills/matrix')).body;
    const row = m.resumes.find((x) => x.slug === 'probe')!;
    expect(row).toMatchObject({ skills: ['alpha', 'beta', 'ghost'], hired: 1, stale: 1 });
    expect(row.skills.filter((n) => !m.skills.includes(n) && !m.locked.includes(n))).toEqual(['ghost']); // the warning row
    // a save that does not change skills emits no skills event
    await f.req('PUT', '/api/resumes/probe', { ...WRITE(['alpha', 'beta', 'ghost']), title: 'Probe 2' });
    expect(f.seen.length).toBe(before + 1);
    // untoggle
    await f.req('PUT', '/api/resumes/probe', WRITE(['beta']));
    expect(((await f.req<Matrix>('GET', '/api/skills/matrix')).body.resumes.find((x) => x.slug === 'probe')!).skills).toEqual(['beta']);
    // apply clears stale; the agent's grants follow
    await f.req('POST', '/api/resumes/probe/apply');
    expect(((await f.req<Matrix>('GET', '/api/skills/matrix')).body.resumes.find((x) => x.slug === 'probe')!).stale).toBe(0);
    expect(agent.id).toBeTruthy();
  });
});

describe('POST /api/skills/matrix (atomic toggle)', () => {
  const FILE = ['---', 'name: probe', '# a comment the user wrote', 'title: Probe', 'description: d', 'harness: fake', 'model: null', 'effort: null', 'can_hire: []', '', 'limits: { quiet_minutes: 15, max_call_minutes: 90 }', '---', 'You probe.', ''].join('\n');
  const put = (f: Fx) => writeFileSync(join(f.core.resumes.writeDir, 'probe.md'), FILE);
  const read = (f: Fx) => readFileSync(join(f.core.resumes.writeDir, 'probe.md'), 'utf8');
  const toggle = (f: Fx, body: unknown) => f.req('POST', '/api/skills/matrix', body);

  test('edits only the skills: line: comments and every other byte stay; emits skills + resume events', async () => {
    const f = await fixture();
    put(f);
    const before = f.seen.length;
    const r = await toggle(f, { slug: 'probe', skill: 'alpha', on: true });
    expect(r.status).toBe(200);
    expect(r.body.resume.skills).toEqual(['alpha']);
    expect(read(f)).toBe(FILE.replace('can_hire: []\n', 'can_hire: []\nskills: [alpha]\n'));
    expect(f.seen.length).toBe(before + 1);
    await toggle(f, { slug: 'probe', skill: 'beta', on: true });
    await toggle(f, { slug: 'probe', skill: 'alpha', on: false });
    expect(read(f)).toBe(FILE.replace('can_hire: []\n', 'can_hire: []\nskills: [beta]\n'));
    await toggle(f, { slug: 'probe', skill: 'beta', on: false });
    expect(read(f)).toBe(FILE); // back to the original bytes
    // a no-op (already on / already off) writes nothing and emits nothing
    const n = f.seen.length;
    expect((await toggle(f, { slug: 'probe', skill: 'beta', on: false })).status).toBe(200);
    expect(f.seen.length).toBe(n);
    expect(read(f)).toBe(FILE);
  });

  test('interleaved toggles all land (explicit on/off, synchronous read-modify-write)', async () => {
    const f = await fixture();
    put(f);
    await toggle(f, { slug: 'probe', skill: 'alpha', on: true });
    await toggle(f, { slug: 'probe', skill: 'beta', on: true });
    const rs = await Promise.all([
      toggle(f, { slug: 'probe', skill: 'gamma', on: true }),
      toggle(f, { slug: 'probe', skill: 'beta', on: false }),
      toggle(f, { slug: 'probe', skill: 'delta', on: true }),
      toggle(f, { slug: 'probe', skill: 'alpha', on: false }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(f.core.resumes.get('probe')!.skills).toEqual(['gamma', 'delta']);
    expect(read(f)).toContain('# a comment the user wrote\n');
  });

  test('a missing-from-library name can be removed (warning rows), 404 unknown slug, 400 invalid, 409 locked, 400 bad body', async () => {
    const f = await fixture();
    put(f);
    await toggle(f, { slug: 'probe', skill: 'ghost', on: true }); // unknown but valid: kept, reported at hire
    expect(f.core.resumes.get('probe')!.skills).toEqual(['ghost']);
    expect((await toggle(f, { slug: 'probe', skill: 'ghost', on: false })).body.resume.skills).toEqual([]);
    expect((await toggle(f, { slug: 'nope', skill: 'alpha', on: true })).status).toBe(404);
    const bad = await toggle(f, { slug: 'probe', skill: '../etc', on: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('not a valid skill name');
    expect((await toggle(f, { slug: 'probe', skill: 'Bad Name', on: true })).status).toBe(400);
    for (const skill of ['sparrow-worker', 'sparrow-captain']) {
      for (const on of [true, false]) expect((await toggle(f, { slug: 'probe', skill, on })).status).toBe(409);
    }
    expect((await toggle(f, { slug: 'probe', skill: 'alpha' })).status).toBe(400);
    expect((await toggle(f, { slug: 'Bad Slug', skill: 'alpha', on: true })).status).toBe(400);
    expect(read(f)).toBe(FILE);
  });
});
