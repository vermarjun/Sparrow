import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { applyMigration, backup, planMigration, rollback, snapshotTree } from '../../src/skills/migrate';
import { folderHash } from '../../src/skills/hash';
import { diff } from '../../src/skills/link';
import { scanSkills } from '../../src/skills/scan';
import { readManifest } from '../../src/skills/manifest';
import { makeSkill, makeSymlink, sandbox } from './helpers';

test('migration plan skips only Sparrow, synced, built-ins, dangling and already-linked entries; outside and tool links become candidates', () => {
  const { root, paths } = sandbox();
  const claude = paths.roots.claude;
  const codex = paths.roots.codex;
  makeSkill(join(claude, 'variant'), 'variant', 'Claude variant.\n');
  makeSkill(join(codex, 'variant'), 'variant', 'Codex variant.\n');
  makeSkill(join(claude, 'sparrow-worker'), 'sparrow-worker');
  makeSkill(join(claude, 'synced', 'bucket', 'docx'), 'docx');
  makeSkill(join(codex, '.system', 'skill-creator'), 'skill-creator');
  symlinkSync(join(root, 'missing'), join(claude, 'dangling'), 'dir');
  makeSkill(join(root, 'brew-target'), 'brew');
  symlinkSync(join(root, 'brew-target'), join(claude, 'brew-skill'), 'dir');
  const toolOwned = makeSkill(join(paths.externalTargets[0]!, 'app', 'skills', 'terminal-browser'), 'terminal-browser');
  symlinkSync(toolOwned, join(codex, 'terminal-browser'), 'dir');
  makeSkill(join(paths.library, 'in-lib'), 'in-lib');
  symlinkSync(join(paths.library, 'in-lib'), join(claude, 'in-lib'), 'dir');
  symlinkSync(join(claude, 'synced', 'bucket', 'docx'), join(codex, 'docx'), 'dir');
  const plan = planMigration(paths);
  const choice = plan.decisions.find((item) => item.name === 'variant')!;
  expect(choice.variants).toHaveLength(2);
  const code = (path: string) => plan.skipped.find((item) => item.path === path)?.code;
  expect(code(join(claude, 'sparrow-worker'))).toBe('sparrow');
  expect(code(join(claude, 'synced'))).toBe('container');
  expect(code(join(codex, '.system'))).toBe('container');
  expect(code(join(claude, 'dangling'))).toBe('dangling');
  expect(code(join(claude, 'in-lib'))).toBe('in-library');
  expect(code(join(codex, 'docx'))).toBe('synced');
  // links outside HOME-like folders and into tool-owned folders are NOT skipped any more: their content is migrated
  const brew = plan.candidates.find((item) => item.name === 'brew-skill')!;
  expect(brew.kind).toBe('link');
  expect(brew.linkTarget).toBe(join(root, 'brew-target'));
  expect(plan.candidates.some((item) => item.name === 'terminal-browser' && item.kind === 'link')).toBe(true);
  expect(plan.protectedVariants.some((item) => item.name === 'docx')).toBe(true);
  expect(plan.protectedVariants.some((item) => item.name === 'skill-creator')).toBe(true);
});

test('migration re-hashes each candidate immediately before acting and preserves a changed variant', () => {
  const { paths } = sandbox();
  const claudeVariant = makeSkill(join(paths.roots.claude, 'stale-variant'), 'stale-variant', 'Planned bytes.\n');
  const codexVariant = makeSkill(join(paths.roots.codex, 'stale-variant'), 'stale-variant', 'Planned bytes.\n');
  utimesSync(claudeVariant, new Date(1_000_000), new Date(1_000_000));
  utimesSync(codexVariant, new Date(2_000_000), new Date(2_000_000));
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  writeFileSync(join(codexVariant, 'SKILL.md'), 'user edit after plan\n');
  const changedTree = snapshotTree(codexVariant);
  const applied = applyMigration(plan, {}, paths, saved);

  expect(applied.skipped).toContainEqual({ path: codexVariant, reason: 'changed since plan' });
  expect(lstatSync(codexVariant).isDirectory()).toBe(true);
  expect(readFileSync(join(codexVariant, 'SKILL.md'), 'utf8')).toBe('user edit after plan\n');
  expect(lstatSync(claudeVariant).isSymbolicLink()).toBe(true);
  expect(readManifest(paths.library).skills['stale-variant']?.harnesses).toEqual(['claude', 'opencode']);

  rollback(saved, paths);
  expect(snapshotTree(codexVariant)).toEqual(changedTree);
  expect(lstatSync(claudeVariant).isDirectory()).toBe(true);
});

