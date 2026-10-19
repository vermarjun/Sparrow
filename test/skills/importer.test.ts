import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkUpdates, cleanupExpiredStaging, importStaged, libraryName, parseSource, previewSource, resolveTreePath,
  STAGED_IMPORT_TTL_MS,
} from '../../src/skills/importer';
import type { ParsedSource } from '../../src/skills/importer';
import { readManifest, writeManifest } from '../../src/skills/manifest';
import { folderHash } from '../../src/skills/hash';
import { createSkill } from '../../src/skills/create';
import { mountSkillAddRoutes } from '../../src/server/skills-add-routes';
import { skillPaths } from '../../src/skills/paths';

const valid = (name: string, description = 'Imported safely.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'skills-importer-'));
  const home = join(base, 'home');
  const paths = skillPaths({ HOME: home, SPARROW_SKILLS_HOME: home, SPARROW_HOME: join(home, '.sparrow') });
  return { base, home, paths };
}

function writeSkill(root: string, folder: string, name: string, body = valid(name)) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
  return dir;
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function initRepo(base: string) {
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'skills-test@example.invalid');
  git(repo, 'config', 'user.name', 'Skills Test');
  return repo;
}

function commitAll(repo: string, message: string) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
}

// Bare-repo fixtures are committed without their empty ref dirs (git does not track empty dirs), so use a temp copy
// with refs/heads and refs/tags recreated; a fresh clone of Sparrow then behaves like the tree they were made in.
function fixtureRepo(name: string) {
  const copy = join(mkdtempSync(join(tmpdir(), 'skills-fixture-')), name);
  cpSync(join(import.meta.dir, '../fixtures/skills/phase3/repos', name), copy, { recursive: true });
  for (const dir of ['refs/heads', 'refs/tags']) mkdirSync(join(copy, dir), { recursive: true });
  return copy;
}

async function withGitMirror<T>(repo: string, fn: (url: string) => Promise<T>, repoUrl = 'https://github.com/skills-test/repo.git') {
  const previous = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = `'protocol.file.allow=always' 'url.file://${repo}.insteadOf=${repoUrl}'`;
  try { return await fn(repoUrl); }
  finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = previous;
  }
}

