import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isReservedSkillName, parseSkillFrontmatter } from './frontmatter';
import { ensureLibrary } from './git';
import { readManifest, writeManifest } from './manifest';
import { assertWritable, skillPaths } from './paths';
import { folderHash } from './hash';
import { sync as syncLinks } from './link';
import type { Harness, SkillPaths, SkillProblem } from './types';

export const MAX_IMPORT_FILES = 2_000;
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_TOTAL_BYTES = 100 * 1024 * 1024;
export const STAGED_IMPORT_TTL_MS = 30 * 60 * 1000;
export const GIT_TIMEOUT_MS = 120_000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);
const AGENT_SKILL_DIRS = [
  '.agents/skills', '.claude/skills', '.cline/skills', '.codebuddy/skills', '.codex/skills',
  '.commandcode/skills', '.continue/skills', '.factory/skills', '.github/skills', '.goose/skills',
  '.grok/skills', '.iflow/skills', '.junie/skills', '.kilo/skills', '.kilocode/skills', '.kimchi/skills',
  '.kiro/skills', '.minimax/skills', '.mux/skills', '.neovate/skills', '.opencode/skills',
  '.openhands/skills', '.pi/skills', '.posit/assistant/skills', '.qoder/skills', '.roo/skills',
  '.trae/skills', '.windsurf/skills', '.zcode/skills', '.zencoder/skills',
];
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HARNESS_NAMES = new Set<Harness>(['claude', 'codex', 'opencode']);

export class SkillImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface ParsedSource {
  type: 'github' | 'gitlab' | 'git' | 'local';
  url: string;
  source: string;
  ref?: string;
  subpath?: string;
  localPath?: string;
  skillFilter?: string;
  treePath?: string;
}

export interface StagedSource {
  source: string;
  sourceType: ParsedSource['type'];
  sourceUrl: string;
  ref?: string;
  subpath?: string;
  skillFilter?: string;
}

export interface StagedScript {
  path: string;
  executable: boolean;
  shebang: string | null;
  scriptsDirectory: boolean;
}

export interface StagedSkill {
  /** The library folder name the skill is imported under (Vercel's `skills` naming, see libraryName). */
  name: string;
  description: string;
  problems: SkillProblem[];
  /** Importable, but worth a look in the preview (e.g. the folder name differs from the skill name). */
  warnings: string[];
  files: { path: string; size: number }[];
  scripts: string[];
  scriptDetails: StagedScript[];
}

export interface StagedImport {
  id: string;
  skills: StagedSkill[];
  source?: StagedSource;
  problems?: SkillProblem[];
  notices?: string[];
}

interface StageMeta {
  id: string;
  createdAt: number;
  contentDir: 'repo';
  source: StagedSource;
  kind: 'git' | 'local' | 'upload';
  gitUrl?: string;
  gitRef?: string;
  ignoredSymlinks?: string[];
  notices?: string[];
}

interface SkillCandidate extends StagedSkill {
  directory: string;
  /** Folder name and frontmatter name as written: either one selects the skill in `repo@skill`. */
  aliases: string[];
  skillPath: string;
  skippedGit: boolean;
}

function fail(message: string): never { throw new SkillImportError(message); }

export { isReservedSkillName };

function normalizeSubpath(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return fail('Source subpath contains invalid percent encoding.'); }
  const parts = decoded.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) fail('Unsafe source subpath: ' + value);
  return parts.join('/');
}

function ownerRepoUrl(owner: string, repo: string): string {
  const cleanRepo = repo.replace(/\.git$/i, '');
  if (!owner || !cleanRepo || /[\0\\/]/.test(owner + cleanRepo)) fail('Source must include a valid owner and repository.');
  return 'https://github.com/' + owner + '/' + cleanRepo + '.git';
}

function sourceIdFromUrl(value: string): string {
  if (/^git@[^:]+:.+/.test(value)) return value.slice(value.indexOf(':') + 1).replace(/\.git$/i, '');
  if (/^ssh:\/\//i.test(value)) {
    try { const parsed = new URL(value); return parsed.host + parsed.pathname.replace(/\.git$/i, ''); } catch {}
  }
  return value;
}

function localSource(value: string, env: NodeJS.ProcessEnv): ParsedSource {
  const home = resolve(env.HOME || homedir());
  const localPath = resolve(value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value);
  return { type: 'local', url: localPath, source: localPath, localPath };
}