/** Two differing copies (Claude older, Codex newer) and an unrelated skill. */
function variantHome() {
  const sb = sandbox();
  const { paths } = sb;
  const claudeVariant = makeSkill(join(paths.roots.claude, 'variant'), 'variant', 'Claude version.\n');
  const codexVariant = makeSkill(join(paths.roots.codex, 'variant'), 'variant', 'Codex version.\n');
  makeSkill(join(paths.roots.claude, 'plain'), 'plain', 'Plain.\n');
  utimesSync(claudeVariant, new Date(1_000_000), new Date(1_000_000));
  utimesSync(codexVariant, new Date(2_000_000), new Date(2_000_000));
  return { ...sb, claudeVariant, codexVariant };
}

test('the plan never names a winner for differing copies: needs-choice, no default, neutral order', () => {
  const { paths, claudeVariant, codexVariant } = variantHome();
  const plan = planMigration(paths);
  const decision = plan.decisions.find((item) => item.name === 'variant')!;
  expect(decision.needsChoice).toBe(true);
  expect(decision.defaultPath).toBeNull();
  expect(decision.defaultHash).toBeNull();
  expect('variant' in plan.defaultChoices).toBe(false);
  // not newest-first: the Claude copy is the OLDER one and still comes first
  expect(decision.variants.map((v) => v.path)).toEqual([claudeVariant, codexVariant]);
  const plain = plan.decisions.find((item) => item.name === 'plain')!;
  expect(plain.needsChoice).toBe(false);
  expect(plain.defaultPath).toBe(join(paths.roots.claude, 'plain'));
  expect(plan.defaultChoices.plain).toBe(join(paths.roots.claude, "plain"));
});

test('no explicit choice keeps differing copies as conflicts: nothing copied, every copy byte-identical, then rollback is identical', () => {
  const { paths, claudeVariant, codexVariant } = variantHome();
  const roots = [paths.roots.claude, paths.roots.codex, paths.roots.opencode, paths.roots.agents, paths.desktopSkills];
  const before = roots.map((path) => [path, snapshotTree(path)] as const);
  const hashes = [folderHash(claudeVariant), folderHash(codexVariant)];
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  const applied = applyMigration(plan, {}, paths, saved);

  expect(existsSync(join(paths.library, 'variant'))).toBe(false);
  expect(readManifest(paths.library).skills.variant).toBeUndefined();
  expect(applied.selected.variant).toBeUndefined();
  expect(applied.replaced).not.toContain(claudeVariant);
  expect(applied.replaced).not.toContain(codexVariant);
  expect(lstatSync(claudeVariant).isDirectory()).toBe(true);
  expect(lstatSync(codexVariant).isDirectory()).toBe(true);
  expect([folderHash(claudeVariant), folderHash(codexVariant)]).toEqual(hashes);
  expect(existsSync(join(saved.dir, 'claude', 'variant'))).toBe(false);
  expect(existsSync(join(saved.dir, 'codex', 'variant'))).toBe(false);
  // the copies are still listed, as Unmanaged (the library has no skill of that name to conflict with)
  expect(scanSkills(paths).filter((e) => e.name === 'variant' && e.status === 'unmanaged').map((e) => e.root).sort()).toEqual(['claude', 'codex']);
  // unrelated skills migrate as usual
  expect(readlinkSync(join(paths.roots.claude, 'plain'))).toBe(join(paths.library, 'plain'));
  for (const [path, snap] of before) {
    // everything except the migrated `plain` entry (and the OpenCode folder its toggle created) is unchanged
    if (path === paths.roots.opencode) continue;
    const now = snapshotTree(path).filter((n) => !n.path.startsWith('plain'));
    expect(now).toEqual(snap.filter((n) => !n.path.startsWith('plain')));
  }

  rollback(saved, paths);
  for (const [path, snap] of before) expect(snapshotTree(path)).toEqual(snap);
  expect(existsSync(paths.library)).toBe(false);
});