test('parseSource accepts the supported shorthand, URL, ref, filter and local forms', () => {
  const env = { HOME: '/sandbox/home' } as NodeJS.ProcessEnv;
  const cases: { input: string; type: ParsedSource['type']; source?: string; ref?: string; subpath?: string; skillFilter?: string }[] = [
    { input: 'owner/repo', type: 'github', source: 'owner/repo' },
    { input: 'owner/repo.git', type: 'github', source: 'owner/repo' },
    { input: 'owner/repo/skills/alpha', type: 'github', source: 'owner/repo', subpath: 'skills/alpha' },
    { input: 'github:owner/repo', type: 'github', source: 'owner/repo' },
    { input: 'github:owner/repo/skills/alpha', type: 'github', source: 'owner/repo', subpath: 'skills/alpha' },
    { input: 'github.com/owner/repo', type: 'github', source: 'owner/repo' },
    { input: 'https://github.com/owner/repo.git', type: 'github', source: 'owner/repo' },
    { input: 'https://github.com/owner/repo/tree/main/skills/alpha', type: 'github', source: 'owner/repo' },
    { input: 'https://github.com/owner/repo/tree/feat/x/skills/alpha', type: 'github', source: 'owner/repo' },
    { input: 'https://gitlab.com/owner/repo', type: 'gitlab', source: 'https://gitlab.com/owner/repo' },
    { input: 'gitlab:owner/repo', type: 'gitlab', source: 'https://gitlab.com/owner/repo' },
    { input: 'https://gitlab.com/group/project/-/tree/main/skills/alpha', type: 'gitlab', source: 'https://gitlab.com/group/project', subpath: undefined },
    { input: 'https://example.test/owner/repo.git', type: 'git', source: 'https://example.test/owner/repo.git' },
    { input: 'ssh://git@example.test/owner/repo.git', type: 'git', source: 'example.test/owner/repo' },
    { input: 'git@example.test:owner/repo.git', type: 'git', source: 'owner/repo' },
    { input: 'git://example.test/owner/repo.git', type: 'git', source: 'git://example.test/owner/repo.git' },
    { input: '~/skills', type: 'local', source: '/sandbox/home/skills' },
    { input: '~', type: 'local', source: '/sandbox/home' },
    { input: './skills', type: 'local' },
    { input: '../skills', type: 'local' },
    { input: '/var/tmp/skills', type: 'local', source: '/var/tmp/skills' },
    { input: 'owner/repo#main', type: 'github', source: 'owner/repo', ref: 'main' },
    { input: 'owner/repo#main@alpha', type: 'github', source: 'owner/repo', ref: 'main', skillFilter: 'alpha' },
    { input: 'https://github.com/owner/repo#main@alpha', type: 'github', source: 'owner/repo', ref: 'main', skillFilter: 'alpha' },
    { input: 'owner/repo@alpha', type: 'github', source: 'owner/repo', skillFilter: 'alpha' },
    { input: 'owner/repo/skills#main@alpha', type: 'github', source: 'owner/repo', subpath: 'skills', ref: 'main', skillFilter: 'alpha' },
    { input: 'coinbase/agentWallet', type: 'github', source: 'coinbase/agentic-wallet-skills' },
    { input: 'vercel-labs/vercel-skills', type: 'github', source: 'vercel-labs/agent-skills' },
  ];
  expect(cases.length).toBeGreaterThanOrEqual(20);
  for (const expected of cases) {
    const parsed = parseSource(expected.input, env);
    expect(parsed.type).toBe(expected.type);
    if (expected.source) expect(parsed.source).toBe(expected.source);
    if (expected.ref !== undefined) expect(parsed.ref).toBe(expected.ref);
    if (expected.subpath !== undefined) expect(parsed.subpath).toBe(expected.subpath);
    if (expected.skillFilter !== undefined) expect(parsed.skillFilter).toBe(expected.skillFilter);
  }
  expect(() => parseSource('')).toThrow(/non-empty/);
  expect(() => parseSource('file:///tmp/skills.git')).toThrow(/file:\/\/ sources are not supported/);
  expect(() => parseSource('fd::17/x')).toThrow(/ext and fd transports are not supported/);
  expect(() => parseSource('https://example.test/not-a-git-repo')).toThrow(/Unsupported source URL/);
  expect(() => parseSource('owner/repo/%2e%2e/escape')).toThrow(/Unsafe source subpath/);
});

test('resolves the longest Git ref in tree URLs and rejects ambiguous paths with no matching ref', () => {
  const refs = [
    '1111111111111111111111111111111111111111\trefs/heads/feat',
    '2222222222222222222222222222222222222222\trefs/heads/feat/x',
    '3333333333333333333333333333333333333333\trefs/tags/v1.0',
  ].join('\n');
  expect(resolveTreePath('feat/x/skills/alpha', refs)).toEqual({ ref: 'feat/x', subpath: 'skills/alpha' });
  expect(resolveTreePath('v1.0', refs)).toEqual({ ref: 'v1.0' });
  expect(() => resolveTreePath('missing/skills/alpha', refs)).toThrow(/Could not resolve a Git ref/);
});

