// Skills HTTP API over the Phase-1 library (docs/DESIGN.md §12.9). Global like the Resumes API: no identity.
// Every path a request can reach is looked up in a fresh scan (entries) or built by skillPaths(); a request never
// supplies a folder, a remote or a URL. Push goes to the library's own `origin` only.
import type { Context, Hono } from 'hono';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adopt } from '../skills/adopt';
import { SPARROW_SKILLS } from '../skills/grant';
import { commit, ensureLibrary, log as gitLog, pull, push, status as gitStatus } from '../skills/git';
import { apply, diff, plan, sync } from '../skills/link';
import { readManifest, writeManifest } from '../skills/manifest';
import { skillPaths } from '../skills/paths';
import { resolveConflict } from '../skills/resolve';
import { scanSkills } from '../skills/scan';
import { validSkillName } from '../skills/frontmatter';
import type {
  FileNode, Harness, HarnessLink, LibrarySkill, LinkAction, LinkState, SkillEntry, SkillPaths, SkillsState,
} from '../skills/types';
import { HARNESS_READS, libraryProblem, rootAliasWarnings } from '../skills/paths';
import { HttpError, type Core } from './core';
import { SLUG_RE } from './resumes';
import { mountMigrationApi } from './skills-migration';

const HARNESSES: Harness[] = ['claude', 'codex', 'opencode'];
const MAX_MD = 512 * 1024;
const MAX_DIFF = 1024 * 1024;
const MAX_NODES = 500;
const MAX_DEPTH = 6;

async function body<T = any>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
}

const isDir = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const exists = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };

function libraryMissing(paths: SkillPaths): boolean {
  return !isDir(paths.library) || !existsSync(join(paths.library, '.git'));
}

function linkState(entry: SkillEntry | undefined, path: string, wanted: boolean): LinkState {
  if (entry) return entry.status === 'managed' ? 'linked' : entry.status === 'broken' ? 'broken' : 'conflict';
  if (exists(path)) return 'conflict';
  return wanted ? 'missing' : 'off';
}

// An imported skill keeps its SKILL.md byte for byte (like Vercel's tool) and lives in a folder named by libraryName(),
// so a frontmatter name that differs from that folder is expected, not a problem to flag on every listing.
const IMPORTED_NAME_NOTES = new Set(['name-folder', 'name-format', 'name-length']);

function librarySkill(entry: SkillEntry, entries: Map<string, SkillEntry>, paths: SkillPaths, manifest: ReturnType<typeof readManifest>): LibrarySkill {
  const locked = entry.root === 'sparrow';
  const item = manifest.skills[entry.name];
  const src = item?.source as { sourceType?: unknown; sourceUrl?: unknown } | undefined;
  const sourceUrl = typeof src?.sourceUrl === 'string' ? src.sourceUrl : null;
  const source: LibrarySkill['source'] = locked ? 'sparrow' : src?.sourceType === 'github' ? 'github' : 'local';
  const harnesses = locked ? [...HARNESSES] : HARNESSES.filter((h) => item?.harnesses?.includes(h));
  const states = new Map<Harness, LinkState>();
  const links: HarnessLink[] = HARNESSES.map((harness) => {
    const path = join(paths.roots[harness], entry.name);
    const wanted = harnesses.includes(harness);
    const state: LinkState = locked ? 'locked' : linkState(entries.get(`${harness}\0${entry.name}`), path, wanted);
    states.set(harness, state);
    return {
      harness, wanted, state, path,
      alsoReadBy: state === 'linked' ? (HARNESS_READS[harness] as readonly Harness[]).filter((h) => h !== harness) : [],
      viaRoot: null,
    };
  });
  if (!locked && states.get('claude') === 'linked') {
    const own = links.find((l) => l.harness === 'opencode')!;
    if (own.state !== 'linked') own.viaRoot = 'claude';
  }
  return {
    name: entry.name,
    description: entry.frontmatter?.description ?? null,
    path: entry.path,
    locked,
    source,
    sourceUrl: source === 'github' ? sourceUrl : null,
    inManifest: locked || !!item,
    harnesses,
    links,
    problems: item?.source ? entry.problems.filter((p) => !IMPORTED_NAME_NOTES.has(p.code)) : entry.problems,
  };
}