for (const pick of ['claude', 'codex'] as const) {
  test(`choosing the ${pick} copy puts exactly that copy in the library and backs up the other`, () => {
    const { paths, claudeVariant, codexVariant } = variantHome();
    const roots = [paths.roots.claude, paths.roots.codex, paths.roots.opencode, paths.roots.agents, paths.desktopSkills];
    const before = roots.map((path) => [path, snapshotTree(path)] as const);
    const chosen = pick === 'claude' ? claudeVariant : codexVariant;
    const other = pick === 'claude' ? codexVariant : claudeVariant;
    const otherRoot = pick === 'claude' ? 'codex' : 'claude';
    const chosenText = pick === 'claude' ? 'Claude version.' : 'Codex version.';
    const otherText = pick === 'claude' ? 'Codex version.' : 'Claude version.';
    const chosenHash = folderHash(chosen);
    const plan = planMigration(paths);
    const saved = backup(plan, paths);
    const applied = applyMigration(plan, { variant: chosen }, paths, saved);

    expect(folderHash(join(paths.library, 'variant'))).toBe(chosenHash);
    expect(readFileSync(join(paths.library, 'variant', 'SKILL.md'), 'utf8')).toContain(chosenText);
    expect(applied.selected.variant).toBe(chosen);
    for (const entry of [claudeVariant, codexVariant]) expect(readlinkSync(entry)).toBe(join(paths.library, 'variant'));
    expect(applied.replaced).toEqual(expect.arrayContaining([claudeVariant, codexVariant]));
    // the other copy's original bytes are in the backup, the chosen one's too
    expect(readFileSync(join(saved.dir, otherRoot, 'variant', 'SKILL.md'), 'utf8')).toContain(otherText);
    expect(readFileSync(join(saved.dir, pick, 'variant', 'SKILL.md'), 'utf8')).toContain(chosenText);
    expect(readManifest(paths.library).skills.variant?.harnesses).toEqual(['claude', 'codex', 'opencode']);
    expect(other).not.toBe(chosen);
    expect(scanSkills(paths).some((e) => e.name === 'variant' && e.status === 'conflict')).toBe(false);

    rollback(saved, paths);
    for (const [path, snap] of before) expect(snapshotTree(path)).toEqual(snap);
    expect(existsSync(paths.library)).toBe(false);
  });
}

test('a choice that names no copy of the skill is refused before anything moves', () => {
  const { paths } = variantHome();
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  expect(() => applyMigration(plan, { variant: join(paths.roots.claude, 'plain') }, paths, saved)).toThrow(/Invalid migration choice/);
  expect(saved.movedPaths).toEqual([]);
  expect(existsSync(join(paths.library, 'variant'))).toBe(false);
});

