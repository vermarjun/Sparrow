import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { commit, ensureLibrary, log, push, status } from '../../src/skills/git';
import { skillsCheck } from '../../src/server/doctor';
import { writeManifest } from '../../src/skills/manifest';
import { makeSkill, sandbox } from './helpers';

test('library git helpers initialize idempotently, report dirty state, commit, and refuse push without origin', async () => {
  const { paths } = sandbox();
  ensureLibrary(paths);
  ensureLibrary(paths);
  expect(status(paths).available).toBe(true);
  writeFileSync(join(paths.library, 'notes.txt'), 'library note\n');
  expect(status(paths).dirty).toContain('notes.txt');
  const old = {
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    committerName: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  };
  process.env.GIT_AUTHOR_NAME = 'Skills Test';
  process.env.GIT_AUTHOR_EMAIL = 'skills@example.invalid';
  process.env.GIT_COMMITTER_NAME = 'Skills Test';
  process.env.GIT_COMMITTER_EMAIL = 'skills@example.invalid';
  try {
    expect(commit('initial skills library', paths)).toContain('initial skills library');
    expect(status(paths).dirty).toEqual([]);
    expect(log(undefined, paths)[0]?.subject).toBe('initial skills library');
    await expect(push(paths)).rejects.toThrow('origin remote is not configured');
  } finally {
    if (old.authorName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = old.authorName;
    if (old.authorEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = old.authorEmail;
    if (old.committerName === undefined) delete process.env.GIT_COMMITTER_NAME; else process.env.GIT_COMMITTER_NAME = old.committerName;
    if (old.committerEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL; else process.env.GIT_COMMITTER_EMAIL = old.committerEmail;
  }
});

test('nested library initializes its own repository and git helpers never stage the parent tree', () => {
  const { home, paths } = sandbox();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'private-notes.txt'), 'keep outside the library\n');
  const init = Bun.spawnSync(['git', '-C', home, 'init'], { stdout: 'pipe', stderr: 'pipe' });
  expect(init.exitCode).toBe(0);
  mkdirSync(paths.library, { recursive: true });
  const parentBefore = Bun.spawnSync(['git', '-C', home, 'status', '--porcelain'], { stdout: 'pipe' }).stdout.toString();

  expect(status(paths).available).toBe(false);
  expect(() => commit('must refuse parent repo', paths)).toThrow('not a git repository rooted');
  ensureLibrary(paths);
  const top = Bun.spawnSync(['git', '-C', paths.library, 'rev-parse', '--show-toplevel'], { stdout: 'pipe' });
  expect(top.stdout.toString().trim()).toBe(paths.library);

  const old = [process.env.GIT_AUTHOR_NAME, process.env.GIT_AUTHOR_EMAIL, process.env.GIT_COMMITTER_NAME, process.env.GIT_COMMITTER_EMAIL];
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Nested Skills Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'nested-skills@example.invalid';
  try { commit('library only', paths); }
  finally {
    for (const [key, value] of [['GIT_AUTHOR_NAME', old[0]], ['GIT_AUTHOR_EMAIL', old[1]], ['GIT_COMMITTER_NAME', old[2]], ['GIT_COMMITTER_EMAIL', old[3]]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const parentAfter = Bun.spawnSync(['git', '-C', home, 'status', '--porcelain'], { stdout: 'pipe' }).stdout.toString();
  expect(parentBefore).toContain('private-notes.txt');
  expect(parentAfter).toContain('private-notes.txt');
  expect(Bun.spawnSync(['git', '-C', home, 'diff', '--cached', '--name-only'], { stdout: 'pipe' }).stdout.toString()).toBe('');
  expect(readFileSync(join(home, 'private-notes.txt'), 'utf8')).toBe('keep outside the library\n');
  expect(status(paths).dirty).toEqual([]);
});

test('ensureLibrary refuses dangling metadata symlinks without writing through them', () => {
  const first = sandbox();
  mkdirSync(first.paths.library, { recursive: true });
  const outsideIgnore = join(first.root, 'outside-ignore');
  symlinkSync(outsideIgnore, join(first.paths.library, '.gitignore'));
  expect(() => ensureLibrary(first.paths)).toThrow('symlinked skills library metadata');
  expect(existsSync(outsideIgnore)).toBe(false);
  expect(lstatSync(join(first.paths.library, '.gitignore')).isSymbolicLink()).toBe(true);

  const second = sandbox();
  mkdirSync(second.paths.library, { recursive: true });
  writeFileSync(join(second.paths.library, '.gitignore'), '.DS_Store\n');
  const outsideManifest = join(second.root, 'outside-manifest');
  symlinkSync(outsideManifest, join(second.paths.library, 'skills.json'));
  expect(() => ensureLibrary(second.paths)).toThrow('symlinked skills library metadata');
  expect(existsSync(outsideManifest)).toBe(false);
  expect(lstatSync(join(second.paths.library, 'skills.json')).isSymbolicLink()).toBe(true);
});

test('Doctor skills check uses the sandbox path resolver and warns about missing links and library git state', async () => {
  const { paths } = sandbox();
  mkdirSync(paths.roots.claude, { recursive: true });
  mkdirSync(paths.roots.codex, { recursive: true });
  for (const name of ['sparrow-captain', 'sparrow-worker']) {
    cpSync(join(paths.roots.sparrow, name), join(paths.roots.claude, name), { recursive: true });
    cpSync(join(paths.roots.sparrow, name), join(paths.roots.codex, name), { recursive: true });
  }
  ensureLibrary(paths);
  makeSkill(join(paths.library, 'managed'), 'managed');
  writeManifest({ version: 1, skills: { managed: { harnesses: ['claude'] } } }, paths.library, paths);
  const result = await skillsCheck(paths);
  expect(result.status).toBe('warn');
  expect(result.detail).toContain('Missing managed link claude/managed');
  expect(result.detail).toContain('uncommitted files');
  expect(result.detail).toContain('no origin remote');
  expect(result.fix).toContain('Skills page');
  expect(result.fix).not.toContain('sparrow install');
});

test('Doctor fails on broken managed links and managed conflicts', async () => {
  const { paths, home } = sandbox();
  ensureLibrary(paths);
  makeSkill(join(paths.library, 'conflicting'), 'conflicting');
  makeSkill(join(paths.library, 'broken-managed'), 'broken-managed');
  makeSkill(join(paths.roots.claude, 'conflicting'), 'conflicting', 'Different harness copy.\n');
  mkdirSync(paths.roots.claude, { recursive: true });
  symlinkSync(join(home, 'missing-managed-target'), join(paths.roots.claude, 'broken-managed'), 'dir');
  writeManifest({ version: 1, skills: {
    conflicting: { harnesses: ['claude'] },
    'broken-managed': { harnesses: ['claude'] },
  } }, paths.library, paths);

  const result = await skillsCheck(paths);
  expect(result.status).toBe('fail');
  expect(result.detail).toContain('Managed Conflict claude/conflicting');
  expect(result.detail).toContain('Managed Broken link claude/broken-managed');
  expect(result.fix).toContain('Skills page');
});

test('Doctor surfaces library skills missing from skills.json and treats no remote as informational', async () => {
  const { paths } = sandbox();
  ensureLibrary(paths);
  for (const root of [paths.roots.claude, paths.roots.codex]) {
    mkdirSync(root, { recursive: true });
    for (const name of ['sparrow-captain', 'sparrow-worker']) cpSync(join(paths.roots.sparrow, name), join(root, name), { recursive: true });
  }
  const config = Bun.spawnSync(['git', '-C', paths.library, 'config', 'user.name', 'Skills Test'], { stdout: 'pipe', stderr: 'pipe' });
  expect(config.exitCode).toBe(0);
  Bun.spawnSync(['git', '-C', paths.library, 'config', 'user.email', 'skills@example.invalid']);
  commit('clean library', paths);
  const localOnly = await skillsCheck(paths);
  expect(localOnly.status).toBe('pass');
  expect(localOnly.detail).toContain('no origin remote');

  makeSkill(join(paths.library, 'not-registered'), 'not-registered');
  const missingManifest = await skillsCheck(paths);
  expect(missingManifest.detail).toContain('Library skill is missing from skills.json: not-registered');
  expect(missingManifest.status).toBe('warn');
});

test('push to an origin that never answers is async and times out instead of freezing the server', async () => {
  const { paths } = sandbox();
  ensureLibrary(paths);
  makeSkill(join(paths.library, 'net-probe'), 'net-probe');
  for (const kv of [['user.email', 'skills-test@example.invalid'], ['user.name', 'Skills Test']]) {
    Bun.spawnSync(['git', '-C', paths.library, 'config', ...kv]);
  }
  commit('net probe', paths);
  // A TCP listener that accepts and never replies: git's http transport hangs on it.
  const hole = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  Bun.spawnSync(['git', '-C', paths.library, 'remote', 'add', 'origin', `http://127.0.0.1:${hole.port}/x.git`]);
  const previous = process.env.SPARROW_GIT_TIMEOUT_MS;
  process.env.SPARROW_GIT_TIMEOUT_MS = '1500';
  try {
    let ticked = false;
    const pending = push(paths);
    await Bun.sleep(50).then(() => { ticked = true; }); // the event loop keeps running while git waits
    expect(ticked).toBe(true);
    await expect(pending).rejects.toThrow('timed out');
  } finally {
    if (previous === undefined) delete process.env.SPARROW_GIT_TIMEOUT_MS; else process.env.SPARROW_GIT_TIMEOUT_MS = previous;
    hole.stop(true);
  }
}, 15_000);