function build(paths: SkillPaths): { state: SkillsState; entries: SkillEntry[] } {
  const entries = scanSkills(paths);
  const manifest = readManifest(paths.library);
  const byRootName = new Map(entries.map((e) => [`${e.root}\0${e.name}`, e]));
  const warnings: string[] = [];
  const missing = libraryMissing(paths);
  const problem = libraryProblem(paths);
  if (problem) warnings.push(problem);
  warnings.push(...rootAliasWarnings(paths));
  if (missing && !problem) warnings.push(`Skills library is not set up at ${paths.library}.`);
  const library = new Map<string, LibrarySkill>();
  for (const entry of entries) {
    if (entry.root !== 'library' && entry.root !== 'sparrow') continue;
    if (entry.root === 'library' && library.get(entry.name)?.locked) continue;
    if (entry.root === 'library' && (SPARROW_SKILLS as readonly string[]).includes(entry.name)) {
      warnings.push(`Library folder "${entry.name}" is shadowed by the built-in Sparrow skill of the same name.`);
      continue;
    }
    library.set(entry.name, librarySkill(entry, byRootName, paths, manifest));
  }
  for (const skill of library.values()) {
    if (!skill.locked && !skill.inManifest) warnings.push(`${skill.name}: library folder is not in skills.json (no harness toggles are saved for it).`);
  }
  for (const name of Object.keys(manifest.skills)) {
    if (!validSkillName(name)) warnings.push(`${name}: invalid skill name in skills.json; skipped.`);
    if (!library.has(name)) warnings.push(`${name}: listed in skills.json but the library folder (or its SKILL.md) is missing.`);
  }
  const harnessEntries = entries.filter((e) => e.root !== 'library' && e.root !== 'sparrow');
  const state: SkillsState = {
    library_missing: missing,
    library_problem: problem,
    library: [...library.values()].sort((a, b) => Number(a.locked) - Number(b.locked) || a.name.localeCompare(b.name)),
    unmanaged: harnessEntries.filter((e) => e.status === 'unmanaged'),
    external: harnessEntries.filter((e) => e.status === 'external'),
    conflicts: harnessEntries.filter((e) => e.status === 'conflict'),
    broken: harnessEntries.filter((e) => e.status === 'broken'),
    git: gitStatus(paths),
    paths: { library: paths.library, home: paths.home, backup: paths.backup, roots: paths.roots, sandbox: paths.sandboxHome },
    warnings,
  };
  return { state, entries };
}

function readCapped(file: string): string {
  try {
    if (lstatSync(file).isSymbolicLink()) return '';
    const text = readFileSync(file, 'utf8');
    return text.length > MAX_MD ? `${text.slice(0, MAX_MD)}\n\n… (truncated)` : text;
  } catch { return ''; }
}

function fileTree(dir: string): FileNode[] {
  let budget = MAX_NODES;
  const walk = (abs: string, rel: string, depth: number): FileNode[] => {
    let items;
    try { items = readdirSync(abs, { withFileTypes: true }); } catch { return []; }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const out: FileNode[] = [];
    for (const item of items) {
      if (item.name === '.git' || item.name === 'node_modules' || item.name === '.DS_Store') continue;
      if (budget-- <= 0) break;
      const path = rel ? `${rel}/${item.name}` : item.name;
      const full = join(abs, item.name);
      if (item.isSymbolicLink()) out.push({ name: item.name, path, type: 'link' });
      else if (item.isDirectory()) out.push({ name: item.name, path, type: 'dir', children: depth < MAX_DEPTH ? walk(full, path, depth + 1) : [] });
      else {
        let size: number | undefined;
        try { size = lstatSync(full).size; } catch {}
        out.push({ name: item.name, path, type: 'file', size });
      }
    }
    return out;
  };
  return walk(dir, '', 0);
}