/** Parse common Vercel skills source forms, including local ~/ paths. */
export function parseSource(input: string, env: NodeJS.ProcessEnv = process.env): ParsedSource {
  let value = input.trim();
  if (!value || value.includes('\0')) fail('Source must be a non-empty string without NUL bytes.');
  if (value.startsWith('~/') || value === '~' || isAbsolute(value) || value.startsWith('./') || value.startsWith('../')
    || value === '.' || value === '..' || /^[a-zA-Z]:[/\\]/.test(value)) return localSource(value, env);

  if (value === 'coinbase/agentWallet') value = 'coinbase/agentic-wallet-skills';
  if (value === 'vercel-labs/vercel-skills') value = 'vercel-labs/agent-skills';
  if (value.startsWith('github:')) return parseSource(value.slice(7), env);
  if (value.startsWith('gitlab:')) value = 'https://gitlab.com/' + value.slice(7);
  if (/^github\.com\//i.test(value)) value = 'https://' + value;
  if (/^gitlab\.com\//i.test(value)) value = 'https://' + value;

  let fragmentRef: string | undefined;
  let fragmentSkill: string | undefined;
  const hashAt = value.indexOf('#');
  if (hashAt >= 0) {
    const fragment = value.slice(hashAt + 1);
    value = value.slice(0, hashAt);
    if (fragment) {
      const marker = fragment.indexOf('@');
      try {
        fragmentRef = decodeURIComponent(marker < 0 ? fragment : fragment.slice(0, marker));
        fragmentSkill = marker < 0 ? undefined : decodeURIComponent(fragment.slice(marker + 1));
      } catch { fail('Source fragment contains invalid percent encoding.'); }
    }
  }

  const inline = value.match(/^([^/:@]+)\/([^/:@]+)@(.+)$/);
  if (inline && !value.includes('://')) {
    return {
      type: 'github', url: ownerRepoUrl(inline[1]!, inline[2]!), source: inline[1] + '/' + inline[2]!.replace(/\.git$/i, ''),
      ...(fragmentRef ? { ref: fragmentRef } : {}), skillFilter: fragmentSkill || inline[3],
    };
  }
  const shorthand = value.match(/^([^/:@]+)\/([^/:@]+)(?:\/(.+))?\/?$/);
  if (shorthand && !value.includes('://')) {
    const subpath = shorthand[3] ? normalizeSubpath(shorthand[3]) : undefined;
    return {
      type: 'github', url: ownerRepoUrl(shorthand[1]!, shorthand[2]!), source: shorthand[1] + '/' + shorthand[2]!.replace(/\.git$/i, ''),
      ...(fragmentRef ? { ref: fragmentRef } : {}), ...(subpath ? { subpath } : {}),
      ...(fragmentSkill ? { skillFilter: fragmentSkill } : {}),
    };
  }

  let url: URL | null = null;
  try { url = new URL(value); } catch {}
  if (url && ['http:', 'https:'].includes(url.protocol)) {
    const parts = url.pathname.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch { return fail('Source URL contains invalid percent encoding.'); }
    });
    if (url.hostname.toLowerCase() === 'github.com' && parts.length >= 2) {
      const owner = parts[0]!;
      const repo = parts[1]!.replace(/\.git$/i, '');
      const cloneUrl = 'https://github.com/' + owner + '/' + repo + '.git';
      if (parts[2] === 'tree' && parts.length > 3) {
        return {
          type: 'github', url: cloneUrl, source: owner + '/' + repo, treePath: normalizeSubpath(parts.slice(3).join('/')),
          ...(fragmentRef ? { ref: fragmentRef } : {}), ...(fragmentSkill ? { skillFilter: fragmentSkill } : {}),
        };
      }
      return { type: 'github', url: cloneUrl, source: owner + '/' + repo,
        ...(fragmentRef ? { ref: fragmentRef } : {}), ...(fragmentSkill ? { skillFilter: fragmentSkill } : {}) };
    }
    const marker = parts.findIndex((part) => part === '-');
    if (url.hostname.toLowerCase().endsWith('gitlab.com') && marker >= 0 && parts[marker + 1] === 'tree' && parts.length > marker + 2) {
      const repoPath = parts.slice(0, marker).join('/').replace(/\.git$/i, '');
      const cloneUrl = url.protocol + '//' + url.host + '/' + repoPath + '.git';
      return {
        type: 'gitlab', url: cloneUrl, source: cloneUrl.replace(/\.git$/, ''),
        treePath: normalizeSubpath(parts.slice(marker + 2).join('/')),
        ...(fragmentRef ? { ref: fragmentRef } : {}), ...(fragmentSkill ? { skillFilter: fragmentSkill } : {}),
      };
    }
    if (url.hostname.toLowerCase() === 'gitlab.com' && parts.length >= 2) {
      const cloneUrl = 'https://gitlab.com/' + parts.join('/').replace(/\.git$/i, '') + '.git';
      return { type: 'gitlab', url: cloneUrl, source: cloneUrl.replace(/\.git$/, ''),
        ...(fragmentRef ? { ref: fragmentRef } : {}), ...(fragmentSkill ? { skillFilter: fragmentSkill } : {}) };
    }
    if (/\.git$/i.test(url.pathname)) {
      return { type: 'git', url: value, source: value,
        ...(fragmentRef ? { ref: fragmentRef } : {}), ...(fragmentSkill ? { skillFilter: fragmentSkill } : {}) };
    }
    fail('Unsupported source URL: ' + input);
  }
  if (/^file:/i.test(value)) fail('file:// sources are not supported. Use a local directory path instead.');
  if (/^(?:ext::|fd::)/i.test(value)) fail('Git ext and fd transports are not supported.');
  if (/^(?:git@[^:]+:.+|ssh:\/\/[^/]+\/.+|git:\/\/.+)$/i.test(value)) {
    return { type: 'git', url: value, source: sourceIdFromUrl(value),
      ...(fragmentRef ? { ref: fragmentRef } : {}), ...(fragmentSkill ? { skillFilter: fragmentSkill } : {}) };
  }
  fail('Unsupported source format: ' + input);
}

function stageRoot(paths: SkillPaths): string {
  const root = assertWritable(paths.staging, paths);
  mkdirSync(root, { recursive: true });
  return root;
}

function stagePath(id: string, paths: SkillPaths): string {
  if (!UUID_RE.test(id)) fail('Invalid staged import id.');
  return join(stageRoot(paths), 'import-' + id);
}

function writeJson(path: string, value: unknown, paths: SkillPaths): void {
  writeFileSync(assertWritable(path, paths), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

export function cleanupExpiredStaging(paths: SkillPaths = skillPaths(), now = Date.now()): number {
  const root = stageRoot(paths);
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!/^import-[0-9a-f-]{36}$/i.test(name)) continue;
    const dir = join(root, name);
    let createdAt: number;
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'stage.json'), 'utf8')) as StageMeta;
      if (name !== 'import-' + meta.id || !UUID_RE.test(meta.id) || !Number.isFinite(meta.createdAt)) continue;
      createdAt = meta.createdAt;
    } catch {
      try { createdAt = statSync(dir).mtimeMs; } catch { continue; }
    }
    if (now - createdAt < STAGED_IMPORT_TTL_MS) continue;
    rmSync(assertWritable(dir, paths), { recursive: true, force: false });
    removed++;
  }
  return removed;
}

