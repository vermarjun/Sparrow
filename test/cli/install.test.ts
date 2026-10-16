// `sparrow install` with a temp HOME + SPARROW_HOME: never touches the real home.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, REPO, run, tempDir } from './helpers';

function env(home: string, extraPath = true) {
  return {
    HOME: home,
    SPARROW_HOME: join(home, '.sparrow'),
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: (extraPath ? join(home, '.local', 'bin') + ':' : '') + process.env.PATH,
    SPARROW_SKIP_WEB_BUILD: '1', // never build the real UI in unit tests
  };
}

describe('sparrow install', () => {
  test('never resurrects a tombstoned built-in, including with --force', async () => {
    const home = tempDir();
    const deleted = join(home, '.sparrow/resumes/.deleted');
    mkdirSync(deleted, { recursive: true });
    writeFileSync(join(deleted, 'builder'), 'deleted');
    for (const args of [['install'], ['install', '--force']]) {
      const r = await run(args, { env: env(home) });
      expect(r.code).toBe(0);
      expect(existsSync(join(home, '.sparrow/resumes/builder.md'))).toBe(false);
      expect(existsSync(join(deleted, 'builder'))).toBe(true);
    }
  }, 120_000);
  test('lands files, is idempotent, never overwrites edits, even with --force', async () => {
    const home = tempDir('sparrow-t3-home-');
    const r1 = await run(['install'], { env: env(home), cwd: home });
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain('Sparrow install');

    // 1. resumes
    const resumes = readdirSync(join(home, '.sparrow', 'resumes')).sort();
    expect(resumes).toEqual(['builder-codex.md', 'builder.md', 'presenter.md', 'researcher.md', 'sub-captain.md', 'verifier.md']);
    expect(existsSync(join(home, '.sparrow', 'agents'))).toBe(true);
    expect(r1.stdout).toContain('seeded builder-codex, builder, presenter, researcher, sub-captain, verifier');

    // 2. link
    const link = join(home, '.local', 'bin', 'sparrow');
    expect(readlinkSync(link)).toBe(BIN);

    // 3. skills: Claude (+ OpenCode reads ~/.claude/skills) and Codex
    for (const dir of ['.claude/skills', '.codex/skills']) {
      for (const s of ['sparrow-captain', 'sparrow-worker']) {
        const f = join(home, dir, s, 'SKILL.md');
        expect(readFileSync(f, 'utf8')).toBe(readFileSync(join(REPO, 'assets', 'skills', s, 'SKILL.md'), 'utf8'));
      }
    }
    expect(r1.stdout).not.toContain('is not on your PATH');
    const plugin = join(home, '.sparrow', 'claude-plugin');
    expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('sparrow');
    expect(readFileSync(join(plugin, 'skills/sparrow-worker/SKILL.md'), 'utf8')).toContain('Sparrow worker');

    // second run: nothing changes
    const r2 = await run(['install'], { env: env(home), cwd: home });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('6 up to date');
    expect(r2.stdout).toContain('link up to date');
    expect(r2.stdout).toMatch(/skills sparrow-captain, sparrow-worker → ~\/\.claude\/skills \(Claude Code \+ OpenCode\) — up to date/);

    // user edit is kept; --force overwrites it
    const builder = join(home, '.sparrow', 'resumes', 'builder.md');
    writeFileSync(builder, 'my edit');
    const r3 = await run(['install'], { env: env(home), cwd: home });
    expect(readFileSync(builder, 'utf8')).toBe('my edit');
    expect(r3.stdout).toContain('kept your edited resumes: builder');
    const r4 = await run(['install', '--force'], { env: env(home), cwd: home });
    expect(r4.code).toBe(0);
    expect(readFileSync(builder, 'utf8')).toBe('my edit');
    expect(r4.stdout).toContain('kept your edited resumes: builder');
  }, 120_000);

  test('warns when ~/.local/bin is not on PATH and leaves a foreign file alone', async () => {
    const home = tempDir('sparrow-t3-home-');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'sparrow'), '#!/bin/sh\necho mine\n');
    const r = await run(['install'], { env: env(home, false), cwd: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('is not on your PATH');
    expect(r.stdout).toContain('exists and is not our symlink; left alone');
    expect(readFileSync(join(home, '.local', 'bin', 'sparrow'), 'utf8')).toContain('echo mine');
  }, 120_000);

  test('replaces a stale symlink from an old checkout', async () => {
    const home = tempDir('sparrow-t3-home-');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync('/old/checkout/bin/sparrow', join(home, '.local', 'bin', 'sparrow'));
    const r = await run(['install'], { env: env(home), cwd: home });
    expect(r.code).toBe(0);
    expect(readlinkSync(join(home, '.local', 'bin', 'sparrow'))).toBe(BIN);
    expect(r.stdout).toContain('relinked');
  }, 120_000);

  test('web UI: builds when dist is missing (stub package), reports up to date, --force rebuilds, skip env honoured', async () => {
    const home = tempDir('sparrow-t3-home-');
    const web = join(home, 'web');
    mkdirSync(web);
    // a stub web package: no deps; its build writes dist/index.html
    writeFileSync(join(web, 'package.json'), JSON.stringify({
      name: 'stub-web', private: true, scripts: { build: "mkdir -p dist && echo '<html>stub</html>' > dist/index.html" },
    }));
    const e = { ...env(home), SPARROW_WEB_DIR: web };

    let r = await run(['install'], { env: e, cwd: home });
    expect(r.stdout).toContain('web UI: build needed (web/dist missing) — skipped (SPARROW_SKIP_WEB_BUILD=1)');
    expect(existsSync(join(web, 'dist', 'index.html'))).toBe(false);

    r = await run(['install'], { env: { ...e, SPARROW_SKIP_WEB_BUILD: undefined }, cwd: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✓ web UI: built web\/dist \(web\/dist missing; \d+s\)/);
    expect(readFileSync(join(web, 'dist', 'index.html'), 'utf8')).toContain('stub');

    r = await run(['install'], { env: e, cwd: home });
    expect(r.stdout).toContain('✓ web UI: already built (web/dist)');
    r = await run(['install', '--force'], { env: e, cwd: home });
    expect(r.stdout).toContain('web UI: build needed (rebuild (--force)) — skipped');
  }, 120_000);

  test('web UI: a failing build is a warning, not a crash', async () => {
    const home = tempDir('sparrow-t3-home-');
    const web = join(home, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'stub-web', private: true, scripts: { build: 'echo boom >&2; exit 3' } }));
    const r = await run(['install'], { env: { ...env(home), SPARROW_WEB_DIR: web, SPARROW_SKIP_WEB_BUILD: undefined }, cwd: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/! web UI: `bun run build` failed in .* \(exit 3\): .*boom/);
  }, 120_000);
});

describe('sparrow install: foreign symlink (Risk 4)', () => {
  test('a symlink that is not a sparrow checkout is left alone without --force', async () => {
    const home = tempDir('sparrow-t3-home-');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const link = join(home, '.local', 'bin', 'sparrow');
    symlinkSync('/usr/local/bin/my-sparrow-wrapper', link);
    const e = { HOME: home, SPARROW_HOME: join(home, '.sparrow'), PATH: join(home, '.local', 'bin') + ':' + process.env.PATH, SPARROW_SKIP_WEB_BUILD: '1' };
    let r = await run(['install'], { env: e, cwd: home });
    expect(r.code).toBe(0);
    expect(readlinkSync(link)).toBe('/usr/local/bin/my-sparrow-wrapper');
    expect(r.stdout).toContain('exists and is not our symlink; left alone');
    r = await run(['install', '--force'], { env: e, cwd: home });
    expect(readlinkSync(link)).toBe(BIN);
  }, 120_000);
});
