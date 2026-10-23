import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ASSETS, loadSettings } from '../shared/config';
import type { Harness, SkillPaths, SkillRoot } from './types';

export const HARNESS_READS = {
  library: [] as const,
  claude: ['claude', 'opencode'] as const,
  codex: ['codex'] as const,
  opencode: ['opencode'] as const,
  agents: ['codex', 'opencode'] as const,
  'claude-synced': ['claude'] as const,
  sparrow: ['claude', 'codex', 'opencode'] as const,
};

function homeExpand(value: string, home: string): string {
  if (value === '~') return home;
  return value.startsWith('~/') ? join(home, value.slice(2)) : value;
}

function rawSkillsDir(env: NodeJS.ProcessEnv, sparrowHome: string): unknown {
  if (env === process.env) {
    return (loadSettings() as ReturnType<typeof loadSettings> & { skills_dir?: unknown }).skills_dir;
  }
  let settings: Record<string, unknown> = {};
  const file = join(sparrowHome, 'config.json');
  try { settings = JSON.parse(requireText(file)) as Record<string, unknown>; } catch {}
  if (env.SPARROW_SETTINGS) {
    try { settings = { ...settings, ...JSON.parse(env.SPARROW_SETTINGS) as Record<string, unknown> }; } catch {}
  }
  return settings.skills_dir;
}

function requireText(path: string): string {
  // Kept behind this helper so malformed or absent settings do not prevent path discovery.
  return readFileSync(path, 'utf8');
}

function configuredPath(value: string | undefined, fallback: string, home: string): string {
  const expanded = homeExpand(value ?? fallback, home);
  return resolve(expanded.startsWith('/') ? expanded : join(home, expanded));
}

export function skillPaths(env: NodeJS.ProcessEnv = process.env): SkillPaths {
  const sandboxHome = env.SPARROW_SKILLS_HOME !== undefined;
  const home = resolve(sandboxHome ? env.SPARROW_SKILLS_HOME! : env.HOME || homedir());
  const sparrowHome = configuredPath(env.SPARROW_HOME, join(home, '.sparrow'), home);
  const claudeBase = sandboxHome
    ? join(home, '.claude')
    : configuredPath(env.CLAUDE_CONFIG_DIR, join(home, '.claude'), home);
  const codexBase = sandboxHome
    ? join(home, '.codex')
    : configuredPath(env.CODEX_HOME, join(home, '.codex'), home);
  const xdgBase = sandboxHome
    ? join(home, '.config')
    : configuredPath(env.XDG_CONFIG_HOME, join(home, '.config'), home);
  const settingsDir = rawSkillsDir(env, sparrowHome);
  const libraryValue = env.SPARROW_SKILLS_DIR ?? (typeof settingsDir === 'string' && settingsDir.trim() ? settingsDir : undefined);
  const library = configuredPath(libraryValue, join(home, 'Skills'), home);
  const roots: Record<SkillRoot, string> = {
    library,
    claude: join(claudeBase, 'skills'),
    codex: join(codexBase, 'skills'),
    opencode: join(xdgBase, 'opencode', 'skills'),
    agents: join(home, '.agents', 'skills'),
    'claude-synced': join(claudeBase, 'skills', 'synced'),
    sparrow: join(ASSETS, 'skills'),
  };
  // Sandbox: everything Sparrow writes stays under SPARROW_SKILLS_HOME (see assertWritable). A `sparrow sandbox` server
  // keeps SPARROW_HOME elsewhere, so its staging and backups live in <home>/.sparrow instead of outside the fence.
  const stateHome = sandboxHome && !inside(sparrowHome, home) ? join(home, '.sparrow') : sparrowHome;
  const backup = join(stateHome, 'skills-backup');
  const staging = join(stateHome, 'skills-staging');
  const desktopSkills = join(home, 'Desktop', 'Skills');
  const externalTargets = [join(home, '.local', 'share', 'terminal-browser')];
  return {
    home, sparrowHome, library, backup, staging, desktopSkills, roots, externalTargets,
    // Desktop/Skills is a migration-only source tree; it is sandboxed by SPARROW_SKILLS_HOME too. ~/.agents/skills is
    // not fenced at all: migration alone may move entries out of it (assertWritable's `extraRoots`).
    writeFences: [
      library, roots.claude, roots.codex, roots.opencode, backup, staging, sparrowHome, desktopSkills,
    ],
    sandboxHome,
  };
}

/**
 * The `.agents/skills` roots a spawned Codex actually reads. Codex runs with the real HOME even when
 * SPARROW_SKILLS_HOME sandboxes Sparrow's own paths, so the real root is included too (only ever read: the
 * driver disables its entries with skills.config).
 */
export function codexAgentsRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [skillPaths(env).roots.agents];
  const real = join(resolve(env.HOME || homedir()), '.agents', 'skills');
  if (!roots.includes(real)) roots.push(real);
  return roots;
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  let real = current;
  try { real = realpathSync.native(current); } catch {}
  return resolve(real, ...tail);
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Real path of `path`, or of its nearest existing ancestor plus the missing tail (works before the folder exists). */
export function realOrPlanned(path: string): string {
  return nearestExisting(path);
}

/** True when the two folders are the same, or one contains the other, by REAL path (and by written path). */
export function overlaps(a: string, b: string): boolean {
  const pair = (x: string, y: string) => inside(x, y) || inside(y, x);
  return pair(resolve(a), resolve(b)) || pair(nearestExisting(a), nearestExisting(b));
}

