// Resume seeding record, install record / upgrade detection, readiness helpers, uninstall.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { needsSetup, readInstallRecord, seededFile, seedResumes } from '../../src/cli/install';
import { loginFound, resumeHarnesses } from '../../src/cli/setup';
import { tmuxInstallHint } from '../../src/shared/hints';
import { freePort, run, tempDir } from '../cli/helpers';

const ALL = { claude: true, codex: true, opencode: true };
const resume = (name: string, harness = 'claude', body = 'body') => `---\nname: ${name}\ntitle: ${name}\nharness: ${harness}\ncan_hire: []\n---\n${body}\n`;

function dirs(files: Record<string, string>) {
  const root = tempDir('seed-');
  const src = join(root, 'assets'); const dst = join(root, 'resumes');
  mkdirSync(src); mkdirSync(dst);
  for (const [f, t] of Object.entries(files)) writeFileSync(join(src, f), t);
  return { src, dst, set: (f: string, t: string) => writeFileSync(join(src, f), t) };
}
const record = (dst: string) => JSON.parse(readFileSync(seededFile(dst), 'utf8'));

describe('seedResumes + seeded-resumes.json', () => {
  test('seeds missing resumes and records the sha of what it wrote', () => {
    const d = dirs({ 'a.md': resume('a'), 'b.md': resume('b') });
    const r = seedResumes(d.src, d.dst, ALL);
    expect(r.seeded).toEqual(['a', 'b']);
    expect(Object.keys(record(d.dst).resumes)).toEqual(['a', 'b']);
    expect(record(d.dst).resumes.a.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(record(d.dst).resumes.a.fallback).toBeUndefined();
    const again = seedResumes(d.src, d.dst, ALL);
    expect(again).toMatchObject({ seeded: [], updated: [], kept: [], same: 2 });
  });

  test('a newer shipped version updates a resume the user never edited', () => {
    const d = dirs({ 'a.md': resume('a', 'claude', 'v1') });
    seedResumes(d.src, d.dst, ALL);
    d.set('a.md', resume('a', 'claude', 'v2'));
    const r = seedResumes(d.src, d.dst, ALL);
    expect(r.updated).toEqual(['a']);
    expect(readFileSync(join(d.dst, 'a.md'), 'utf8')).toContain('v2');
  });

  test('a user-edited resume is kept, before and after a newer shipped version', () => {
    const d = dirs({ 'a.md': resume('a', 'claude', 'v1') });
    seedResumes(d.src, d.dst, ALL);
    writeFileSync(join(d.dst, 'a.md'), 'my edit');
    expect(seedResumes(d.src, d.dst, ALL).kept).toEqual(['a']);
    d.set('a.md', resume('a', 'claude', 'v2'));
    const r = seedResumes(d.src, d.dst, ALL);
    expect(r).toMatchObject({ kept: ['a'], updated: [] });
    expect(readFileSync(join(d.dst, 'a.md'), 'utf8')).toBe('my edit');
  });

  test('an existing file with no record that differs from the shipped one counts as edited; one that matches is adopted', () => {
    const d = dirs({ 'a.md': resume('a'), 'b.md': resume('b') });
    writeFileSync(join(d.dst, 'a.md'), 'older version or hand edit');
    writeFileSync(join(d.dst, 'b.md'), resume('b'));
    const r = seedResumes(d.src, d.dst, ALL);
    expect(r).toMatchObject({ kept: ['a'], same: 1, seeded: [] });
    expect(Object.keys(record(d.dst).resumes)).toEqual(['b']);
  });

  test('a fallback-seeded resume stays on the fallback harness once the missing one is installed; a newer shipped text re-applies the fallback', () => {
    const d = dirs({ 'v.md': resume('v', 'codex', 'v1') });
    const noCodex = { claude: true, codex: false, opencode: false };
    const first = seedResumes(d.src, d.dst, noCodex);
    expect(first.seeded).toEqual(['v']);
    expect(first.notes[0]).toContain('codex not installed');
    expect(readFileSync(join(d.dst, 'v.md'), 'utf8')).toContain('harness: claude');
    expect(record(d.dst).resumes.v.fallback).toBe(true);
    // codex arrives: the unedited fallback copy is left alone
    const later = seedResumes(d.src, d.dst, ALL);
    expect(later).toMatchObject({ seeded: [], updated: [], kept: [], same: 1 });
    expect(readFileSync(join(d.dst, 'v.md'), 'utf8')).toContain('harness: claude');
    // a new Sparrow ships a changed resume: it is rewritten, now for the harness that exists
    d.set('v.md', resume('v', 'codex', 'v2'));
    expect(seedResumes(d.src, d.dst, ALL).updated).toEqual(['v']);
    expect(readFileSync(join(d.dst, 'v.md'), 'utf8')).toContain('harness: codex');
    // reseed by hand: delete the file, install again
    rmSync(join(d.dst, 'v.md'));
    expect(seedResumes(d.src, d.dst, noCodex).seeded).toEqual(['v']);
  });

  test('a tombstoned resume is never recreated', () => {
    const d = dirs({ 'a.md': resume('a') });
    mkdirSync(join(d.dst, '.deleted'));
    writeFileSync(join(d.dst, '.deleted', 'a'), 'x');
    const r = seedResumes(d.src, d.dst, ALL);
    expect(r.seeded).toEqual([]);
    expect(existsSync(join(d.dst, 'a.md'))).toBe(false);
  });

  test('resumeHarnesses reads the front matter harness (default claude)', () => {
    const d = dirs({});
    writeFileSync(join(d.dst, 'x.md'), resume('x', 'codex'));
    writeFileSync(join(d.dst, 'y.md'), '---\nname: y\n---\nbody');
    expect(resumeHarnesses(d.dst)).toEqual({ x: 'codex', y: 'claude' });
  });
});

describe('install record / upgrade detection', () => {
  test('first run, version change and binary move all need setup; the same install does not', () => {
    expect(needsSetup(null, '1.0.0', '/b/sparrow')).toBe(true);
    const rec = { version: '1.0.0', bin: '/b/sparrow', at: 1 };
    expect(needsSetup(rec, '1.0.0', '/b/sparrow')).toBe(false);
    expect(needsSetup(rec, '1.1.0', '/b/sparrow')).toBe(true);
    expect(needsSetup(rec, '1.0.0', '/c/sparrow')).toBe(true);
  });
  test('readInstallRecord tolerates a missing or corrupt file', () => {
    const dir = tempDir('rec-');
    expect(readInstallRecord(join(dir, 'none.json'))).toBeNull();
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(readInstallRecord(join(dir, 'bad.json'))).toBeNull();
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ version: '1.0.0', bin: '/b', at: 1 }));
    expect(readInstallRecord(join(dir, 'ok.json'))?.version).toBe('1.0.0');
  });
});