test('an explicit migration choice replaces every differing variant; an identical ~/.agents/skills copy joins the library copy', () => {
  const { paths } = sandbox();
  const claudeVariant = makeSkill(join(paths.roots.claude, 'variant'), 'variant', 'Claude version.\n');
  const codexVariant = makeSkill(join(paths.roots.codex, 'variant'), 'variant', 'Codex version.\n');
  utimesSync(claudeVariant, new Date(1_000_000), new Date(1_000_000));
  utimesSync(codexVariant, new Date(2_000_000), new Date(2_000_000));
  const shared = makeSkill(join(paths.roots.claude, 'shared'), 'shared', 'Shared source.\n');
  makeSkill(join(paths.roots.agents, 'shared'), 'shared', 'Shared source.\n');
  makeSkill(join(paths.desktopSkills, 'desktop-only'), 'desktop-only');
  makeSkill(join(paths.roots['claude-synced'], 'bucket', 'docx'), 'docx');
  const rootsBefore = [paths.roots.claude, paths.roots.codex, paths.roots.opencode, paths.roots.agents, paths.desktopSkills]
    .map((path) => [path, snapshotTree(path)] as const);
  const plan = planMigration(paths);
  expect(plan.decisions.find((item) => item.name === 'shared')?.variants).toHaveLength(2);
  expect(plan.decisions.find((item) => item.name === 'shared')?.needsChoice).toBe(false);
  expect(plan.decisions.find((item) => item.name === 'variant')?.needsChoice).toBe(true);
  const variantChoice = plan.decisions.find((item) => item.name === 'variant')!.variants.find((v) => v.path === claudeVariant)!;
  const saved = backup(plan, paths);
  expect(saved.size).toBeGreaterThan(0);
  expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
  const applied = applyMigration(plan, { variant: variantChoice.path }, paths, saved);
  expect(folderHash(join(paths.library, 'variant'))).toBe(variantChoice.hash);
  expect(readlinkSync(join(paths.roots.claude, 'variant'))).toBe(join(paths.library, 'variant'));
  expect(readlinkSync(join(paths.roots.codex, 'variant'))).toBe(join(paths.library, 'variant'));
  // the library is the single copy: Claude links to it, not to ~/.agents/skills; the agents original is in the backup
  expect(readlinkSync(join(paths.roots.claude, 'shared'))).toBe(join(paths.library, 'shared'));
  expect(existsSync(join(paths.library, 'shared', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(paths.roots.agents, 'shared'))).toBe(false);
  expect(existsSync(join(saved.dir, 'agents', 'shared', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(paths.desktopSkills, 'desktop-only'))).toBe(true);
  expect(existsSync(join(saved.dir, 'desktop', 'desktop-only', 'SKILL.md'))).toBe(true);
  expect(applied.replaced.length).toBeGreaterThan(0);

  const result = rollback(saved, paths);
  expect(result.notRestored).toEqual([]);
  for (const [path, before] of rootsBefore) expect(snapshotTree(path)).toEqual(before);
  expect(existsSync(paths.library)).toBe(false);
  expect(existsSync(shared)).toBe(true);
});

/** The user's real layout in miniature: AWS set in both ~/.claude and ~/.agents, brew + project links, terminal-browser. */
function realisticHome() {
  const sb = sandbox();
  const { root, paths } = sb;
  for (const name of ['aws-iam', 'aws-cdk']) {
    makeSkill(join(paths.roots.agents, name), name, `${name} body.\n`);
    makeSkill(join(paths.roots.claude, name), name, `${name} body.\n`);
  }
  makeSkill(join(paths.roots.agents, 'agents-only'), 'agents-only', 'Only in ~/.agents.\n');
  const brew = makeSkill(join(root, 'opt-homebrew', 'agent-browser'), 'agent-browser', 'Brew skill.\n');
  makeSymlink(brew, join(paths.roots.claude, 'agent-browser'));
  const grill = makeSkill(join(paths.home, 'Desktop', 'ComponentLibrary', 'design-grill'), 'design-grill', 'Grill.\n');
  makeSymlink(grill, join(paths.roots.claude, 'design-grill'));
  const tbCodex = makeSkill(join(paths.externalTargets[0]!, 'app', 'skills', 'codex', 'terminal-browser'), 'terminal-browser', 'codex flavour\n');
  const tbDefault = makeSkill(join(paths.externalTargets[0]!, 'app', 'skills', 'default', 'terminal-browser'), 'terminal-browser', 'default flavour\n');
  makeSymlink(tbCodex, join(paths.roots.codex, 'terminal-browser'));
  makeSymlink(tbDefault, join(paths.roots.agents, 'terminal-browser'));
  makeSkill(join(paths.roots.codex, 'codex-own'), 'codex-own', 'Codex user skill.\n');
  makeSkill(join(paths.roots.claude, 'sparrow-worker'), 'sparrow-worker');
  makeSkill(join(paths.roots.codex, '.system', 'skill-creator'), 'skill-creator');
  makeSkill(join(paths.roots['claude-synced'], 'bucket', 'docx'), 'docx');
  makeSymlink(join(root, 'gone'), join(paths.roots.claude, 'dangling'));
  const real = [paths.roots.claude, paths.roots.codex, paths.roots.opencode, paths.roots.agents, paths.desktopSkills, root + '/opt-homebrew', paths.home + '/Desktop/ComponentLibrary', paths.externalTargets[0]!];
  return { ...sb, brew, grill, tbCodex, tbDefault, real };
}

test('scope: everything that is not a harness default or Sparrow\'s own goes to the library, with its current visibility as toggles', () => {
  const { paths, real, brew, grill } = realisticHome();
  const plan = planMigration(paths);
  const names = plan.decisions.map((d) => d.name);
  expect(names).toEqual(['agent-browser', 'agents-only', 'aws-cdk', 'aws-iam', 'codex-own', 'design-grill', 'terminal-browser']);
  const by = (name: string) => plan.decisions.find((d) => d.name === name)!;
  expect(by('aws-iam').variants.map((v) => v.root).sort()).toEqual(['agents', 'claude']);
  expect(by('aws-iam').needsChoice).toBe(false);
  expect(by('terminal-browser').needsChoice).toBe(true); // two different tool flavours: the user chooses
  // visibility today -> toggles on day one
  expect(by('aws-iam').harnesses).toEqual(['claude', 'codex', 'opencode']);
  expect(by('agents-only').harnesses).toEqual(['codex', 'opencode']);
  expect(by('agent-browser').harnesses).toEqual(['claude', 'opencode']);
  expect(by('codex-own').harnesses).toEqual(['codex']);
  expect(plan.skipped.map((s) => s.code).sort()).toEqual(['container', 'container', 'dangling', 'sparrow']);

  const before = real.map((path) => [path, snapshotTree(path)] as const);
  const saved = backup(plan, paths);
  const applied = applyMigration(plan, {}, paths, saved);
  const manifest = readManifest(paths.library);
  expect(manifest.skills['aws-iam']?.harnesses).toEqual(['claude', 'codex', 'opencode']);
  expect(manifest.skills['agents-only']?.harnesses).toEqual(['codex', 'opencode']);
  // the library is the single copy, byte-identical to the original content
  expect(folderHash(join(paths.library, 'agent-browser'))).toBe(folderHash(brew));
  expect(folderHash(join(paths.library, 'design-grill'))).toBe(folderHash(grill));
  expect(existsSync(join(paths.library, 'terminal-browser'))).toBe(false); // needs a choice: untouched
  // harness folders now hold library links for exactly the toggled harnesses
  const linked = (root: 'claude' | 'codex' | 'opencode', name: string) => {
    try { return readlinkSync(join(paths.roots[root], name)) === join(paths.library, name); } catch { return false; }
  };
  expect(['claude', 'codex', 'opencode'].map((h) => linked(h as 'claude', 'aws-iam'))).toEqual([true, true, true]);
  expect(['claude', 'codex', 'opencode'].map((h) => linked(h as 'claude', 'agents-only'))).toEqual([false, true, true]);
  expect(linked('claude', 'agent-browser')).toBe(true);
  expect(linked('opencode', 'agent-browser')).toBe(true);
  expect(linked('codex', 'agent-browser')).toBe(false);
  expect(linked('claude', 'design-grill')).toBe(true);
  expect(existsSync(join(paths.roots.agents, 'agents-only'))).toBe(false);
  expect(existsSync(join(paths.roots.agents, 'aws-iam'))).toBe(false);
  expect(applied.linkConflicts).toEqual([]);
  // the original link targets are noted in the backup manifest, and the targets themselves were never touched
  const noted = saved.moved.find((m) => m.path === join(paths.roots.claude, 'agent-browser'))!;
  expect(noted.kind).toBe('link');
  expect(noted.linkTarget).toBe(brew);
  expect(readFileSync(join(brew, 'SKILL.md'), 'utf8')).toContain('Brew skill');
  expect(readFileSync(saved.manifestPath, 'utf8')).toContain(brew);
  // a second plan finds nothing left except what needed a choice
  const again = planMigration(paths);
  expect(again.decisions.map((d) => d.name)).toEqual(['terminal-browser']);

  const result = rollback(saved, paths);
  expect(result.notRestored).toEqual([]);
  expect(result.restored.length).toBe(saved.movedPaths.length);
  expect(result.libraryRestored).toBe(false);
  expect(result.libraryNote).toMatch(/no library before/);
  for (const [path, snap] of before) expect(snapshotTree(path)).toEqual(snap);
  expect(existsSync(paths.library)).toBe(false);
  expect(existsSync(join(paths.roots.opencode))).toBe(false); // the folder apply created for new links is gone again
});

test('rollback restores a migrated path that is missing now (link removed later) and reports exactly what it restored', () => {
  const { paths, real } = realisticHome();
  const before = real.map((path) => [path, snapshotTree(path)] as const);
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  applyMigration(plan, {}, paths, saved);
  const removed = join(paths.roots.claude, 'aws-iam');
  const gone = join(paths.roots.claude, 'design-grill');
  unlinkSync(removed);
  unlinkSync(gone);
  const result = rollback(saved, paths);
  expect(result.restored).toContain(removed);
  expect(result.restored).toContain(gone);
  expect(result.notRestored).toEqual([]);
  expect(result.restored.length).toBe(saved.moved.length);
  for (const [path, snap] of before) expect(snapshotTree(path)).toEqual(snap);
});

test('rollback never claims a path it did not restore: not in the archive, outside HOME, or a move that never happened', () => {
  const { paths, home } = realisticHome();
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  applyMigration(plan, {}, paths, saved);
  const real = saved.moved[0]!;
  const ghost = { ...real, path: join(paths.roots.claude, 'ghost'), name: 'ghost', backupPath: join(saved.dir, 'claude', 'ghost') };
  const outside = { ...real, path: '/tmp/definitely-outside-home/x', name: 'x' };
  const unmoved = { ...real, path: join(paths.roots.claude, 'aws-cdk'), name: 'aws-cdk', backupPath: join(saved.dir, 'claude', 'never-moved') };
  const tampered = {
    ...saved,
    movedPaths: [...saved.movedPaths, ghost.path, outside.path],
    moved: [...saved.moved, ghost, outside],
    inFlight: unmoved,
  };
  tampered.moved = tampered.moved.filter((m) => m.path !== unmoved.path);
  tampered.movedPaths = tampered.movedPaths.filter((p) => p !== unmoved.path);
  const result = rollback(tampered, paths);
  const reasons = Object.fromEntries(result.notRestored.map((n) => [n.path, n.reason]));
  expect(reasons[ghost.path]).toMatch(/not in the backup archive/);
  expect(reasons[outside.path]).toMatch(/outside HOME/);
  expect(reasons[unmoved.path]).toMatch(/had not happened/);
  expect(result.restored).not.toContain(ghost.path);
  expect(result.restored).not.toContain(outside.path);
  expect(result.restored).not.toContain(unmoved.path);
  expect(result.restored.every((p) => p.startsWith(home))).toBe(true);
  expect(lstatSync(join(paths.roots.claude, 'aws-iam')).isDirectory()).toBe(true);
});

test('rollback recovers a crash mid-apply: the entry was renamed into the backup before it was recorded', () => {
  const { paths, real } = realisticHome();
  const before = real.map((path) => [path, snapshotTree(path)] as const);
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  const candidate = plan.candidates.find((c) => c.path === join(paths.roots.claude, 'aws-iam'))!;
  const backupPath = join(saved.dir, candidate.root, candidate.name);
  const entry = {
    path: candidate.path, root: candidate.root, name: candidate.name, kind: candidate.kind, linkTarget: candidate.linkTarget,
    resolvedPath: candidate.resolvedPath, hash: candidate.hash, backupPath,
  };
  saved.inFlight = entry;
  mkdirSync(join(saved.dir, candidate.root), { recursive: true });
  renameSync(candidate.path, backupPath); // ...and the process died here
  expect(existsSync(candidate.path)).toBe(false);
  const result = rollback(saved, paths);
  expect(result.restored).toEqual([candidate.path]);
  expect(result.notRestored).toEqual([]);
  for (const [path, snap] of before) expect(snapshotTree(path)).toEqual(snap);
});

test('rollback moves aside library links the migration did not create (toggles added later) instead of leaving them dangling', () => {
  const { paths } = realisticHome();
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  applyMigration(plan, {}, paths, saved);
  const later = join(paths.roots.codex, 'agent-browser'); // toggled on after the migration
  symlinkSync(join(paths.library, 'agent-browser'), later, 'dir');
  const result = rollback(saved, paths);
  expect(result.removedLinks).toContain(later);
  expect(() => lstatSync(later)).toThrow();
  expect(existsSync(join(result.preservedAt!, 'links'))).toBe(true);
});

test('a link that already points at the library copy is not migrated again, and ~/.agents/skills originals move without a link back', () => {
  const { paths } = sandbox();
  makeSkill(join(paths.roots.agents, 'only-agents'), 'only-agents');
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  const applied = applyMigration(plan, {}, paths, saved);
  expect(existsSync(join(paths.roots.agents, 'only-agents'))).toBe(false);
  expect(applied.replaced).toEqual([join(paths.roots.agents, 'only-agents')]);
  expect(applied.linkConflicts).toEqual([]);
  expect(readlinkSync(join(paths.roots.codex, 'only-agents'))).toBe(join(paths.library, 'only-agents'));
  expect(readlinkSync(join(paths.roots.opencode, 'only-agents'))).toBe(join(paths.library, 'only-agents'));
  const again = planMigration(paths);
  expect(again.candidates).toEqual([]);
  expect(again.skipped.map((s) => s.code)).toEqual(['in-library', 'in-library']); // only the links the migration made, reported as already linked
});

test('rollback moves the current library into its backup and reports skills added after migration', () => {
  const { paths } = sandbox();
  makeSkill(join(paths.library, 'before'), 'before', 'Pre-migration library skill.\n');
  makeSkill(join(paths.roots.claude, 'new-source'), 'new-source', 'Migrated source.\n');
  const plan = planMigration(paths);
  const saved = backup(plan, paths);
  applyMigration(plan, {}, paths, saved);
  makeSkill(join(paths.library, 'added-later'), 'added-later', 'Added after migration.\n');

  const result = rollback(saved, paths);
  expect(result.addedSkills).toContain('added-later');
  expect(result.preservedAt).not.toBeNull();
  expect(existsSync(join(result.preservedAt!, 'library', 'added-later', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(paths.library, 'before', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(paths.library, 'added-later'))).toBe(false);
  expect(lstatSync(join(paths.roots.claude, 'new-source')).isDirectory()).toBe(true);
});
