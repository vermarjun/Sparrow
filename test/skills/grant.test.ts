import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSETS } from '../../src/shared/config';
import {
  frontmatterName, grantsFor, libraryDir, materializeLinks, readSnapshot, resolveGrants, sparrowSkills, usableGrants,
  withSparrow, writeSnapshot,
} from '../../src/skills/grant';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `sp-grant-${p}-`));

function skill(root: string, folder: string, name = folder) {
  const d = join(root, folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${folder} test\n---\nbody\n`);
  return d;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

describe('libraryDir', () => {
  test('SPARROW_SKILLS_DIR wins, then skills_dir setting (~ expanded), then <home>/Skills; SPARROW_SKILLS_HOME is home', () => {
    const home = tmp('home');
    expect(withEnv({ SPARROW_SKILLS_HOME: home, SPARROW_SKILLS_DIR: undefined, SPARROW_SETTINGS: undefined }, libraryDir)).toBe(join(home, 'Skills'));
    expect(withEnv({ SPARROW_SKILLS_HOME: home, SPARROW_SKILLS_DIR: join(home, 'lib') }, libraryDir)).toBe(join(home, 'lib'));
    expect(withEnv({ SPARROW_SKILLS_HOME: home, SPARROW_SKILLS_DIR: undefined, SPARROW_SETTINGS: JSON.stringify({ skills_dir: '~/mine' }) }, libraryDir)).toBe(join(home, 'mine'));
  });
});

describe('resolveGrants', () => {
  test('library skills + Sparrow\'s two; missing and invalid names are warnings, never paths', () => {
    const lib = tmp('lib');
    skill(lib, 'alpha');
    skill(lib, 'beta');
    mkdirSync(join(lib, 'no-skill-md'));
    const r = withEnv({ SPARROW_SKILLS_DIR: lib }, () => resolveGrants(['alpha', 'ghost', 'no-skill-md', '../etc', 'Bad_Name', 'beta', 'sparrow-worker']));
    expect(r.grants.map((g) => g.name)).toEqual(['sparrow-worker', 'sparrow-captain', 'alpha', 'beta']);
    expect(r.grants.find((g) => g.name === 'alpha')!.path).toBe(join(lib, 'alpha'));
    expect(r.grants.find((g) => g.name === 'sparrow-worker')!.path).toBe(join(ASSETS, 'skills', 'sparrow-worker'));
    expect(r.warnings.length).toBe(4);
    expect(r.warnings.join('\n')).toContain('"ghost" is not in the library');
    expect(r.warnings.join('\n')).toContain('"no-skill-md" is not in the library');
    expect(r.warnings.join('\n')).toContain('"../etc" is not a valid skill name');
    expect(r.warnings.join('\n')).toContain('"Bad_Name" is not a valid skill name');
  });

  test('real-path boundary: a library entry symlinked outside the library is refused; one symlinked inside is fine', () => {
    const lib = tmp('lib'), outside = tmp('outside');
    skill(lib, 'real-one');
    const out = skill(outside, 'escape');
    symlinkSync(out, join(lib, 'escape'), 'dir');
    symlinkSync(join(lib, 'real-one'), join(lib, 'alias'), 'dir');
    // the library itself reached through a symlink is still the library
    const libLink = join(tmp('links'), 'lib-link');
    symlinkSync(lib, libLink, 'dir');
    for (const dir of [lib, libLink]) {
      const r = withEnv({ SPARROW_SKILLS_DIR: dir }, () => resolveGrants(['escape', 'alias', 'real-one']));
      expect(r.grants.map((g) => g.name)).toEqual(['sparrow-worker', 'sparrow-captain', 'alias', 'real-one']);
      expect(r.warnings).toEqual([`skill "escape" resolves outside the library (${realpathSync(out)}); not granted`]);
    }
  });

  test('no skills → only Sparrow\'s; withSparrow dedupes and locks the two', () => {
    expect(resolveGrants(undefined).grants).toEqual(sparrowSkills());
    expect(resolveGrants([]).warnings).toEqual([]);
    const g = withSparrow([{ name: 'x', path: '/x' }, { name: 'sparrow-worker', path: '/evil' }, { name: 'x', path: '/y' }]);
    expect(g.map((e) => `${e.name}=${e.path}`)).toEqual([
      `sparrow-worker=${join(ASSETS, 'skills', 'sparrow-worker')}`, `sparrow-captain=${join(ASSETS, 'skills', 'sparrow-captain')}`, 'x=/x',
    ]);
    expect(withSparrow(undefined)).toEqual(sparrowSkills());
  });
});

describe('snapshot', () => {
  test('write/read round trip; grantsFor prefers the snapshot, falls back to the resume', () => {
    const home = tmp('home'), lib = tmp('lib');
    skill(lib, 'alpha');
    skill(lib, 'beta');
    withEnv({ SPARROW_HOME: home, SPARROW_SKILLS_DIR: lib }, () => {
      expect(readSnapshot('ag_x')).toBeNull();
      expect(grantsFor('ag_x', ['beta']).map((g) => g.name)).toEqual(['sparrow-worker', 'sparrow-captain', 'beta']); // no snapshot: from the resume
      writeSnapshot('ag_x', resolveGrants(['alpha']));
      expect(readSnapshot('ag_x')!.grants.map((g) => g.name)).toEqual(['sparrow-worker', 'sparrow-captain', 'alpha']);
      expect(grantsFor('ag_x', ['beta']).map((g) => g.name)).toEqual(['sparrow-worker', 'sparrow-captain', 'alpha']); // snapshot wins
      writeFileSync(join(home, 'agents', 'ag_x', 'skills.json'), '{not json');
      expect(readSnapshot('ag_x')).toBeNull();
    });
  });
});

describe('a skill missing at hire', () => {
  test('is granted at a later call once it is in the library; resume edits still wait for Apply', () => {
    const home = tmp('home'), lib = tmp('lib');
    skill(lib, 'alpha');
    withEnv({ SPARROW_HOME: home, SPARROW_SKILLS_DIR: lib }, () => {
      const atHire = resolveGrants(['alpha', 'pdf-tools']);
      expect(atHire.warnings.join(' ')).toContain('pdf-tools');
      writeSnapshot('ag_late', atHire);
      expect(grantsFor('ag_late', ['alpha', 'pdf-tools']).map((g) => g.name)).toEqual(['sparrow-worker', 'sparrow-captain', 'alpha']);
      skill(lib, 'pdf-tools'); // imported after the hire
      skill(lib, 'gamma');     // added to the resume after the hire (an edit: not granted until Apply)
      expect(grantsFor('ag_late', ['alpha', 'pdf-tools', 'gamma']).map((g) => g.name))
        .toEqual(['sparrow-worker', 'sparrow-captain', 'alpha', 'pdf-tools']);
    });
  });
});

describe('materializeLinks', () => {
  test('links the grants, removes stale symlinks, never touches real entries, skips folders without SKILL.md', () => {
    const lib = tmp('lib'), dir = join(tmp('agent'), 'skills');
    const a = skill(lib, 'alpha'), b = skill(lib, 'beta');
    const empty = join(lib, 'empty'); mkdirSync(empty);
    expect(materializeLinks(dir, [{ name: 'alpha', path: a }, { name: 'beta', path: b }, { name: 'empty', path: empty }])).toEqual(['alpha', 'beta']);
    expect(readlinkSync(join(dir, 'alpha'))).toBe(a);
    mkdirSync(join(dir, '.system')); // a real folder Codex made
    writeFileSync(join(dir, 'stray.txt'), 'x');
    symlinkSync(b, join(dir, 'stale')); // stale link
    expect(materializeLinks(dir, [{ name: 'alpha', path: a }])).toEqual(['alpha']);
    expect(readdirSync(dir).sort()).toEqual(['.system', 'alpha', 'stray.txt']);
    // a link pointing at a different target is repointed
    const a2 = skill(tmp('lib2'), 'alpha');
    materializeLinks(dir, [{ name: 'alpha', path: a2 }]);
    expect(readlinkSync(join(dir, 'alpha'))).toBe(a2);
    // a real folder under a granted name is kept and not replaced
    mkdirSync(join(dir, 'beta'));
    materializeLinks(dir, [{ name: 'beta', path: b }]);
    expect(lstatSync(join(dir, 'beta')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dir, 'alpha'))).toBe(false); // alpha no longer granted → its link went
  });

  test('usableGrants drops grants whose folder lost its SKILL.md', () => {
    const lib = tmp('lib');
    const a = skill(lib, 'alpha');
    expect(usableGrants([{ name: 'alpha', path: a }, { name: 'gone', path: join(lib, 'gone') }]).map((g) => g.name)).toEqual(['alpha']);
  });
});

describe('frontmatterName', () => {
  test('reads name: (not the folder); quoted, and falls back to the folder name', () => {
    const lib = tmp('lib');
    expect(frontmatterName(skill(lib, 'mattpocock-handoff', 'handoff'), 'mattpocock-handoff')).toBe('handoff');
    const q = join(lib, 'q'); mkdirSync(q);
    writeFileSync(join(q, 'SKILL.md'), '---\nname: "quoted-one"\ndescription: x\n---\n');
    expect(frontmatterName(q, 'q')).toBe('quoted-one');
    expect(frontmatterName(join(lib, 'missing'), 'fallback')).toBe('fallback');
  });
});
