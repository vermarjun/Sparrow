// Library location safety (must-fix #4) and aliased harness folders. Sandbox HOME only (SPARROW_SKILLS_HOME).
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { skillsCheck } from '../../src/server/doctor';
import { resolveGrants, launchGrants } from '../../src/skills/grant';
import { ensureLibrary } from '../../src/skills/git';
import { apply, plan as linkPlan, sync } from '../../src/skills/link';
import { applyMigration, backup, planMigration, rollback } from '../../src/skills/migrate';
import { readManifest, writeManifest } from '../../src/skills/manifest';
import {
  assertWritable, harnessRootGroups, libraryProblem, rootAliasWarnings, rootPrimary, skillPaths,
} from '../../src/skills/paths';
import { resolveConflict } from '../../src/skills/resolve';
import { scanSkills } from '../../src/skills/scan';
import { setup } from '../server/helpers';
import { makeSkill, makeSymlink, sandbox } from './helpers';

const withLibrary = (env: NodeJS.ProcessEnv, library: string) => skillPaths({ ...env, SPARROW_SKILLS_DIR: library });

describe('libraryProblem: the library may not equal, contain or sit inside a harness folder or a migration source', () => {
  test('a separate folder (default and custom) is fine', () => {
    const { env, home } = sandbox();
    expect(libraryProblem(skillPaths(env))).toBeNull();
    expect(libraryProblem(withLibrary(env, join(home, 'my', 'library')))).toBeNull();
  });

  test.each([
    ['the Claude folder', '.claude/skills', /is the same folder as the Claude skills folder/],
    ['the Codex folder', '.codex/skills', /is the same folder as the Codex skills folder/],
    ['the OpenCode folder', '.config/opencode/skills', /is the same folder as the OpenCode skills folder/],
    ['~/.agents/skills', '.agents/skills', /is the same folder as ~\/\.agents\/skills/],
    ['~/Desktop/Skills (a migration source)', 'Desktop/Skills', /is the same folder as ~\/Desktop\/Skills/],
  ])('equal to %s is refused', (_label, rel, message) => {
    const { env, home } = sandbox();
    expect(libraryProblem(withLibrary(env, join(home, rel)))).toMatch(message);
  });

  test('containing a harness folder or a migration source is refused', () => {
    const { env, home } = sandbox();
    expect(libraryProblem(withLibrary(env, join(home, '.claude')))).toMatch(/contains the Claude skills folder/);
    expect(libraryProblem(withLibrary(env, join(home, 'Desktop')))).toMatch(/contains ~\/Desktop\/Skills/);
    expect(libraryProblem(withLibrary(env, home))).toMatch(/contains/);
  });

  test('sitting inside a harness folder or a migration source is refused', () => {
    const { env, home } = sandbox();
    expect(libraryProblem(withLibrary(env, join(home, '.codex', 'skills', 'lib')))).toMatch(/sits inside the Codex skills folder/);
    expect(libraryProblem(withLibrary(env, join(home, 'Desktop', 'Skills', 'lib')))).toMatch(/sits inside ~\/Desktop\/Skills/);
  });

  test('compares REAL paths: ~/.claude/skills is a symlink to the folder the library is set to', () => {
    const { env, home } = sandbox();
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    makeSymlink(elsewhere, join(home, '.claude', 'skills'));
    // different written paths, same real folder
    expect(libraryProblem(withLibrary(env, elsewhere))).toMatch(/is the same folder as the Claude skills folder/);
    // a library that merely lives next to it is fine
    expect(libraryProblem(withLibrary(env, join(home, 'elsewhere-2')))).toBeNull();
    // and one inside the symlink's target is inside the Claude folder by real path
    expect(libraryProblem(withLibrary(env, join(elsewhere, 'lib')))).toMatch(/sits inside the Claude skills folder/);
  });

  test('a library given as a symlink to a harness folder is refused (SPARROW_SKILLS_DIR and config skills_dir)', () => {
    const { env, home } = sandbox();
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    const lib = join(home, 'lib-link');
    makeSymlink(join(home, '.codex', 'skills'), lib);
    expect(libraryProblem(withLibrary(env, lib))).toMatch(/Codex skills folder/);
    const viaConfig = skillPaths({ ...env, SPARROW_SETTINGS: JSON.stringify({ skills_dir: lib }) });
    expect(viaConfig.library).toBe(lib);
    expect(libraryProblem(viaConfig)).toMatch(/Codex skills folder/);
  });
});