function createStage(paths: SkillPaths): { id: string; directory: string } {
  cleanupExpiredStaging(paths);
  const id = randomUUID();
  const directory = assertWritable(stagePath(id, paths), paths);
  mkdirSync(directory, { recursive: false });
  return { id, directory };
}

function abandonStage(directory: string, paths: SkillPaths): void {
  try {
    const root = resolve(stageRoot(paths));
    const target = resolve(directory);
    if (dirname(target) === root && /^import-[0-9a-f-]{36}$/i.test(basename(target))) {
      rmSync(assertWritable(target, paths), { recursive: true, force: true });
    }
  } catch {}
}

function loadMeta(id: string, paths: SkillPaths): { directory: string; meta: StageMeta } {
  cleanupExpiredStaging(paths);
  const directory = stagePath(id, paths);
  if (!existsSync(directory)) throw new SkillImportError('Staged import has expired or does not exist: ' + id, 404);
  let meta: StageMeta;
  try { meta = JSON.parse(readFileSync(join(directory, 'stage.json'), 'utf8')) as StageMeta; }
  catch { throw new SkillImportError('Staged import metadata is missing or invalid.', 404); }
  if (meta.id !== id || !UUID_RE.test(meta.id) || meta.contentDir !== 'repo') throw new SkillImportError('Staged import metadata is invalid.', 404);
  return { directory, meta };
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function hasSkillMd(path: string): boolean {
  try { return lstatSync(join(path, 'SKILL.md')).isFile(); } catch { return false; }
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function realPathInside(path: string, rootReal: string, rootLexical: string): string | null {
  try {
    const absolute = resolve(path);
    const lexicalRoot = resolve(rootLexical);
    if (!inside(absolute, lexicalRoot)) return null;
    let current = lexicalRoot;
    const rel = relative(lexicalRoot, absolute);
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    const real = realpathSync.native(path);
    return inside(real, rootReal) ? real : null;
  } catch { return null; }
}

function sortedEntries(path: string): string[] {
  try { return readdirSync(path).sort((a, b) => a.localeCompare(b)); } catch { return []; }
}

function walkCandidates(container: string, maxDepth: number, output: string[], rootReal: string, rootLexical: string, problems: SkillProblem[]): void {
  let containerStat;
  try { containerStat = lstatSync(container); } catch { return; }
  if (containerStat.isSymbolicLink()) {
    problems.push({ code: 'symlink-source', message: 'A symlinked skill search container was skipped: ' + container });
    return;
  }
  if (!containerStat.isDirectory() || !realPathInside(container, rootReal, rootLexical)) {
    problems.push({ code: 'source-escape', message: 'A skill search container resolved outside the source and was skipped: ' + container });
    return;
  }
  const visit = (current: string, depth: number) => {
    if (depth >= maxDepth) return;
    for (const name of sortedEntries(current)) {
      const child = join(current, name);
      let stat;
      try { stat = lstatSync(child); } catch { continue; }
      if (stat.isSymbolicLink()) {
        problems.push({ code: 'symlink-source', message: 'A symlink source entry was skipped: ' + relative(container, child).split(sep).join('/') });
        continue;
      }
      if (SKIP_DIRS.has(name)) continue;
      if (!stat.isDirectory()) continue;
      if (!realPathInside(child, rootReal, rootLexical)) {
        problems.push({ code: 'source-escape', message: 'A directory resolved outside the source and was skipped: ' + relative(container, child).split(sep).join('/') });
        continue;
      }
      const marker = join(child, 'SKILL.md');
      let markerStat;
      try { markerStat = lstatSync(marker); } catch {}
      if (markerStat?.isFile() || markerStat?.isSymbolicLink()) output.push(child);
      else visit(child, depth + 1);
    }
  };
  visit(container, 0);
}

function discoverDirectories(base: string, subpath?: string): { directories: string[]; problems: SkillProblem[] } {
  const problems: SkillProblem[] = [];
  const rootReal = realpathSync.native(base);
  const search = subpath ? join(base, ...subpath.split('/')) : base;
  // lstat, not existsSync: a symlink source (even a dangling one) is reported as a symlink, never followed.
  let searchStat;
  try { searchStat = lstatSync(search); } catch { fail('Source subpath does not exist: ' + (subpath || 'source')); }
  if (searchStat!.isSymbolicLink()) {
    problems.push({ code: 'symlink-source', message: 'A symlink source path was skipped: ' + (subpath || '.') });
    return { directories: [], problems };
  }
  if (!realPathInside(search, rootReal, base)) {
    problems.push({ code: 'source-escape', message: 'Source path resolves outside the repository and was skipped: ' + (subpath || '.') });
    return { directories: [], problems };
  }
  let markerStat;
  try { markerStat = lstatSync(join(search, 'SKILL.md')); } catch {}
  if (markerStat?.isFile() || markerStat?.isSymbolicLink()) return { directories: [search], problems };
  const candidates: string[] = [];
  walkCandidates(search, 1, candidates, rootReal, base, problems);
  const priority = [
    join(search, 'skills'), join(search, 'skills', '.curated'), join(search, 'skills', '.experimental'),
    join(search, 'skills', '.system'), ...AGENT_SKILL_DIRS.map((path) => join(search, ...path.split('/'))),
  ];
  for (const container of priority) walkCandidates(container, 3, candidates, rootReal, base, problems);
  if (!candidates.length) walkCandidates(search, 5, candidates, rootReal, base, problems);
  return { directories: [...new Set(candidates.map((path) => resolve(path)))], problems };
}

/**
 * The library name of a skill: its frontmatter `name`, cleaned the way Vercel's `skills` tool does for the folder it
 * installs into (sanitizeName in vercel-labs/skills: lowercase, runs of other characters become "-", leading and
 * trailing "-" dropped). The folder the skill sits in is irrelevant to Vercel and to us. Sparrow's name rule is a bit
 * stricter (no "." or "_", at most 64 characters, the Agent Skills spec), so those become "-" as well.
 */
export function libraryName(frontmatterName: string): string {
  return frontmatterName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
}

function validateName(name: string): string[] {
  const problems: string[] = [];
  if (name.length < 1 || name.length > 64) problems.push('name must be 1–64 characters');
  if (!NAME_RE.test(name)) problems.push('name must use lowercase letters, digits, and single hyphens only');
  if (isReservedSkillName(name)) problems.push('name is reserved for a built-in Sparrow skill');
  return problems;
}

function collectSkillFiles(directory: string, ignoredSymlinks: string[] = []): {
  files: { path: string; size: number }[]; scripts: string[]; scriptDetails: StagedScript[]; total: number; problems: SkillProblem[]; skippedGit: boolean;
} {
  const files: { path: string; size: number }[] = [];
  const scripts: string[] = [];
  const scriptDetails: StagedScript[] = [];
  const problems: SkillProblem[] = [];
  const ignoredSet = new Set(ignoredSymlinks);
  let skippedGit = false;
  let total = 0;
  const visit = (current: string) => {
    for (const name of sortedEntries(current)) {
      const absolute = join(current, name);
      const rel = relative(directory, absolute).split(sep).join('/');
      validateRelativePath(rel);
      if (rel.split('/').some((part) => part === '.' || part === '..')) fail('Unsafe skill file path: ' + rel);
      let stat;
      try { stat = lstatSync(absolute); } catch { fail('Could not inspect skill file: ' + rel); }
      if (stat!.isSymbolicLink()) {
        problems.push({ code: 'symlink-entry', message: 'Symlink entry was skipped: ' + rel });
        continue;
      }
      if (name === '.git') { skippedGit = true; continue; }
      if (stat!.isDirectory()) { visit(absolute); continue; }
      if (!stat!.isFile()) fail('Device or special files are not allowed in imported skills: ' + rel);
      if (stat!.size > MAX_IMPORT_FILE_BYTES) fail('Skill file exceeds ' + MAX_IMPORT_FILE_BYTES + ' bytes: ' + rel);
      total += stat!.size;
      if (files.length >= MAX_IMPORT_FILES) fail('Skill contains more than ' + MAX_IMPORT_FILES + ' files.');
      if (total > MAX_IMPORT_TOTAL_BYTES) fail('Skill files exceed ' + MAX_IMPORT_TOTAL_BYTES + ' total bytes.');
      files.push({ path: rel, size: stat!.size });
      const firstLine = readFileSync(absolute).subarray(0, 256).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
      const shebang = firstLine.startsWith('#!') ? firstLine : null;
      const executable = (stat!.mode & 0o111) !== 0;
      const scriptsDirectory = rel.startsWith('scripts/');
      if (scriptsDirectory || shebang || executable) {
        scripts.push(rel);
        scriptDetails.push({ path: rel, executable, shebang, scriptsDirectory });
      }
    }
  };
  visit(directory);
  for (const rel of ignoredSet) problems.push({ code: 'symlink-entry', message: 'Symlink entry was skipped: ' + rel });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, scripts: [...new Set(scripts)].sort((a, b) => a.localeCompare(b)), scriptDetails, total, problems, skippedGit };
}

function inspectCandidates(repoDir: string, subpath?: string, skillFilter?: string, ignoredSymlinks: string[] = []): { candidates: SkillCandidate[]; problems: SkillProblem[]; notices: string[] } {
  const discovery = discoverDirectories(repoDir, subpath);
  const directories = discovery.directories;
  const result: SkillCandidate[] = [];
  const firstByName = new Map<string, SkillCandidate>();
  const mirrors: string[] = [];
  let totalFiles = 0, totalBytes = 0;
  for (const directory of directories) {
    if (!realPathInside(directory, realpathSync.native(repoDir), repoDir)) {
      discovery.problems.push({ code: 'source-escape', message: 'A discovered skill resolved outside the repository and was skipped.' });
      continue;
    }
    const skillMd = join(directory, 'SKILL.md');
    const relativeDir = relative(repoDir, directory).split(sep).join('/');
    const raw = isRegularFile(skillMd) ? readFileSync(skillMd, 'utf8') : '';
    const parsed = isRegularFile(skillMd) ? parseSkillFrontmatter(raw) : {
      frontmatter: null, body: '', problems: [{ code: 'skill-md-file', message: 'SKILL.md must be a regular file; symlinks are not allowed' }],
    };
    const written = parsed.frontmatter?.name;
    const folderName = basename(directory);
    const name = typeof written === 'string' ? libraryName(written) : folderName;
    // Same library name as an earlier skill: a byte-identical copy (the same skill mirrored under .claude/skills and
    // skills/) is one skill, noted below; anything else is a real collision, shown with a problem, never dropped.
    const earlier = firstByName.get(name);
    if (earlier && folderHash(earlier.directory) === folderHash(directory)) {
      mirrors.push(earlier.skillPath.replace(/SKILL\.md$/, '').replace(/\/$/, '') || '.');
      continue;
    }
    // The name is judged after cleaning (validateName below), and a folder name that differs is only a warning.
    const problems = parsed.problems.filter((problem) => problem.code !== 'name-format' && problem.code !== 'name-length' && problem.code !== 'name-folder');
    const warnings: string[] = [];
    if (typeof written === 'string' && written !== name) warnings.push('The name "' + written + '" is imported as "' + name + '" (lowercased and cleaned like Vercel\'s skills tool).');
    if (relativeDir && typeof written === 'string' && folderName !== name) {
      warnings.push('The folder "' + folderName + '" differs from the skill name: it is imported as "' + name + '", like Vercel\'s skills tool.');
    }
    for (const message of validateName(name)) problems.push({ code: 'name-invalid', message });
    if (earlier) {
      problems.push({ code: 'name-collision', message: 'Imported under the same name "' + name + '" as ' + earlier.skillPath
        + ': it cannot be imported with that skill. Import only one of them, or change the name in its SKILL.md.' });
    }
    if (typeof parsed.frontmatter?.description === 'string'
      && (parsed.frontmatter.description.length < 1 || parsed.frontmatter.description.length > 1024)) {
      problems.push({ code: 'description-length', message: 'description must be 1–1024 characters' });
    }
    const ignoredForSkill = ignoredSymlinks
      .filter((path) => path.startsWith(relativeDir + '/'))
      .map((path) => path.slice(relativeDir.length + 1));
    const collected = collectSkillFiles(directory, ignoredForSkill);
    problems.push(...collected.problems);
    totalFiles += collected.files.length;
    totalBytes += collected.total;
    if (totalFiles > MAX_IMPORT_FILES) fail('Source contains more than ' + MAX_IMPORT_FILES + ' skill files.');
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) fail('Source skill files exceed ' + MAX_IMPORT_TOTAL_BYTES + ' total bytes.');
    const candidate: SkillCandidate = {
      name, description: parsed.frontmatter?.description ?? '', problems, warnings, files: collected.files, scripts: collected.scripts,
      scriptDetails: collected.scriptDetails, aliases: [...new Set([name, folderName, ...(typeof written === 'string' ? [written] : [])])],
      directory, skillPath: (relativeDir ? relativeDir + '/' : '') + 'SKILL.md', skippedGit: collected.skippedGit,
    };
    result.push(candidate);
    if (!earlier) firstByName.set(name, candidate);
  }
  const filtered = skillFilter ? result.filter((item) => item.aliases.includes(skillFilter)) : result;
  for (const path of ignoredSymlinks) {
    if (!directories.some((directory) => path.startsWith(relative(repoDir, directory).split(sep).join('/') + '/'))) {
      discovery.problems.push({ code: 'symlink-source', message: 'A symlink source entry was skipped: ' + path });
    }
  }
  if (skillFilter && !filtered.length && result.length) fail('No skill named "' + skillFilter + '" was found in the source.');
  if (!filtered.length && !discovery.problems.length) fail('No SKILL.md folders were found in ' + (subpath || 'the source') + '.');
  const notices = filtered.some((item) => item.skippedGit) ? ['Nested .git directories are skipped and will not be imported.'] : [];
  if (mirrors.length) notices.push('Identical copies of a skill were listed once: ' + [...new Set(mirrors)].join(', ') + '.');
  return { candidates: filtered, problems: discovery.problems, notices };
}