/**
 * Why the configured library location is unsafe, or null. The library must be a folder of its own: it may not equal,
 * contain or sit inside a harness skills folder (claude, codex, opencode, ~/.agents/skills), a migration source
 * (~/Desktop/Skills), the migration backup folder or Sparrow's own skills. Links between those folders and the library
 * would otherwise loop, and migration would "move" the library into its own backup.
 */
export function libraryProblem(paths: SkillPaths = skillPaths()): string | null {
  const guarded: [string, string][] = [
    ['the Claude skills folder', paths.roots.claude],
    ['the Codex skills folder', paths.roots.codex],
    ['the OpenCode skills folder', paths.roots.opencode],
    ['~/.agents/skills', paths.roots.agents],
    ['~/Desktop/Skills (a migration source)', paths.desktopSkills],
    ['the migration backup folder', paths.backup],
    ['Sparrow\'s own skills', paths.roots.sparrow],
  ];
  for (const [label, path] of guarded) {
    if (!overlaps(paths.library, path)) continue;
    const lib = nearestExisting(paths.library);
    const other = nearestExisting(path);
    const how = lib === other || resolve(paths.library) === resolve(path) ? 'is the same folder as'
      : inside(other, lib) ? 'contains' : 'sits inside';
    return `The skills library (${paths.library}) ${how} ${label} (${path}). Choose a separate folder for it (skills_dir in config.json or SPARROW_SKILLS_DIR, default ~/Skills).`;
  }
  return null;
}

export function assertLibrarySafe(paths: SkillPaths = skillPaths()): void {
  const problem = libraryProblem(paths);
  if (problem) throw new Error(`Refusing write: ${problem}`);
}

const HARNESS_ORDER: Harness[] = ['claude', 'codex', 'opencode'];

/**
 * Harness skill folders that are really the same folder (e.g. ~/.codex/skills -> ~/.claude/skills). They are one root:
 * the first harness of a group (claude, codex, opencode order) owns the links, the others only read them.
 */
export function harnessRootGroups(paths: SkillPaths = skillPaths()): Harness[][] {
  const groups = new Map<string, Harness[]>();
  for (const harness of HARNESS_ORDER) {
    const real = nearestExisting(paths.roots[harness]);
    groups.set(real, [...(groups.get(real) ?? []), harness]);
  }
  return [...groups.values()];
}

/** The harness that owns the links of `harness`'s root (itself unless its folder is an alias of an earlier one). */
export function rootPrimary(harness: Harness, paths: SkillPaths = skillPaths()): Harness {
  return harnessRootGroups(paths).find((group) => group.includes(harness))![0]!;
}

/** Harnesses that read the same physical folder as `harness` (itself included). */
export function rootGroupOf(harness: Harness, paths: SkillPaths = skillPaths()): Harness[] {
  return harnessRootGroups(paths).find((group) => group.includes(harness)) ?? [harness];
}

/** One warning per harness folder that is really another harness's folder (or `~/.agents/skills` aliasing one). */
export function rootAliasWarnings(paths: SkillPaths = skillPaths()): string[] {
  const out: string[] = [];
  for (const group of harnessRootGroups(paths)) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    for (const harness of rest) {
      out.push(`The ${harness} skills folder (${paths.roots[harness]}) is the same folder as the ${first} one (${paths.roots[first!]}): Sparrow treats them as one root, so turning ${harness} off does not remove ${first}'s links.`);
    }
  }
  const agents = nearestExisting(paths.roots.agents);
  for (const harness of HARNESS_ORDER) {
    if (nearestExisting(paths.roots[harness]) === agents) {
      out.push(`~/.agents/skills (${paths.roots.agents}) is the same folder as the ${harness} skills folder: it is treated as that root, not as a separate External source.`);
    }
  }
  return out;
}

/** Refuse writes outside the library, harness skill roots, backup area, and Sparrow home. */
export function assertWritable(path: string, paths: SkillPaths = skillPaths(), extraRoots: string[] = []): string {
  const lexical = resolve(path);
  // Any write that touches an unsafe library location is refused (see libraryProblem).
  if (overlaps(lexical, paths.library)) assertLibrarySafe(paths);
  const realParent = nearestExisting(dirname(lexical));
  const real = resolve(realParent, lexical.slice(dirname(lexical).length + (dirname(lexical).endsWith(sep) ? 0 : 1)));
  const fences = [...paths.writeFences, ...extraRoots].map((f) => ({ lexical: resolve(f), real: nearestExisting(f) }));
  const allowed = fences.some((f) => inside(lexical, f.lexical) && inside(real, f.real));
  const sandboxAllowed = !paths.sandboxHome || inside(lexical, paths.home) && inside(real, nearestExisting(paths.home));
  if (!allowed || !sandboxAllowed) throw new Error(`Refusing write outside the skills fence: ${path}`);
  // Check existing parent components as well; dangling or redirected ancestors must not escape a fence.
  let parent = dirname(lexical);
  while (parent !== dirname(parent)) {
    if (existsSync(parent)) {
      let st;
      try { st = statSync(parent); } catch { throw new Error(`Refusing write through an unresolved parent: ${parent}`); }
      if (st.isDirectory()) break;
    }
    parent = dirname(parent);
  }
  return lexical;
}