/** The real-world trap: Desktop/Skills is the library AND the harness folders link into it. */
function desktopLibrary() {
  const sb = sandbox();
  const paths = withLibrary(sb.env, sb.paths.desktopSkills);
  makeSkill(join(paths.library, 'cold-email'), 'cold-email', 'Lives on the Desktop.\n');
  makeSymlink(join(paths.library, 'cold-email'), join(paths.roots.claude, 'cold-email'));
  makeSkill(join(paths.roots.claude, 'plain'), 'plain', 'Real folder.\n');
  return { ...sb, paths };
}

describe('a refused library is never written, planned, migrated or resolved against', () => {
  test('writes into the library or a root it overlaps are refused with the reason', () => {
    const { paths } = desktopLibrary();
    expect(() => assertWritable(join(paths.library, 'x'), paths)).toThrow(/Refusing write: The skills library .* is the same folder as ~\/Desktop\/Skills/);
    expect(() => ensureLibrary(paths)).toThrow(/Refusing write/);
    expect(() => writeManifest({ version: 1, skills: {} }, paths.library, paths)).toThrow(/Refusing write/);
    // a normal write elsewhere in the fence is untouched by this guard
    expect(() => assertWritable(join(paths.roots.claude, 'plain2'), paths)).not.toThrow();
  });

  test('migration plan, backup, apply and rollback all refuse', () => {
    const { paths } = desktopLibrary();
    expect(() => planMigration(paths)).toThrow(/Refusing write/);
    const safe = skillPaths({ HOME: paths.home, SPARROW_SKILLS_HOME: paths.home, SPARROW_HOME: paths.sparrowHome });
    const plan = planMigration(safe);
    expect(() => backup(plan, paths)).toThrow(/Refusing write/);
    expect(() => applyMigration(plan, {}, paths)).toThrow(/Refusing write/);
    const saved = backup(plan, safe);
    expect(() => rollback(saved, paths)).toThrow(/Refusing write/);
    expect(existsSync(join(paths.library, 'plain'))).toBe(false); // nothing was moved into the "library"
    expect(lstatSync(join(paths.roots.claude, 'plain')).isDirectory()).toBe(true);
  });

  test('link planning and applying refuse', () => {
    const { paths } = desktopLibrary();
    expect(() => linkPlan({ version: 1, skills: {} }, [], paths)).toThrow(/Refusing write/);
    expect(() => apply([], paths)).toThrow(/Refusing write/);
    expect(() => sync(paths)).toThrow(/Refusing write/);
  });

  test('conflict resolution refuses', () => {
    const { paths } = desktopLibrary();
    expect(() => resolveConflict(join(paths.roots.claude, 'plain'), 'library', paths)).toThrow(/Refusing write/);
  });

  test('Doctor fails with the same reason and a fix that names the setting', async () => {
    const { paths } = desktopLibrary();
    const result = await skillsCheck(paths);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/is the same folder as ~\/Desktop\/Skills/);
    expect(result.fix).toMatch(/skills_dir/);
  });

  test('a refused library grants no skill to an agent, and Sparrow\'s own skills still launch', () => {
    const { paths, home } = desktopLibrary();
    const keep = { lib: process.env.SPARROW_SKILLS_DIR };
    process.env.SPARROW_SKILLS_DIR = paths.library;
    try {
      const res = resolveGrants(['cold-email']);
      expect(res.grants.map((g) => g.name)).not.toContain('cold-email');
      expect(res.warnings.join('\n')).toMatch(/not granted: The skills library/);
      const forced = [{ name: 'cold-email', path: join(paths.library, 'cold-email') }];
      expect(launchGrants(forced)).toEqual([]);
      expect(home).toBeTruthy();
    } finally {
      if (keep.lib === undefined) delete process.env.SPARROW_SKILLS_DIR; else process.env.SPARROW_SKILLS_DIR = keep.lib;
    }
  });
});