/** Library failures a caller can act on are 409, everything else stays a 500. */
function mapError(e: unknown): never {
  if (e instanceof HttpError) throw e;
  const msg = (e as Error)?.message ?? String(e);
  if (/already contains|Not a conflicting|is missing|Refusing write|not a git repository|not configured|not fast-forward|Cannot/.test(msg)) throw new HttpError(409, msg);
  throw e;
}

export function mountSkillsApi(app: Hono<any>, core: Core) {
  const emit = () => core.events.emit({ type: 'skills.updated', project_id: '*' });
  const notLocked = (name: string) => `"${name}" is a Sparrow skill: it is always on for every agent and cannot be changed here.`;
  const requireName = (name: string): string => {
    if (!validSkillName(name)) throw new HttpError(400, 'name must be 1–64 lowercase letters or digits separated by single hyphens.');
    return name;
  };

  const writable = (paths: SkillPaths) => {
    const problem = libraryProblem(paths);
    if (problem) throw new HttpError(409, problem);
    if (libraryMissing(paths)) throw new HttpError(409, `The skills library is not set up at ${paths.library}. POST /api/skills/library/init creates it.`);
  };
  const view = (name: string, paths: SkillPaths): LibrarySkill => {
    const skill = build(paths).state.library.find((s) => s.name === name);
    if (!skill) throw new HttpError(404, `No library skill "${name}".`);
    return skill;
  };
  const entryAt = (entries: SkillEntry[], path: unknown): SkillEntry => {
    if (typeof path !== 'string' || !path) throw new HttpError(400, 'path is required.');
    const found = entries.find((e) => resolve(e.path) === resolve(path));
    if (!found) throw new HttpError(404, `No skill entry at ${path}. Only entries listed by GET /api/skills can be used.`);
    return found;
  };
  const applied = (actions: LinkAction[]) => actions.filter((a) => a.type !== 'conflict');

  // ---------------------------------------------------------------- reads
  app.get('/api/skills', (c) => c.json(build(skillPaths()).state));
  app.get('/api/skills/git', (c) => c.json(gitStatus(skillPaths())));
  // One atomic matrix edit: the read-modify-write happens here, synchronously, and touches only the `skills:` line.
  app.post('/api/skills/matrix', async (c) => {
    const b = await body<{ slug?: unknown; skill?: unknown; on?: unknown }>(c);
    if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) throw new HttpError(400, 'slug must be a resume slug.');
    if (typeof b.skill !== 'string' || !b.skill) throw new HttpError(400, 'skill must be a skill name.');
    if (typeof b.on !== 'boolean') throw new HttpError(400, 'on must be true (grant) or false (remove).');
    if ((SPARROW_SKILLS as readonly string[]).includes(b.skill)) throw new HttpError(409, `${b.skill} is always on for every agent and cannot be changed.`);
    if (b.on && !validSkillName(b.skill)) throw new HttpError(400, `"${b.skill}" is not a valid skill name (lowercase letters, digits, single hyphens).`);
    const cur = core.resumes.get(b.slug);
    if (!cur) throw new HttpError(404, `No resume "${b.slug}".`);
    const have = cur.skills ?? [];
    const next = b.on ? (have.includes(b.skill) ? have : [...have, b.skill]) : have.filter((s) => s !== b.skill);
    let resume = cur;
    if (next.length !== have.length || next.some((s, i) => s !== have[i])) {
      try { resume = core.resumes.setSkills(b.slug, next) ?? cur; } catch (e) { throw new HttpError(409, (e as Error).message); }
      core.emitResume(b.slug);
      emit();
    }
    return c.json({ resume: core.resumeView(resume) });
  });
  // Agent matrix: which resume grants which library skill. Registered before /api/skills/:name (it would swallow "matrix").
  // Writes are the normal PUT /api/resumes/:slug with an explicit `skills` array.
  app.get('/api/skills/matrix', (c) => {
    const { state } = build(skillPaths());
    const agents = core.store.listAgents().filter((a) => a.kind === 'agent' && a.state !== 'retired');
    const views = core.resumeViews();
    return c.json({
      resumes: views.map((r) => ({
        slug: r.slug, title: r.title, harness: r.harness, skills: r.skills ?? [],
        hired: agents.filter((a) => a.resume === r.slug).length, stale: r.stale_agents.length,
      })),
      skills: state.library.filter((x) => !x.locked).map((x) => x.name),
      locked: [...SPARROW_SKILLS],
    });
  });

  // Migration routes first: `/api/skills/migration/diff` must not be read as `/api/skills/:name/diff`.
  mountMigrationApi(app, emit);

  app.get('/api/skills/:name', (c) => {
    const paths = skillPaths();
    const { state, entries } = build(paths);
    const name = requireName(c.req.param('name'));
    const skill = state.library.find((s) => s.name === name);
    if (!skill) throw new HttpError(404, `No library skill "${name}".`);
    let commits: ReturnType<typeof gitLog> = [];
    if (!skill.locked && !state.library_missing) { try { commits = gitLog(name, paths); } catch { /* no commits yet */ } }
    return c.json({
      skill,
      skill_md: readCapped(join(skill.path, 'SKILL.md')),
      files: fileTree(skill.path),
      log: commits,
      entries: entries.filter((e) => e.name === name),
    });
  });

  app.get('/api/skills/:name/diff', (c) => {
    const paths = skillPaths();
    const name = requireName(c.req.param('name'));
    const { entries } = build(paths);
    const entry = entryAt(entries, c.req.query('path'));
    if (entry.name !== name || entry.root === 'library' || entry.root === 'sparrow') throw new HttpError(404, `No copy of "${name}" at that path.`);
    const libraryDir = join(paths.library, name);
    if (!isDir(libraryDir)) throw new HttpError(404, `No library skill "${name}".`);
    if (!entry.resolvedTarget) throw new HttpError(409, 'That entry is a dangling link: nothing to compare.');
    let text: string;
    try { text = diff(libraryDir, entry.resolvedTarget); } catch (e) { throw new HttpError(500, `diff failed: ${(e as Error).message}`); }
    return c.json(text.length > MAX_DIFF ? { diff: text.slice(0, MAX_DIFF), truncated: true } : { diff: text });
  });

  // ---------------------------------------------------------------- library writes
  app.post('/api/skills/library/init', () => {
    const paths = skillPaths();
    try { ensureLibrary(paths); } catch (e) { mapError(e); }
    emit();
    return Response.json(build(paths).state);
  });

  app.put('/api/skills/:name/harnesses', async (c) => {
    const paths = skillPaths();
    const name = requireName(c.req.param('name'));
    const b = await body<{ harnesses?: unknown }>(c);
    if (!Array.isArray(b.harnesses) || !b.harnesses.every((h) => HARNESSES.includes(h as Harness)))
      throw new HttpError(400, `harnesses must be an array of ${HARNESSES.join(' | ')}.`);
    const wanted = HARNESSES.filter((h) => (b.harnesses as string[]).includes(h));
    const skill = view(name, paths);
    if (skill.locked) throw new HttpError(409, notLocked(name));
    writable(paths);
    let result: { actions: LinkAction[]; conflicts: LinkAction[] };
    try {
      const manifest = readManifest(paths.library);
      manifest.skills[name] = { ...(manifest.skills[name] ?? {}), harnesses: wanted };
      writeManifest(manifest, paths.library, paths);
      const actions = plan(manifest, scanSkills(paths), paths).filter((a) => a.name === name);
      result = { actions, conflicts: apply(actions, paths) };
    } catch (e) { mapError(e); }
    emit();
    return c.json({ skill: view(name, paths), actions: applied(result!.actions), conflicts: result!.conflicts });
  });

  app.post('/api/skills/sync', (c) => {
    const paths = skillPaths();
    writable(paths);
    let result: { actions: LinkAction[]; conflicts: LinkAction[] };
    try { result = sync(paths); } catch (e) { mapError(e); }
    emit();
    return c.json({ actions: applied(result!.actions), conflicts: result!.conflicts });
  });

  app.post('/api/skills/adopt', async (c) => {
    const paths = skillPaths();
    const b = await body<{ path?: unknown; harnesses?: unknown }>(c);
    if (b.harnesses !== undefined && (!Array.isArray(b.harnesses) || !b.harnesses.every((h) => HARNESSES.includes(h as Harness))))
      throw new HttpError(400, `harnesses must be an array of ${HARNESSES.join(' | ')}.`);
    const entry = entryAt(build(paths).entries, b.path);
    requireName(entry.name);
    if (entry.status !== 'unmanaged' && entry.status !== 'external')
      throw new HttpError(409, `${entry.name} is ${entry.status}, so it cannot be adopted${entry.status === 'conflict' ? ': resolve the conflict instead' : ''}.`);
    writable(paths);
    let res: ReturnType<typeof adopt>;
    try { res = adopt(entry.path, b.harnesses as Harness[] | undefined, paths); } catch (e) { mapError(e); }
    emit();
    return c.json({ skill: view(res!.skill.name, paths), backup: res!.backup });
  });

  app.post('/api/skills/conflicts/resolve', async (c) => {
    const paths = skillPaths();
    const b = await body<{ path?: unknown; keep?: unknown }>(c);
    if (b.keep !== 'library' && b.keep !== 'entry') throw new HttpError(400, "keep must be 'library' or 'entry'.");
    const entry = entryAt(build(paths).entries, b.path);
    requireName(entry.name);
    if (entry.status !== 'conflict') throw new HttpError(409, `${entry.name} at that path is ${entry.status}, not a conflict.`);
    writable(paths);
    let res: ReturnType<typeof resolveConflict>;
    try { res = resolveConflict(entry.path, b.keep, paths); } catch (e) { mapError(e); }
    emit();
    return c.json({ skill: view(res!.skill.name, paths), backup: res!.backup });
  });

  // ---------------------------------------------------------------- git (the library repo and its own origin only)
  app.post('/api/skills/git/pull', async () => {
    const paths = skillPaths();
    writable(paths);
    const before = gitStatus(paths);
    if (!before.remote) throw new HttpError(409, 'The library has no origin remote to pull from.');
    if (before.dirty.length) throw new HttpError(409, 'The library has uncommitted changes: commit them before pulling.');
    let output: string;
    try { output = await pull(paths); } catch (e) { emit(); throw new HttpError(409, (e as Error).message); }
    emit();
    return Response.json({ ...gitStatus(paths), output });
  });

  app.post('/api/skills/git/commit', async (c) => {
    const paths = skillPaths();
    const b = await body<{ message?: unknown; push?: unknown }>(c);
    for (const key of ['remote', 'url', 'origin']) {
      if (key in b) throw new HttpError(400, `${key} is not accepted: pushes go to the library's own origin only.`);
    }
    if (typeof b.message !== 'string' || !b.message.trim()) throw new HttpError(400, 'message is required.');
    if (b.message.length > 2000) throw new HttpError(400, 'message is too long (max 2000 characters).');
    if (b.push !== undefined && typeof b.push !== 'boolean') throw new HttpError(400, 'push must be a boolean.');
    writable(paths);
    const before = gitStatus(paths);
    if (!before.available) throw new HttpError(409, before.error ?? 'The library is not a git repository.');
    if (b.push && !before.remote) throw new HttpError(409, 'Cannot push: the library has no origin remote.');
    if (!before.dirty.length && !(b.push && (before.ahead ?? 0) > 0)) throw new HttpError(409, 'Nothing to commit.');
    try {
      if (before.dirty.length) commit(b.message.trim(), paths);
    } catch (e) { emit(); throw new HttpError(409, (e as Error).message); }
    if (b.push) {
      try { await push(paths); } catch (e) { emit(); throw new HttpError(409, `Committed, but the push failed: ${(e as Error).message}`); }
    }
    emit();
    return c.json(gitStatus(paths));
  });

}