describe('readiness helpers', () => {
  test('loginFound: codex auth.json / OPENAI_API_KEY; opencode auth.json; claude env token', () => {
    const home = tempDir('login-');
    const env = { HOME: home, CODEX_HOME: join(home, '.codex'), XDG_DATA_HOME: join(home, 'share') } as NodeJS.ProcessEnv;
    expect(loginFound('codex', env, home)).toBe(false);
    mkdirSync(join(home, '.codex')); writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    expect(loginFound('codex', env, home)).toBe(true);
    expect(loginFound('opencode', env, home)).toBe(false);
    mkdirSync(join(home, 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, 'share', 'opencode', 'auth.json'), '{"opencode-go":{"type":"api","key":"x"}}');
    expect(loginFound('opencode', env, home)).toBe(true);
    expect(loginFound('claude', { ...env, ANTHROPIC_API_KEY: 'k' }, home)).toBe(true);
  });
  test('tmux install hint per OS / package manager', () => {
    expect(tmuxInstallHint('darwin', () => false)).toBe('brew install tmux');
    expect(tmuxInstallHint('linux', (b) => b === 'apt-get')).toBe('sudo apt install tmux');
    expect(tmuxInstallHint('linux', (b) => b === 'dnf')).toBe('sudo dnf install tmux');
    expect(tmuxInstallHint('linux', (b) => b === 'pacman')).toBe('sudo pacman -S tmux');
  });
});

describe('sparrow uninstall (isolated HOME)', () => {
  test('removes what install wrote, keeps $SPARROW_HOME data, --purge removes it', async () => {
    const home = tempDir('un-');
    const env = { HOME: home, SPARROW_HOME: join(home, '.sparrow'), SPARROW_PORT: String(await freePort()), SPARROW_SKILLS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), SPARROW_SKIP_WEB_BUILD: '1' };
    expect((await run(['install'], { env, cwd: home })).code).toBe(0);
    expect(existsSync(join(home, '.claude/skills/sparrow-worker'))).toBe(true);
    expect(existsSync(join(home, '.local/bin/sparrow'))).toBe(true);
    const u = await run(['uninstall'], { env, cwd: home });
    expect(u.code).toBe(0);
    expect(existsSync(join(home, '.claude/skills/sparrow-worker'))).toBe(false);
    expect(existsSync(join(home, '.codex/skills/sparrow-captain'))).toBe(false);
    expect(existsSync(join(home, '.local/bin/sparrow'))).toBe(false);
    expect(existsSync(join(home, '.sparrow/claude-plugin'))).toBe(false);
    expect(existsSync(join(home, '.sparrow/resumes/builder.md'))).toBe(true);   // data stays
    expect(u.stdout).toContain('kept your data');
    const p = await run(['uninstall', '--purge'], { env, cwd: home });
    expect(p.code).toBe(0);
    expect(existsSync(join(home, '.sparrow'))).toBe(false);
  }, 60_000);

  test('install writes the seeded record next to the resumes', async () => {
    const home = tempDir('un-');
    const env = { HOME: home, SPARROW_HOME: join(home, '.sparrow'), SPARROW_SKILLS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), SPARROW_SKIP_WEB_BUILD: '1' };
    await run(['install'], { env, cwd: home });
    const rec = JSON.parse(readFileSync(seededFile(join(home, '.sparrow/resumes')), 'utf8'));
    expect(Object.keys(rec.resumes).length).toBeGreaterThanOrEqual(8);
  }, 60_000);
});
