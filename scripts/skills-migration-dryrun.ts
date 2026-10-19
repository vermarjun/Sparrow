import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync,
  realpathSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { applyMigration, backup, planMigration, rollback, snapshotTree, summarizePlan } from '../src/skills/migrate';
import { folderHash } from '../src/skills/hash';
import { readManifest } from '../src/skills/manifest';
import { skillPaths } from '../src/skills/paths';
import type { SkillPaths } from '../src/skills/types';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = join(REPO, '.sandbox', 'migration-home');
// Everything this script writes is under the sandbox HOME (git-ignored .sandbox/); the real folders are only read.
const REAL_HOME = resolve(homedir());

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** cp -a style tree copy that keeps links and remaps absolute HOME targets into the sandbox. */
function sandboxDestination(path: string): string {
  const destination = resolve(path);
  if (!inside(destination, SANDBOX)) throw new Error(`Refusing dry-run copy outside sandbox HOME: ${path}`);
  return destination;
}

function copyRoots(): void {
  if (existsSync(SANDBOX)) {
    const archive = join(REPO, '.sandbox', 'migration-archives', `migration-home-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
    mkdirSync(dirname(archive), { recursive: true });
    renameSync(SANDBOX, archive);
  }
  mkdirSync(SANDBOX, { recursive: true });
  const copied = new Set<string>();
  const destOf = (source: string) => join(SANDBOX, relative(REAL_HOME, source));
  const copyNode = (source: string, destination = destOf(source)) => {
    const key = resolve(source);
    if (copied.has(key) || !inside(key, REAL_HOME)) return;
    copied.add(key);
    let st;
    try { st = lstatSync(source); } catch { return; }
    sandboxDestination(destination);
    mkdirSync(dirname(destination), { recursive: true });
    if (st.isSymbolicLink()) {
      const raw = readlinkSync(source);
      const sourceTarget = resolve(dirname(source), raw);
      const absoluteTarget = isAbsolute(raw) ? resolve(raw) : null;
      const targetInsideHome = inside(sourceTarget, REAL_HOME);
      if (targetInsideHome) {
        let targetStat;
        try { targetStat = lstatSync(sourceTarget); } catch { targetStat = null; }
        if (targetStat?.isDirectory() && existsSync(join(sourceTarget, 'SKILL.md'))) copyNode(sourceTarget, destOf(sourceTarget));
      }
      const rewritten = absoluteTarget && inside(absoluteTarget, REAL_HOME)
        ? destOf(absoluteTarget) : raw;
      symlinkSync(rewritten, destination, st.isDirectory() ? 'dir' : 'file');
    } else if (st.isDirectory()) {
      mkdirSync(destination, { recursive: true, mode: st.mode & 0o7777 });
      for (const name of readdirSync(source).sort((a, b) => a.localeCompare(b))) copyNode(join(source, name), join(destination, name));
      chmodSync(destination, st.mode & 0o7777);
      utimesSync(destination, st.atime, st.mtime);
    } else if (st.isFile()) {
      copyFileSync(source, destination);
      chmodSync(destination, st.mode & 0o7777);
      utimesSync(destination, st.atime, st.mtime);
    }
  };

  for (const rel of ['.claude/skills', '.codex/skills', '.agents/skills', '.config/opencode/skills', 'Desktop/Skills']) {
    const source = join(REAL_HOME, rel);
    if (existsSync(source) || (() => { try { lstatSync(source); return true; } catch { return false; } })()) copyNode(source);
  }
}

const sandboxEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: SANDBOX,
  SPARROW_SKILLS_HOME: SANDBOX,
  SPARROW_HOME: join(SANDBOX, '.sparrow'),
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Every real folder this run could read: the five source roots plus whatever their links point at. */
function realFolders(): string[] {
  const roots = ['.claude/skills', '.codex/skills', '.agents/skills', '.config/opencode/skills', 'Desktop/Skills'].map((rel) => join(REAL_HOME, rel));
  const out = new Set(roots);
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      try { if (lstatSync(join(root, name)).isSymbolicLink()) out.add(realpathSync(join(root, name))); } catch { /* dangling */ }
    }
  }
  return [...out].sort();
}

function checksums(folders: string[]): Record<string, string> {
  return Object.fromEntries(folders.map((folder) => [folder, digest(snapshotTree(folder))]));
}

/** name -> content hash of every skill a harness's folders expose (what its own sessions would list). */
function visibility(paths: SkillPaths): Record<'claude' | 'codex' | 'opencode', Record<string, string>> {
  const read = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};
    let names: string[] = [];
    try { names = readdirSync(root); } catch { return out; }
    for (const name of names) {
      const path = join(root, name);
      try {
        if (!lstatSync(realpathSync(path)).isDirectory() || !existsSync(join(path, 'SKILL.md'))) continue;
        out[name] = folderHash(realpathSync(path));
      } catch { /* dangling or not a skill */ }
    }
    return out;
  };
  const claude = read(paths.roots.claude);
  const agents = read(paths.roots.agents);
  delete claude.synced;
  return {
    claude,
    codex: { ...agents, ...read(paths.roots.codex) },
    opencode: { ...agents, ...claude, ...read(paths.roots.opencode) },
  };
}

function main(): void {
  const paths = skillPaths(sandboxEnv);
  const folders = realFolders();
  const realBefore = checksums(folders);
  copyRoots();
  const rootPaths = [paths.roots.claude, paths.roots.codex, paths.roots.opencode, paths.roots.agents, paths.desktopSkills, paths.library];
  const homeTree = () => snapshotTree(SANDBOX).filter((n) => n.path !== '.sparrow' && !n.path.startsWith('.sparrow/'));
  const before = homeTree();
  const visBefore = visibility(paths);
  console.log(`sandbox HOME: ${SANDBOX}`);
  console.log(`real source folders checksummed: ${folders.length}`);

  // 1. dry run: plan only
  const plan = planMigration(paths);
  const summary = summarizePlan(plan);
  const planWroteNothing = digest(homeTree()) === digest(before);
  console.log('\n== PLAN (nothing applied) ==');
  console.log(`entries to move: ${summary.entries} (${summary.linksFlattened} are links whose content is copied)`);
  console.log(`skills going to the library: ${summary.toLibrary}`);
  console.log(`skills needing your choice (${summary.needsChoice.length}): ${summary.needsChoice.join(', ') || 'none'}`);
  console.log(`skipped (${plan.skipped.length}): ${JSON.stringify(summary.skipped)}`);
  for (const item of plan.skipped) console.log(`  - ${relative(SANDBOX, item.path)}: ${item.reason}`);
  console.log(`protected (never touched): ${plan.protectedVariants.map((v) => `${v.root}:${v.name}`).join(', ')}`);
  console.log('toggles per skill:');
  for (const d of plan.decisions) console.log(`  ${d.name.padEnd(34)} ${d.needsChoice ? 'NEEDS CHOICE ' : ''}${d.harnesses.join('+') || '(none)'}  <- ${d.variants.map((v) => `${v.root}${v.kind === 'link' ? '(link)' : ''}`).join(', ')}`);
  console.log(`plan wrote nothing to the sandbox: ${planWroteNothing}`);

  // 2. apply (no choices: differing copies stay put), then rollback
  const saved = backup(plan, paths);
  const applied = applyMigration(plan, {}, paths, saved);
  const manifest = readManifest(paths.library);
  const visAfter = visibility(paths);
  console.log('\n== APPLY (sandbox copy) ==');
  console.log(`entries moved to backup: ${saved.moved.length}; skipped at apply: ${applied.skipped.length}; link conflicts: ${applied.linkConflicts.length}`);
  console.log(`library skills: ${Object.keys(manifest.skills).length}`);
  const lost: string[] = [];
  const changed: string[] = [];
  for (const h of ['claude', 'codex', 'opencode'] as const) {
    for (const [name, hash] of Object.entries(visBefore[h])) {
      if (!(name in visAfter[h])) lost.push(`${h}:${name}`);
      else if (visAfter[h][name] !== hash) changed.push(`${h}:${name}`);
    }
  }
  const gained = (['claude', 'codex', 'opencode'] as const).flatMap((h) => Object.keys(visAfter[h]).filter((n) => !(n in visBefore[h])).map((n) => `${h}:${n}`));
  console.log(`visible before but not after: ${lost.join(', ') || 'none'}`);
  console.log(`visible with different content: ${changed.join(', ') || 'none'}`);
  console.log(`newly visible: ${gained.join(', ') || 'none'}`);
  const afterApply = homeTree();
  const rolled = rollback(saved, paths);
  const after = homeTree();
  const identical = digest(after) === digest(before);
  console.log('\n== ROLLBACK ==');
  console.log(`restored (verified): ${rolled.restored.length}; not restored: ${rolled.notRestored.length}${rolled.notRestored.map((n) => ` [${n.path}: ${n.reason}]`).join('')}`);
  console.log(`library: ${rolled.libraryRestored ? 'restored' : rolled.libraryNote}; links moved aside: ${rolled.removedLinks.length}; folders removed: ${rolled.removedDirs.length}`);
  console.log(`sandbox HOME byte-identical to the pre-plan copy (per-file sha256, kind, link target): ${identical} (${before.length} nodes before the plan, ${afterApply.length} after apply)`);

  // 3. the real folders were only read
  const realAfter = checksums(folders);
  const realUntouched = digest(realAfter) === digest(realBefore);
  console.log('\n== REAL FOLDERS ==');
  for (const folder of folders) console.log(`  ${realBefore[folder]!.slice(0, 16)} -> ${realAfter[folder]!.slice(0, 16)}  ${realBefore[folder] === realAfter[folder] ? 'same' : 'CHANGED'}  ${folder.replace(REAL_HOME, '~')}`);
  console.log(`real folders untouched: ${realUntouched}`);
  if (!planWroteNothing || !identical || !realUntouched || rolled.notRestored.length || lost.length || changed.length) {
    console.error('\nDRY-RUN VERIFICATION FAILED');
    process.exit(1);
  }
  console.log('\nDRY-RUN VERIFICATION PASSED');
  void rootPaths;
}

if (import.meta.main) main();