function publicImport(id: string, meta: StageMeta, repoDir: string): StagedImport {
  const inspected = inspectCandidates(repoDir, meta.source.subpath, meta.source.skillFilter, meta.ignoredSymlinks);
  return {
    id, source: meta.source,
    skills: inspected.candidates.map(({ directory: _directory, skillPath: _skillPath, skippedGit: _skippedGit, aliases: _aliases, ...skill }) => skill),
    ...(inspected.problems.length ? { problems: inspected.problems } : {}),
    ...(inspected.notices.length || meta.notices?.length ? { notices: [...new Set([...inspected.notices, ...(meta.notices ?? [])])] } : {}),
  };
}

export function stagedImport(id: string, paths: SkillPaths = skillPaths()): StagedImport {
  const { directory, meta } = loadMeta(id, paths);
  return publicImport(id, meta, join(directory, meta.contentDir));
}

async function runGit(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.symlinks', GIT_CONFIG_VALUE_1: 'true',
    GIT_CONFIG_KEY_2: 'filter.lfs.smudge', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'filter.lfs.required', GIT_CONFIG_VALUE_3: 'false',
    GIT_CONFIG_KEY_4: 'submodule.recurse', GIT_CONFIG_VALUE_4: 'false',
  };
  const proc = Bun.spawn(['git', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env, detached: process.platform !== 'win32' });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), timeoutMs); });
  const exit = await Promise.race([proc.exited, timedOut]);
  if (timer) clearTimeout(timer);
  if (exit === null) {
    if (process.platform !== 'win32') {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill(); }
    } else proc.kill();
    // A remote helper can inherit the pipes. Do not hold the HTTP request open waiting for EOF.
    void proc.exited.catch(() => {});
    void stdout.catch(() => {});
    void stderr.catch(() => {});
    throw new SkillImportError('Git command timed out after ' + timeoutMs + ' ms.');
  }
  return { code: exit, stdout: await stdout, stderr: await stderr };
}