describe('self-referential entries are skipped', () => {
  test('scan: a harness folder that IS the library is not scanned as a harness root (no duplicate entries)', () => {
    const sb = sandbox();
    const paths = withLibrary(sb.env, sb.paths.roots.claude);
    makeSkill(join(paths.library, 'one'), 'one');
    makeSkill(join(paths.library, 'two'), 'two');
    const entries = scanSkills(paths);
    expect(entries.filter((e) => e.name === 'one').map((e) => e.root)).toEqual(['library']);
    expect(entries.filter((e) => e.root === 'claude')).toEqual([]);
  });

  test('scan: a harness entry that is a link to the library itself, or to a folder that contains it, is not listed', () => {
    const sb = sandbox();
    const lib = join(sb.home, 'Skills');
    const paths = withLibrary(sb.env, lib);
    makeSkill(join(lib, 'real'), 'real');
    makeSkill(lib, 'the-library-itself'); // a SKILL.md at the library root would otherwise make it a "skill"
    makeSymlink(lib, join(paths.roots.claude, 'self'));
    makeSymlink(sb.home, join(paths.roots.claude, 'up'));
    makeSymlink(join(lib, 'real'), join(paths.roots.claude, 'real')); // a normal managed link stays listed
    const names = scanSkills(paths).filter((e) => e.root === 'claude').map((e) => `${e.name}:${e.status}`);
    expect(names).toEqual(['real:managed']);
  });

  test('migration: links to the library copy, to the library itself or into another library skill are skipped, never copied', () => {
    const sb = sandbox();
    const lib = join(sb.home, 'Skills');
    const paths = withLibrary(sb.env, lib);
    makeSkill(join(lib, 'in-lib'), 'in-lib');
    makeSkill(join(lib, 'other'), 'other');
    makeSymlink(join(lib, 'in-lib'), join(paths.roots.claude, 'in-lib'));
    makeSymlink(lib, join(paths.roots.claude, 'self'));
    makeSymlink(join(lib, 'other'), join(paths.roots.claude, 'alias'));
    const result = planMigration(paths);
    expect(result.candidates).toEqual([]);
    expect(Object.fromEntries(result.skipped.map((s) => [s.path.split('/').pop(), s.code]))).toEqual({ 'in-lib': 'in-library', alias: 'in-library' });
  });

  test('resolve: an entry that points into the library cannot "keep entry" over the library copy', () => {
    const sb = sandbox();
    const lib = join(sb.home, 'Skills');
    const paths = withLibrary(sb.env, lib);
    makeSkill(join(lib, 'a'), 'a', 'A.\n');
    makeSkill(join(lib, 'b'), 'b', 'B.\n');
    makeSymlink(join(lib, 'b'), join(paths.roots.claude, 'a')); // named a, content of b: a conflict with library/a
    expect(scanSkills(paths).find((e) => e.root === 'claude' && e.name === 'a')?.status).toBe('conflict');
    expect(() => resolveConflict(join(paths.roots.claude, 'a'), 'entry', paths)).toThrow(/points into the library itself/);
  });
});