test('Git discovery contains every path inside the clone and reports symlinks instead of following them', async () => {
  const { base, paths } = sandbox();
  try {
    const evil = fixtureRepo('evil.git');
    const evilWorktree = join(base, 'evil-worktree');
    git(base, 'clone', evil, evilWorktree);
    git(evilWorktree, 'config', 'user.email', 'skills-test@example.invalid');
    git(evilWorktree, 'config', 'user.name', 'Skills Test');
    const executionMarker = join(base, 'evil-script-ran');
    const fixtureScript = join(evilWorktree, 'skills/ok-skill/scripts/run.sh');
    writeFileSync(fixtureScript, `#!/bin/sh\ntouch '${executionMarker}'\n`);
    chmodSync(fixtureScript, 0o755);
    commitAll(evilWorktree, 'point the malicious executable fixture at the sandbox marker');
    git(evilWorktree, 'push', 'origin', git(evilWorktree, 'branch', '--show-current'));
    await withGitMirror(evil, async () => {
      const explicit = await previewSource('evil/repo/skills/leak-skill', paths, process.env, 3_000);
      expect(explicit.skills).toEqual([]);
      expect(explicit.problems?.some((problem) => /symlink/.test(problem.code))).toBe(true);

      const rootLink = await previewSource('https://github.com/evil/repo/tree/main/evil-link', paths, process.env, 3_000);
      expect(rootLink.skills).toEqual([]);
      expect(rootLink.problems?.some((problem) => /symlink/.test(problem.code))).toBe(true);

      const plain = await previewSource('evil/repo', paths, process.env, 3_000);
      expect(plain.skills.map((skill) => skill.name)).toEqual(['ok-skill', 'other-skill']);
      expect(plain.problems?.some((problem) => /symlink/.test(problem.code))).toBe(true);
      expect(plain.skills.some((skill) => skill.name === 'leak-skill')).toBe(false);
      expect(plain.skills.find((skill) => skill.name === 'ok-skill')?.scriptDetails).toContainEqual(
        { path: 'scripts/run.sh', executable: true, shebang: '#!/bin/sh', scriptsDirectory: true },
      );
      await importStaged(plain.id, ['ok-skill'], [], paths);
      expect(statSync(join(paths.library, 'ok-skill/scripts/run.sh')).mode & 0o777).toBe(0o755);
      expect(existsSync(executionMarker)).toBe(false);
    }, 'https://github.com/evil/repo.git');

    await withGitMirror(fixtureRepo('upd2.git'), async () => {
      const containerLink = await previewSource('upd2/repo', paths, process.env, 3_000);
      expect(containerLink.skills).toEqual([]);
      expect(containerLink.problems?.some((problem) => /symlink/.test(problem.code))).toBe(true);
    }, 'https://github.com/upd2/repo.git');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('local preview discovers supported skill roots, reports scripts and ignores excluded directories', async () => {
  const { base, paths } = sandbox();
  try {
    const source = join(base, 'source');
    writeSkill(source, 'skills/normal', 'normal');
    writeSkill(source, 'skills/.curated/curated', 'curated');
    writeSkill(source, 'skills/.experimental/experimental', 'experimental');
    writeSkill(source, 'skills/.system/system', 'system');
    writeSkill(source, '.agents/skills/agent-skill', 'agent-skill');
    writeSkill(source, 'node_modules/ignored', 'ignored');
    writeSkill(source, '.git/ignored', 'git-ignored');
    mkdirSync(join(source, 'skills/normal/scripts'), { recursive: true });
    writeFileSync(join(source, 'skills/normal/scripts/run.sh'), '#!/bin/sh\necho ok\n');
    writeFileSync(join(source, 'skills/normal/readme'), 'data');

    const staged = await previewSource(source, paths);
    expect(staged.skills.map((skill) => skill.name).sort()).toEqual(['agent-skill', 'curated', 'experimental', 'normal', 'system']);
    expect(staged.skills.find((skill) => skill.name === 'normal')?.scripts).toEqual(['scripts/run.sh']);
    expect(staged.skills.find((skill) => skill.name === 'normal')?.files.map((file) => file.path)).toEqual([
      'readme', 'scripts/run.sh', 'SKILL.md',
    ]);
    expect(staged.source?.sourceType).toBe('local');
    expect(existsSync(join(paths.sparrowHome, 'skills-staging', 'import-' + staged.id, 'stage.json'))).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('local symlink roots resolve, while an in-skill symlink marks only that skill invalid', async () => {
  const { base, paths } = sandbox();
  try {
    const source = join(base, 'source');
    writeSkill(source, 'skills/safe-skill', 'safe-skill');
    const unsafe = writeSkill(source, 'skills/unsafe-skill', 'unsafe-skill');
    const secret = join(base, 'secret.txt');
    writeFileSync(secret, 'outside');
    symlinkSync(secret, join(unsafe, 'external.txt'));
    const staged = await previewSource(source, paths);
    expect(staged.skills.map((skill) => skill.name)).toEqual(['safe-skill', 'unsafe-skill']);
    expect(staged.skills.find((skill) => skill.name === 'unsafe-skill')?.problems).toEqual([
      expect.objectContaining({ code: 'symlink-entry', message: expect.stringContaining('external.txt') }),
    ]);
    expect(staged.skills.find((skill) => skill.name === 'safe-skill')?.problems).toEqual([]);
    expect(staged.skills.find((skill) => skill.name === 'unsafe-skill')?.files.some((file) => file.path === 'external.txt')).toBe(false);
    const imported = await importStaged(staged.id, ['safe-skill'], [], paths);
    expect(imported.skills.map((skill) => skill.name)).toEqual(['safe-skill']);

    const link = join(base, 'source-link');
    symlinkSync(source, link, 'dir');
    const viaLink = await previewSource(link, paths);
    expect(viaLink.skills.map((skill) => skill.name)).toEqual(['safe-skill', 'unsafe-skill']);

    const repo = initRepo(base);
    writeSkill(repo, 'safe-skill', 'safe-skill');
    const gitUnsafe = writeSkill(repo, 'unsafe-skill', 'unsafe-skill');
    symlinkSync(secret, join(gitUnsafe, 'external.txt'));
    commitAll(repo, 'symlink inside one skill');
    await withGitMirror(repo, async () => {
      const gitPreview = await previewSource('symlink/repo', paths, process.env, 3_000);
      expect(gitPreview.skills.map((skill) => skill.name)).toEqual(['safe-skill', 'unsafe-skill']);
      expect(gitPreview.skills.find((skill) => skill.name === 'unsafe-skill')?.problems).toContainEqual(
        expect.objectContaining({ code: 'symlink-entry' }),
      );
      expect(gitPreview.skills.find((skill) => skill.name === 'safe-skill')?.problems).toEqual([]);
    }, 'https://github.com/symlink/repo.git');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('nested .git content is absent from preview and installed files, with a preview notice', async () => {
  const { base, paths } = sandbox();
  try {
    const source = join(base, 'source');
    const skill = writeSkill(source, 'clean-skill', 'clean-skill');
    mkdirSync(join(skill, 'vendor', '.git'), { recursive: true });
    writeFileSync(join(skill, 'vendor', '.git', 'config'), '[core]\n');
    writeFileSync(join(skill, 'vendor', 'lib.js'), 'safe');
    const staged = await previewSource(source, paths);
    expect(staged.notices).toContain('Nested .git directories are skipped and will not be imported.');
    expect(staged.skills[0]?.files.map((file) => file.path)).not.toContain('vendor/.git/config');
    const imported = await importStaged(staged.id, ['clean-skill'], [], paths);
    expect(imported.skills[0]?.name).toBe('clean-skill');
    expect(existsSync(join(paths.library, 'clean-skill', 'vendor', '.git'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('skill source filter limits preview to the requested skill and reserved names are rejected', async () => {
  const { base, paths } = sandbox();
  try {
    const repo = initRepo(base);
    writeSkill(repo, 'first', 'first');
    writeSkill(repo, 'second', 'second');
    commitAll(repo, 'two skills');
    await withGitMirror(repo, async (url) => {
      const staged = await previewSource('skills-test/repo@first', paths);
      expect(staged.skills.map((skill) => skill.name)).toEqual(['first']);
      expect(staged.source?.skillFilter).toBe('first');
    }, 'https://github.com/skills-test/repo.git');

    expect(() => createSkill('sparrow-worker', 'Reserved skill.', [], paths)).toThrow(/reserved for a built-in/);
    const reservedRoot = join(base, 'reserved');
    writeSkill(reservedRoot, 'sparrow-worker', 'sparrow-worker');
    const reserved = await previewSource(reservedRoot, paths);
    expect(reserved.skills[0]?.problems).toContainEqual(expect.objectContaining({ code: 'name-invalid' }));
    await expect(importStaged(reserved.id, ['sparrow-worker'], [], paths)).rejects.toThrow(/reserved for a built-in/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a Git import disables hooks and filters and leaves submodules uninitialized', async () => {
  const { base, paths } = sandbox();
  try {
    const repo = initRepo(base);
    const ordinary = writeSkill(repo, 'skills/ordinary', 'ordinary');
    const executionMarker = join(base, 'script-ran');
    mkdirSync(join(ordinary, 'scripts'), { recursive: true });
    const executableScript = join(ordinary, 'scripts/run.sh');
    writeFileSync(executableScript, `#!/bin/sh\nprintf ran > '${executionMarker}'\n`, { mode: 0o755 });
    chmodSync(executableScript, 0o755);
    const nonExecutableScript = join(ordinary, 'scripts/inspect.sh');
    writeFileSync(nonExecutableScript, '#!/bin/sh\necho inspect\n', { mode: 0o644 });
    chmodSync(nonExecutableScript, 0o644);
    const child = join(base, 'child');
    mkdirSync(child);
    git(child, 'init', '-b', 'main');
    git(child, 'config', 'user.email', 'skills-test@example.invalid');
    git(child, 'config', 'user.name', 'Skills Test');
    writeSkill(child, 'hidden-skill', 'hidden-skill');
    commitAll(child, 'child skill');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', pathToFileURL(child).toString(), 'deps/hidden');

    const marker = join(base, 'should-not-exist');
    writeFileSync(join(repo, '.gitattributes'), '*.payload filter=tripwire\n');
    writeFileSync(join(repo, 'tripwire.payload'), 'content\n');
    git(repo, 'config', 'filter.tripwire.smudge', `touch '${marker}'; cat`);
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    Bun.spawnSync(['chmod', '+x', hook]);
    commitAll(repo, 'main skills');

    const staged = await withGitMirror(repo, (url) => previewSource(url, paths));
    expect(staged.skills.map((skill) => skill.name)).toEqual(['ordinary']);
    expect(staged.skills[0]?.scriptDetails).toEqual([
      { path: 'scripts/inspect.sh', executable: false, shebang: '#!/bin/sh', scriptsDirectory: true },
      { path: 'scripts/run.sh', executable: true, shebang: '#!/bin/sh', scriptsDirectory: true },
    ]);
    expect(existsSync(executionMarker)).toBe(false);
    await importStaged(staged.id, ['ordinary'], [], paths);
    expect(statSync(join(paths.library, 'ordinary/scripts/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(paths.library, 'ordinary/scripts/inspect.sh')).mode & 0o777).toBe(0o644);
    expect(existsSync(executionMarker)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(paths.sparrowHome, 'skills-staging', 'import-' + staged.id, 'repo', 'deps', 'hidden', 'SKILL.md'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Git import preserves source exec bits and records the installed folder hash and upstream tree SHA', async () => {
  const { base, paths } = sandbox();
  try {
    const repo = initRepo(base);
    const skillDir = writeSkill(repo, 'skills/safe-skill', 'safe-skill');
    mkdirSync(join(skillDir, 'scripts'));
    writeFileSync(join(skillDir, 'scripts/run.sh'), '#!/bin/sh\necho safe\n', { mode: 0o755 });
    chmodSync(join(skillDir, 'scripts/run.sh'), 0o755);
    writeFileSync(join(skillDir, 'README.md'), 'non executable\n', { mode: 0o644 });
    chmodSync(join(skillDir, 'README.md'), 0o644);
    commitAll(repo, 'initial skill');

    await withGitMirror(repo, async (url) => {
    const staged = await previewSource(url, paths);
    expect(staged.skills[0]?.scriptDetails).toEqual([{
      path: 'scripts/run.sh', executable: true, shebang: '#!/bin/sh', scriptsDirectory: true,
    }]);
    const imported = await importStaged(staged.id, ['safe-skill'], ['claude'], paths);
    expect(imported.skills[0]?.name).toBe('safe-skill');
    expect(existsSync(join(paths.roots.claude, 'safe-skill', 'SKILL.md'))).toBe(true);
    const installedScript = join(paths.library, 'safe-skill', 'scripts/run.sh');
    expect(statSync(installedScript).mode & 0o777).toBe(0o755);
    expect(statSync(join(paths.library, 'safe-skill/README.md')).mode & 0o777).toBe(0o644);
    const manifest = readManifest(paths.library);
    const source = manifest.skills['safe-skill']?.source as Record<string, unknown>;
    expect(source.sourceType).toBe('github');
    expect(source.skillPath).toBe('skills/safe-skill/SKILL.md');
    expect(source.installedHash).toBe(folderHash(join(paths.library, 'safe-skill')));
    expect(source.installedHash).toBe(folderHash(skillDir)); // folderHash remains a path+bytes hash with exec bits preserved.
    expect(source.installedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(source.skillFolderHash).toBe(git(repo, 'rev-parse', 'HEAD^{tree}:skills/safe-skill').trim()); // Vercel lock: Git tree SHA
    const originalHash = source.skillFolderHash;

    writeFileSync(join(skillDir, 'SKILL.md'), valid('safe-skill', 'Updated imported skill.'));
    commitAll(repo, 'update skill');
    const updates = await checkUpdates(paths);
    expect(updates).toEqual([expect.objectContaining({
      name: 'safe-skill', current: originalHash, available: true,
    })]);
    expect(updates[0]?.latest).not.toBe(originalHash);
    expect(existsSync(join(paths.sparrowHome, 'skills-staging', 'import-' + staged.id))).toBe(false);
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('expired cleanup removes only expired import folders inside Sparrow staging', async () => {
  const { base, paths } = sandbox();
  try {
    const staged = await previewSource((() => {
      const source = join(base, 'source');
      writeSkill(source, 'safe-skill', 'safe-skill');
      return source;
    })(), paths);
    const staging = join(paths.sparrowHome, 'skills-staging');
    const stageDir = join(staging, 'import-' + staged.id);
    const metadataPath = join(stageDir, 'stage.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { createdAt: number };
    metadata.createdAt = 1;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const unrelated = join(staging, 'keep.txt');
    writeFileSync(unrelated, 'keep');
    const now = STAGED_IMPORT_TTL_MS + 2;
    expect(cleanupExpiredStaging(paths, now)).toBe(1);
    expect(existsSync(stageDir)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Git clone and update-check timeouts finish while the remote socket hangs', async () => {
  const { base, paths } = sandbox();
  const listener = Bun.spawn(['python3', join(import.meta.dir, '../fixtures/skills/phase3/blackhole.py')], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  try {
    await Bun.sleep(100);
    expect(listener.exitCode).toBeNull();
    const started = Date.now();
    await expect(previewSource('git://127.0.0.1:4481/blackhole.git', paths, process.env, 150)).rejects.toThrow(/timed out after 150 ms/);
    expect(Date.now() - started).toBeLessThan(2_000);

    writeManifest({ version: 1, skills: { hanging: { harnesses: [], source: {
      source: 'blackhole', sourceType: 'git', sourceUrl: 'git://127.0.0.1:4481/blackhole.git',
      skillPath: 'hanging/SKILL.md', skillFolderHash: 'a'.repeat(64),
    } } } }, paths.library, paths);
    const updateStarted = Date.now();
    const app = mountSkillAddRoutes(new Hono(), { paths, gitTimeoutMs: 150 });
    const updateResponse = await app.request('/api/skills/updates', { method: 'POST' });
    const updates = await updateResponse.json();
    expect(Date.now() - updateStarted).toBeLessThan(2_000);
    expect(updateResponse.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ name: 'hanging', available: false, error: expect.stringMatching(/timed out after 150 ms/) })]);
  } finally {
    listener.kill();
    await listener.exited;
    rmSync(base, { recursive: true, force: true });
  }
});

test('cleanup expires abandoned staging directories that never got stage.json', () => {
  const { base, paths } = sandbox();
  try {
    const staging = join(paths.sparrowHome, 'skills-staging');
    const orphan = join(staging, 'import-11111111-1111-4111-8111-111111111111');
    mkdirSync(orphan, { recursive: true });
    utimesSync(orphan, new Date(0), new Date(0));
    expect(cleanupExpiredStaging(paths, STAGED_IMPORT_TTL_MS + 2)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a sandbox server whose SPARROW_HOME is outside SPARROW_SKILLS_HOME can still stage uploads, preview and import', async () => {
  const base = mkdtempSync(join(tmpdir(), 'skills-importer-outside-'));
  try {
    const home = join(base, 'skills-home');
    const sparrowHome = join(base, 'server-home');                // what `sparrow sandbox up` does: SPARROW_HOME apart from the skills home
    const paths = skillPaths({ HOME: home, SPARROW_SKILLS_HOME: home, SPARROW_HOME: sparrowHome });
    expect(paths.staging.startsWith(home)).toBe(true);
    expect(paths.backup.startsWith(home)).toBe(true);
    const source = join(base, 'src');
    writeSkill(source, 'one', 'one');

    const staged = await previewSource(source, paths);
    expect(staged.skills.map((s) => s.name)).toEqual(['one']);
    const imported = await importStaged(staged.id, ['one'], ['claude'], paths);
    expect(imported.skills.map((s) => s.name)).toEqual(['one']);
    expect(existsSync(join(paths.library, 'one', 'SKILL.md'))).toBe(true);

    const { stageUpload } = await import('../../src/skills/upload');
    const form = new FormData();
    form.append('files', new File([valid('two')], 'two/SKILL.md'));
    const uploaded = await stageUpload(form, paths);
    expect(uploaded.skills.map((s) => s.name)).toEqual(['two']);
    // nothing was written next to the (outside) server home
    expect(existsSync(sparrowHome)).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a real (non-sandbox) install keeps staging and backups under SPARROW_HOME', () => {
  const paths = skillPaths({ HOME: '/h', SPARROW_HOME: '/h/.sparrow' } as NodeJS.ProcessEnv);
  expect(paths.staging).toBe('/h/.sparrow/skills-staging');
  expect(paths.backup).toBe('/h/.sparrow/skills-backup');
});

test('libraryName follows the Vercel skills tool (lowercase, runs of other characters become "-", ends trimmed) within Sparrow\'s name rule', () => {
  expect(libraryName('vercel-react-best-practices')).toBe('vercel-react-best-practices');
  expect(libraryName('My Skill')).toBe('my-skill');
  expect(libraryName('  Web  Design / Guidelines!! ')).toBe('web-design-guidelines');
  expect(libraryName('foo_bar.baz')).toBe('foo-bar-baz');
  expect(libraryName('!!!')).toBe('');
  expect(libraryName('a'.repeat(70)).length).toBe(64);
  expect(libraryName(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
});

test('a skill whose frontmatter name differs from its folder imports under the frontmatter name, with a preview warning (vercel-labs/agent-skills layout)', async () => {
  const { base, paths } = sandbox();
  try {
    const source = join(base, 'agent-skills');
    // Real repo: skills/react-best-practices/SKILL.md says `name: vercel-react-best-practices`; 5 of its 9 skills do this.
    writeSkill(join(source, 'skills'), 'react-best-practices', 'vercel-react-best-practices');
    writeSkill(join(source, 'skills'), 'web-design-guidelines', 'web-design-guidelines');
    writeSkill(join(source, 'skills'), 'messy-folder', 'Messy Name');
    writeSkill(join(source, 'skills'), 'broken', '!!!');
    const staged = await previewSource(source, paths);
    const by = Object.fromEntries(staged.skills.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(['', 'messy-name', 'vercel-react-best-practices', 'web-design-guidelines']);
    expect(by['vercel-react-best-practices']!.problems).toEqual([]);
    expect(by['vercel-react-best-practices']!.warnings).toEqual([expect.stringMatching(/folder "react-best-practices" differs.*imported as "vercel-react-best-practices"/)]);
    expect(by['web-design-guidelines']!.warnings).toEqual([]);                         // folder == name: nothing to say
    expect(by['messy-name']!.problems).toEqual([]);
    expect(by['messy-name']!.warnings.length).toBe(2);                                    // cleaned name + differing folder
    expect(by['messy-name']!.warnings[0]).toContain('"Messy Name" is imported as "messy-name"');
    expect(by['']!.problems.map((p) => p.code)).toContain('name-invalid');                 // nothing usable left after cleaning: still refused

    await expect(importStaged(staged.id, [''], [], paths)).rejects.toThrow(/invalid/i);
    const result = await importStaged(staged.id, ['vercel-react-best-practices', 'messy-name'], ['claude'], paths);
    expect(result.skills.map((s) => s.name)).toEqual(['vercel-react-best-practices', 'messy-name']);
    expect(existsSync(join(paths.library, 'vercel-react-best-practices', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(paths.library, 'react-best-practices'))).toBe(false);
    const manifest = readManifest(paths.library);
    expect(Object.keys(manifest.skills).sort()).toEqual(['messy-name', 'vercel-react-best-practices']);
    expect(manifest.skills['vercel-react-best-practices']!.source).toMatchObject({ skillPath: 'skills/react-best-practices/SKILL.md' });
    // SKILL.md is imported byte for byte (Vercel does not rewrite it either)
    expect(readFileSync(join(paths.library, 'messy-name', 'SKILL.md'), 'utf8')).toContain('name: Messy Name');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('two skills whose names clean to the same library name are both shown; the second carries a name-collision problem and is never silently dropped', async () => {
  const { base, paths } = sandbox();
  try {
    const source = join(base, 'collide');
    writeSkill(join(source, 'skills'), 'a-first', 'My Skill', valid('My Skill', 'The first one.'));
    writeSkill(join(source, 'skills'), 'b-second', 'my-skill', valid('my-skill', 'The second one.'));
    writeSkill(join(source, 'skills'), 'c-other', 'other');
    const staged = await previewSource(source, paths);
    expect(staged.skills.map((s) => [s.name, s.description])).toEqual([
      ['my-skill', 'The first one.'], ['my-skill', 'The second one.'], ['other', 'Imported safely.'],
    ]);
    expect(staged.skills[0]!.problems).toEqual([]);
    expect(staged.skills[1]!.problems).toEqual([expect.objectContaining({ code: 'name-collision', message: expect.stringContaining('skills/a-first/SKILL.md') })]);
    // selecting the name imports the first skill; the colliding one is never what lands in the library
    const result = await importStaged(staged.id, ['my-skill', 'other'], ['claude'], paths);
    expect(result.skills.map((s) => s.name)).toEqual(['my-skill', 'other']);
    expect(readFileSync(join(paths.library, 'my-skill', 'SKILL.md'), 'utf8')).toContain('The first one.');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a byte-identical mirror of a skill (e.g. under .claude/skills and skills) is listed once, with a notice', async () => {
  const { base, paths } = sandbox();
  try {
    const source = join(base, 'mirror');
    writeSkill(join(source, 'skills'), 'same', 'same');
    writeSkill(join(source, '.claude', 'skills'), 'same', 'same');
    const staged = await previewSource(source, paths);
    expect(staged.skills.map((s) => s.name)).toEqual(['same']);
    expect(staged.skills[0]!.problems).toEqual([]);
    expect(staged.notices?.join(' ')).toMatch(/Identical copies of a skill were listed once/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