async function lsRemote(url: string, timeoutMs = 30_000): Promise<string> {
  if (/^(?:ext::|fd::|file:)/i.test(url)) fail('Git ext, fd, and file transports are not supported.');
  const result = await runGit(['ls-remote', '--heads', '--tags', '--', url], timeoutMs);
  if (result.code !== 0) fail('Could not list refs for source: ' + (result.stderr.trim() || result.stdout.trim()));
  return result.stdout;
}

export function resolveTreePath(treePath: string, refsText: string): { ref: string; subpath?: string } {
  const refs = new Set<string>();
  for (const line of refsText.split(/\r?\n/)) {
    const ref = line.split('\t')[1]?.trim();
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) refs.add(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/tags/') && !ref.endsWith('^{}')) refs.add(ref.slice('refs/tags/'.length));
  }
  const matches = [...refs].filter((ref) => treePath === ref || treePath.startsWith(ref + '/')).sort((a, b) => b.length - a.length);
  if (!matches.length) fail('Could not resolve a Git ref in tree path "' + treePath + '".');
  const ref = matches[0]!;
  const rest = treePath === ref ? '' : treePath.slice(ref.length + 1);
  return { ref, ...(rest ? { subpath: normalizeSubpath(rest) } : {}) };
}

async function cloneRepo(url: string, target: string, ref: string | undefined, paths: SkillPaths, timeoutMs = GIT_TIMEOUT_MS): Promise<void> {
  if (/^(?:ext::|fd::|file:)/i.test(url)) fail('Git ext, fd, and file transports are not supported.');
  if (!/^(?:https?:|ssh:|git:|git@)/i.test(url)) fail('Unsupported Git transport: ' + url);
  assertWritable(target, paths);
  const args = [
    'clone', '--depth', '1', '--no-checkout', '--no-recurse-submodules',
    '--config', 'core.hooksPath=/dev/null', '--config', 'core.symlinks=true',
    '--config', 'filter.lfs.smudge=', '--config', 'filter.lfs.required=false',
  ];
  const sha = !!ref && /^[0-9a-f]{40}$/i.test(ref);
  if (ref && !sha) args.push('--branch', ref);
  args.push('--', url, target);
  const cloned = await runGit(args, timeoutMs);
  if (cloned.code !== 0) fail('Could not clone source: ' + (cloned.stderr.trim() || cloned.stdout.trim()));
  if (sha) {
    const fetched = await runGit(['-C', target, 'fetch', '--depth', '1', 'origin', ref!], timeoutMs);
    if (fetched.code !== 0) fail('Could not fetch source ref ' + ref + ': ' + (fetched.stderr.trim() || fetched.stdout.trim()));
    const checkout = await runGit(['-C', target, 'checkout', '--detach', '--force', ref!], timeoutMs);
    if (checkout.code !== 0) fail('Could not check out source ref ' + ref + ': ' + (checkout.stderr.trim() || checkout.stdout.trim()));
  } else {
    const checkout = await runGit(['-C', target, 'checkout', '--detach', '--force', 'HEAD'], timeoutMs);
    if (checkout.code !== 0) fail('Could not check out cloned source: ' + (checkout.stderr.trim() || checkout.stdout.trim()));
  }
}