describe('a harness folder that is a symlink to another harness folder is one root', () => {
  function aliased() {
    const sb = sandbox();
    const { paths, home } = sb;
    mkdirSync(paths.roots.claude, { recursive: true });
    makeSymlink(paths.roots.claude, paths.roots.codex); // ~/.codex/skills -> ~/.claude/skills
    return { ...sb, paths: skillPaths(sb.env), home };
  }

  test('groups and warnings', () => {
    const { paths } = aliased();
    expect(harnessRootGroups(paths)).toEqual([['claude', 'codex'], ['opencode']]);
    expect(rootPrimary('codex', paths)).toBe('claude');
    const warnings = rootAliasWarnings(paths);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/codex skills folder .* is the same folder as the claude one/);
    expect(warnings[0]).toMatch(/does not remove claude's links/);
    const { paths: plain } = sandbox();
    expect(rootAliasWarnings(plain)).toEqual([]);
  });

  test('turning codex off does not remove claude\'s link; the link goes only when no harness of the group wants it', () => {
    const { paths } = aliased();
    makeSkill(join(paths.library, 'shared'), 'shared');
    const link = join(paths.roots.claude, 'shared');
    const both = { version: 1, skills: { shared: { harnesses: ['claude', 'codex'] as ('claude' | 'codex')[] } } };
    // one create for the one folder, not two
    const create = linkPlan(both, scanSkills(paths), paths);
    expect(create.map((a) => `${a.type}:${a.root}`)).toEqual(['create:claude']);
    apply(create, paths);
    expect(readlinkSync(link)).toBe(join(paths.library, 'shared'));
    expect(readlinkSync(join(paths.roots.codex, 'shared'))).toBe(join(paths.library, 'shared')); // same link, seen through the alias

    // codex off, claude still on: nothing to do
    const claudeOnly = { version: 1, skills: { shared: { harnesses: ['claude' as const] } } };
    expect(linkPlan(claudeOnly, scanSkills(paths), paths)).toEqual([]);
    // claude off, codex still on: the shared link stays too (codex reads the same folder)
    const codexOnly = { version: 1, skills: { shared: { harnesses: ['codex' as const] } } };
    expect(linkPlan(codexOnly, scanSkills(paths), paths)).toEqual([]);
    // both off: exactly one removal
    const none = { version: 1, skills: { shared: { harnesses: [] } } };
    const remove = linkPlan(none, scanSkills(paths), paths);
    expect(remove.map((a) => `${a.type}:${a.root}`)).toEqual(['remove-own-link:claude']);
    expect(apply(remove, paths)).toEqual([]);
    expect(() => lstatSync(link)).toThrow();
  });

  test('a skill that left the manifest is unlinked once, not once per alias', () => {
    const { paths } = aliased();
    makeSkill(join(paths.library, 'gone'), 'gone');
    makeSymlink(join(paths.library, 'gone'), join(paths.roots.claude, 'gone'));
    const actions = linkPlan({ version: 1, skills: {} }, scanSkills(paths), paths);
    expect(actions.map((a) => `${a.type}:${a.root}`)).toEqual(['remove-own-link:claude']);
  });

  test('migration treats the two as one root and folds the toggles', () => {
    const { paths } = aliased();
    makeSkill(join(paths.roots.claude, 'mine'), 'mine');
    const result = planMigration(paths);
    expect(result.candidates.map((c) => `${c.root}:${c.name}`)).toEqual(['claude:mine']);
    expect(result.skipped.filter((s) => s.code === 'alias')).toHaveLength(1);
    expect(result.warnings.join('\n')).toMatch(/is the same folder/);
    expect(result.decisions[0]!.harnesses).toEqual(['claude', 'codex', 'opencode']);
    const saved = backup(result, paths);
    const applied = applyMigration(result, {}, paths, saved);
    expect(applied.linkConflicts).toEqual([]);
    expect(readManifest(paths.library).skills.mine?.harnesses).toEqual(['claude', 'codex', 'opencode']);
    expect(rollback(saved, paths).notRestored).toEqual([]);
    expect(lstatSync(join(paths.roots.claude, 'mine')).isDirectory()).toBe(true);
  });
});

describe('API and UI state', () => {
  test('GET /api/skills reports library_problem; writes and the migration refuse with 409', async () => {
    const sb = sandbox();
    const ctx = await setup();
    const prev = process.env.SPARROW_SKILLS_DIR;
    process.env.SPARROW_SKILLS_DIR = sb.paths.desktopSkills;
    try {
      makeSkill(join(sb.paths.desktopSkills, 'x'), 'x');
      const state = await ctx.req('GET', '/api/skills');
      expect(state.status).toBe(200);
      expect(state.body.library_problem).toMatch(/is the same folder as ~\/Desktop\/Skills/);
      expect(state.body.warnings.join('\n')).toMatch(/is the same folder as ~\/Desktop\/Skills/);
      for (const [method, path, body] of [
        ['POST', '/api/skills/library/init', undefined],
        ['POST', '/api/skills/sync', undefined],
        ['PUT', '/api/skills/x/harnesses', { harnesses: ['claude'] }],
        ['POST', '/api/skills/migration/plan', undefined],
        ['POST', '/api/skills/migration/apply', { plan_id: 'x', choices: {}, confirm: 'migrate' }],
        ['POST', '/api/skills/migration/rollback', { backup_id: 'x', confirm: 'rollback' }],
      ] as const) {
        const r = await ctx.req(method, path, body as any);
        expect([path, r.status]).toEqual([path, 409]);
        expect(r.body.error).toMatch(/skills library/);
      }
      expect(existsSync(join(sb.paths.desktopSkills, '.git'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SPARROW_SKILLS_DIR; else process.env.SPARROW_SKILLS_DIR = prev;
    }
  });
});