async function normalizeGitFileModes(repoDir: string, skillDirectories: string[], timeoutMs: number): Promise<void> {
  if (!skillDirectories.length) return;
  const repoReal = realpathSync.native(repoDir);
  const roots = skillDirectories.map((directory) => relative(repoDir, directory).split(sep).join('/'));
  const pathspecs = roots.filter(Boolean).map((root) => ':(literal)' + root);
  const args = ['-C', repoDir, 'ls-tree', '-rz', '--full-tree', 'HEAD'];
  if (!roots.includes('')) args.push('--', ...pathspecs);
  const tree = await runGit(args, timeoutMs);
  if (tree.code !== 0) fail('Could not read Git file modes: ' + (tree.stderr.trim() || tree.stdout.trim()));

  for (const record of tree.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) fail('Git returned a malformed tree entry while reading file modes.');
    const [mode, type] = record.slice(0, tab).split(' ');
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    const path = validateRelativePath(record.slice(tab + 1));
    if (path.split('/').includes('.git') || !roots.some((root) => !root || inside(path, root))) continue;
    const absolute = join(repoDir, ...path.split('/'));
    if (!realPathInside(absolute, repoReal, repoDir)) continue;
    let stat;
    try { stat = lstatSync(absolute); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    // Git tracks executable as 100755 or 100644. Normalize checkout modes explicitly so
    // core.filemode and the process umask cannot change what preview or import observes.
    chmodSync(absolute, mode === '100755' ? 0o755 : 0o644);
  }
}

function validateRelativePath(path: string): string {
  if (!path || /[\u0000-\u001f\u007f-\u009f]/.test(path)) fail('File path contains control characters.');
  if (Buffer.byteLength(path, 'utf8') > 4096) fail('File path is too long (max 4096 UTF-8 bytes).');
  if (path.includes('\\') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) fail('Unsafe relative path: ' + path);
  const pieces = path.split('/');
  if (pieces.some((part) => !part || part === '.' || part === '..')) fail('Unsafe relative path: ' + path);
  if (pieces.some((part) => Buffer.byteLength(part, 'utf8') > 255)) fail('File name is too long (max 255 UTF-8 bytes per path component).');
  return pieces.join('/');
}

function copyTree(source: string, target: string, paths: SkillPaths, limits = true): { files: number; bytes: number; ignoredSymlinks: string[]; skippedGit: string[] } {
  let count = 0, bytes = 0;
  const ignoredSymlinks: string[] = [], skippedGit: string[] = [];
  const visit = (from: string, rel = '') => {
    for (const name of sortedEntries(from)) {
      const fromPath = join(from, name);
      const relativePath = validateRelativePath(rel ? rel + '/' + name : name);
      const toPath = join(target, ...relativePath.split('/'));
      let stat;
      try { stat = lstatSync(fromPath); } catch { fail('Could not inspect source path: ' + relativePath); }
      if (stat!.isSymbolicLink()) { ignoredSymlinks.push(relativePath); continue; }
      if (name === '.git') { skippedGit.push(relativePath); continue; }
      if (stat!.isDirectory()) {
        mkdirSync(assertWritable(toPath, paths), { recursive: true, mode: 0o755 });
      } else if (stat!.isFile()) {
        count++;
        bytes += stat!.size;
        if (limits && count > MAX_IMPORT_FILES) fail('Source contains more than ' + MAX_IMPORT_FILES + ' files.');
        if (stat!.size > MAX_IMPORT_FILE_BYTES) fail('Source file exceeds ' + MAX_IMPORT_FILE_BYTES + ' bytes: ' + relativePath);
        if (limits && bytes > MAX_IMPORT_TOTAL_BYTES) fail('Source exceeds ' + MAX_IMPORT_TOTAL_BYTES + ' total bytes.');
        const data = readFileSync(fromPath);
        const writePath = assertWritable(toPath, paths);
        mkdirSync(assertWritable(dirname(writePath), paths), { recursive: true, mode: 0o755 });
        const mode = 0o644 | (stat!.mode & 0o111);
        writeFileSync(writePath, data, { mode, flag: 'wx' });
        chmodSync(writePath, mode);
      } else fail('Device or special files are not allowed in imports: ' + relativePath);
      if (stat!.isDirectory()) visit(fromPath, relativePath);
    }
  };
  mkdirSync(assertWritable(target, paths), { recursive: true, mode: 0o755 });
  visit(source);
  return { files: count, bytes, ignoredSymlinks, skippedGit };
}

function sourceInfo(source: ParsedSource, ref = source.ref, subpath = source.subpath): StagedSource {
  return {
    source: source.source, sourceType: source.type, sourceUrl: source.url,
    ...(ref ? { ref } : {}), ...(subpath ? { subpath } : {}), ...(source.skillFilter ? { skillFilter: source.skillFilter } : {}),
  };
}

export async function previewSource(input: string, paths: SkillPaths = skillPaths(), env: NodeJS.ProcessEnv = process.env, timeoutMs = GIT_TIMEOUT_MS): Promise<StagedImport> {
  const parsed = parseSource(input, env);
  const created = createStage(paths);
  const repoDir = join(created.directory, 'repo');
  let ref = parsed.ref, subpath = parsed.subpath;
  try {
    let kind: StageMeta['kind'] = 'local';
    let ignoredSymlinks: string[] = [];
    let notices: string[] = [];
    if (parsed.type === 'local') {
      const realLocal = realpathSync.native(parsed.localPath!);
      const stat = lstatSync(realLocal);
      if (!stat.isDirectory()) fail('Local skill source must be a directory.');
      const copied = copyTree(realLocal, repoDir, paths);
      ignoredSymlinks = copied.ignoredSymlinks;
      if (copied.skippedGit.length) notices.push('Nested .git directories are skipped and will not be imported.');
    } else {
      kind = 'git';
      if (parsed.treePath) {
        const resolved = resolveTreePath(parsed.treePath, await lsRemote(parsed.url, Math.min(timeoutMs, 30_000)));
        ref = resolved.ref;
        subpath = resolved.subpath;
      }
      await cloneRepo(parsed.url, repoDir, ref, paths, timeoutMs);
    }
    const parsedWithPath = { ...parsed, ...(subpath ? { subpath } : {}) };
    const source = sourceInfo(parsedWithPath, ref, subpath);
    if (kind === 'git') {
      const candidates = inspectCandidates(repoDir, subpath, parsed.skillFilter).candidates;
      await normalizeGitFileModes(repoDir, candidates.map((candidate) => candidate.directory), timeoutMs);
    }
    const meta: StageMeta = {
      id: created.id, createdAt: Date.now(), contentDir: 'repo', source, kind,
      ...(ignoredSymlinks.length ? { ignoredSymlinks } : {}), ...(notices.length ? { notices } : {}),
      ...(kind === 'git' ? { gitUrl: parsed.url, ...(ref ? { gitRef: ref } : {}) } : {}),
    };
    const staged = publicImport(created.id, meta, repoDir);
    writeJson(join(created.directory, 'stage.json'), meta, paths);
    return staged;
  } catch (error) {
    abandonStage(created.directory, paths);
    throw error;
  }
}

export function createUploadStage(paths: SkillPaths, copyContent: (repoDir: string) => void, notices: string[] = []): StagedImport {
  const created = createStage(paths);
  const repoDir = join(created.directory, 'repo');
  try {
    copyContent(repoDir);
    const source: StagedSource = { source: 'upload', sourceType: 'local', sourceUrl: 'upload' };
    const meta: StageMeta = { id: created.id, createdAt: Date.now(), contentDir: 'repo', source, kind: 'upload', ...(notices.length ? { notices } : {}) };
    const staged = publicImport(created.id, meta, repoDir);
    const invalid = staged.skills.find((skill) => skill.problems.length > 0);
    if (invalid) fail('Invalid uploaded skill "' + invalid.name + '": ' + invalid.problems.map((problem) => problem.message).join('; '));
    writeJson(join(created.directory, 'stage.json'), meta, paths);
    return staged;
  } catch (error) {
    abandonStage(created.directory, paths);
    throw error;
  }
}

async function treeHash(repoDir: string, skillPath: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const clean = validateRelativePath(skillPath);
  const folder = dirname(clean) === '.' ? '' : dirname(clean);
  // Git places the tree peel before the path in this rev syntax; cat-file below rejects blob paths such as symlinks.
  const spec = folder ? 'HEAD^{tree}:' + folder : 'HEAD^{tree}';
  const result = await runGit(['-C', repoDir, 'rev-parse', '--verify', '--end-of-options', spec], timeoutMs);
  const sha = result.stdout.trim().toLowerCase();
  if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) fail('Could not read Git tree SHA for ' + clean + ': ' + result.stderr.trim());
  const type = await runGit(['-C', repoDir, 'cat-file', '-t', sha], timeoutMs);
  if (type.code !== 0 || type.stdout.trim() !== 'tree') fail('Git source path is not a tree: ' + clean);
  return sha;
}

export function validateHarnesses(value: unknown): Harness[] {
  if (!Array.isArray(value)) fail('harnesses must be an array.');
  const result: Harness[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !HARNESS_NAMES.has(item as Harness)) fail('Unsupported harness: ' + String(item) + '.');
    if (!result.includes(item as Harness)) result.push(item as Harness);
  }
  return result;
}

export async function importStaged(
  id: string, requestedSkills: unknown, harnesses: unknown, paths: SkillPaths = skillPaths(),
): Promise<{ skills: { name: string; harnesses: Harness[]; source: Record<string, unknown> }[]; actions: unknown[]; conflicts: unknown[] }> {
  if (!Array.isArray(requestedSkills) || requestedSkills.length === 0 || requestedSkills.some((name) => typeof name !== 'string')) {
    fail('skills must be a non-empty array of skill names.');
  }
  const selected = requestedSkills as string[];
  if (new Set(selected).size !== selected.length) fail('skills must not contain duplicate names.');
  const selectedHarnesses = validateHarnesses(harnesses);
  const { directory, meta } = loadMeta(id, paths);
  const repoDir = join(directory, meta.contentDir);
  const candidates = inspectCandidates(repoDir, meta.source.subpath, meta.source.skillFilter, meta.ignoredSymlinks).candidates;
  // A name-collision candidate shares its name with an earlier one: the first of a name is the one selected by name.
  const byName = new Map<string, SkillCandidate>();
  for (const item of candidates) if (!byName.has(item.name)) byName.set(item.name, item);
  const chosen = selected.map((name) => {
    const candidate = byName.get(name);
    if (!candidate) fail('Skill "' + name + '" is not in staged import ' + id + '.');
    if (candidate.problems.length) fail('Skill "' + name + '" is invalid: ' + candidate.problems.map((problem) => problem.message).join('; '));
    if (validateName(name).length) fail('Invalid skill name: ' + name);
    return candidate;
  });
  const manifest = readManifest(paths.library);
  for (const item of chosen) {
    if (existsSync(join(paths.library, item.name)) || manifest.skills[item.name]) {
      throw new SkillImportError('Skill "' + item.name + '" already exists in the library.', 409);
    }
  }
  ensureLibrary(paths);
  const currentManifest = readManifest(paths.library);
  for (const item of chosen) {
    if (existsSync(join(paths.library, item.name)) || currentManifest.skills[item.name]) {
      throw new SkillImportError('Skill "' + item.name + '" already exists in the library.', 409);
    }
  }

  const tempDirs: string[] = [], finalDirs: string[] = [];
  try {
    for (const item of chosen) {
      const temp = assertWritable(join(paths.library, '.' + item.name + '.import-' + randomUUID()), paths);
      copyTree(item.directory, temp, paths);
      tempDirs.push(temp);
    }
    const installed: { name: string; harnesses: Harness[]; source: Record<string, unknown> }[] = [];
    for (let index = 0; index < chosen.length; index++) {
      const item = chosen[index]!;
      const target = assertWritable(join(paths.library, item.name), paths);
      if (existsSync(target)) throw new SkillImportError('Skill "' + item.name + '" already exists in the library.', 409);
      renameSync(assertWritable(tempDirs[index]!, paths), target);
      finalDirs.push(target);
      // Vercel's lock semantics: a Git source's skillFolderHash is the upstream tree SHA, a local/upload source's is the
      // content digest. installedHash hashes paths and bytes (not modes) for byte checks; executable bits are preserved separately.
      const installedHash = folderHash(target);
      const skillFolderHash = meta.kind === 'git' ? await treeHash(repoDir, item.skillPath) : installedHash;
      const now = new Date().toISOString();
      const previous = currentManifest.skills[item.name]?.source;
      const source: Record<string, unknown> = {
        source: meta.source.source, sourceType: meta.source.sourceType, sourceUrl: meta.source.sourceUrl,
        skillPath: item.skillPath, skillFolderHash, installedHash,
        installedAt: typeof previous?.installedAt === 'string' ? previous.installedAt : now,
        updatedAt: now,
        ...(meta.source.ref ? { ref: meta.source.ref } : {}),
      };
      currentManifest.skills[item.name] = { harnesses: selectedHarnesses, source };
      installed.push({ name: item.name, harnesses: selectedHarnesses, source });
    }
    writeManifest(currentManifest, paths.library, paths);
    const linked = syncLinks(paths);
    abandonStage(directory, paths);
    return { skills: installed, actions: linked.actions, conflicts: linked.conflicts };
  } catch (error) {
    for (const temp of tempDirs) {
      try { if (existsSync(temp)) rmSync(assertWritable(temp, paths), { recursive: true, force: true }); } catch {}
    }
    for (const target of finalDirs) {
      try { if (existsSync(target)) rmSync(assertWritable(target, paths), { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

export async function checkUpdates(paths: SkillPaths = skillPaths(), timeoutMs = GIT_TIMEOUT_MS): Promise<{ name: string; current: string | null; latest: string | null; available: boolean; error?: string }[]> {
  const manifest = readManifest(paths.library);
  const result: { name: string; current: string | null; latest: string | null; available: boolean; error?: string }[] = [];
  const groups = new Map<string, { url: string; ref?: string; entries: { name: string; current: string | null; skillPath?: string }[] }>();
  for (const [name, item] of Object.entries(manifest.skills)) {
    const source = item.source as Record<string, unknown> | undefined;
    if (!source || source.sourceType === 'local') continue;
    const url = typeof source.sourceUrl === 'string' ? source.sourceUrl : '';
    const skillPath = typeof source.skillPath === 'string' ? source.skillPath : undefined;
    const ref = typeof source.ref === 'string' ? source.ref : undefined;
    // sourceTreeSha: entries written by an earlier build of this branch kept the tree SHA there.
    const current = typeof source.sourceTreeSha === 'string' ? source.sourceTreeSha
      : typeof source.skillFolderHash === 'string' ? source.skillFolderHash : null;
    const key = url + '\0' + (ref || '');
    let group = groups.get(key);
    if (!group) { group = { url, ...(ref ? { ref } : {}), entries: [] }; groups.set(key, group); }
    group.entries.push({ name, current, ...(skillPath ? { skillPath } : {}) });
  }
  for (const group of groups.values()) {
    const stage = createStage(paths);
    const repoDir = join(stage.directory, 'repo');
    try {
      if (!group.url) throw new SkillImportError('Source URL is missing.');
      await cloneRepo(group.url, repoDir, group.ref, paths, timeoutMs);
      for (const entry of group.entries) {
        try {
          if (!entry.skillPath) throw new SkillImportError('skillPath is missing from source metadata.');
          const latest = await treeHash(repoDir, entry.skillPath, timeoutMs);
          result.push({ name: entry.name, current: entry.current, latest, available: latest !== entry.current });
        } catch (error) {
          result.push({ name: entry.name, current: entry.current, latest: null, available: false, error: (error as Error).message });
        }
      }
    } catch (error) {
      for (const entry of group.entries) result.push({ name: entry.name, current: entry.current, latest: null, available: false, error: (error as Error).message });
    } finally { abandonStage(stage.directory, paths); }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function removeStagedImport(id: string, paths: SkillPaths = skillPaths()): void {
  const { directory } = loadMeta(id, paths);
  abandonStage(directory, paths);
}
