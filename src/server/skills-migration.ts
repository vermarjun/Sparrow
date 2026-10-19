// Migration routes: plan (dry run), apply (backup tar first), rollback, backups list. Mounted from skills-api.ts.
// A request names a plan by its id (a hash of what the user saw) and a backup by its id (a directory name that the
// server lists itself); it never supplies a path. Apply re-plans server-side and refuses if the plan changed.
import type { Context, Hono } from 'hono';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigration, backup as takeBackup, planMigration, rollback, summarizePlan,
  type BackupManifest, type MigrationPlan,
} from '../skills/migrate';
import { diff } from '../skills/link';
import { assertWritable, libraryProblem, skillPaths } from '../skills/paths';
import { scanSkills } from '../skills/scan';
import type { SkillPaths } from '../skills/types';
import { HttpError } from './core';

async function body<T = any>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
}

/** Identity of a plan: what is on disk and what would happen. mtimes are left out (a changed file changes its hash). */
export function planId(plan: MigrationPlan): string {
  const v = (x: MigrationPlan['candidates'][number]) => [x.name, x.root, x.path, x.resolvedPath, x.hash];
  const canon = {
    home: plan.home, library: plan.library,
    candidates: plan.candidates.map(v),
    decisions: plan.decisions.map((d) => [d.name, d.defaultPath, d.harnesses, d.variants.map(v)]),
    skipped: plan.skipped.map((s) => [s.path, s.reason]),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 32);
}

export interface BackupInfo {
  id: string;
  path: string;
  created: number;
  size: number;
  sha256: string;
  members: number;
  moved: number;
  library_existed: boolean;
  rolled_back_at: number | null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readBackup(paths: SkillPaths, id: string): { info: BackupInfo; manifest: BackupManifest } | null {
  if (!ID_RE.test(id)) return null;
  const dir = join(paths.backup, id);
  const file = join(dir, 'backup-manifest.json');
  if (!existsSync(file)) return null;
  let manifest: BackupManifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf8')) as BackupManifest; } catch { return null; }
  if (manifest.dir !== dir || manifest.tarPath !== join(dir, 'backup.tar')) return null;
  let rolled: number | null = null;
  try { rolled = (JSON.parse(readFileSync(join(dir, 'rollback.json'), 'utf8')) as { at: number }).at; } catch { /* not rolled back */ }
  return {
    manifest,
    info: {
      id, path: dir, created: statSync(dir).birthtimeMs, size: manifest.size, sha256: manifest.sha256,
      members: manifest.members.length, moved: manifest.movedPaths.length, library_existed: manifest.libraryExisted,
      rolled_back_at: rolled,
    },
  };
}

export function listBackups(paths: SkillPaths): BackupInfo[] {
  let names: string[] = [];
  try { names = readdirSync(paths.backup); } catch { return []; }
  return names.flatMap((id) => readBackup(paths, id)?.info ?? []).sort((a, b) => b.created - a.created);
}

/** A library location that overlaps a harness folder or a migration source is refused before anything is planned or moved. */
function requireSafeLibrary(paths: SkillPaths): void {
  const problem = libraryProblem(paths);
  if (problem) throw new HttpError(409, problem);
}

export function mountMigrationApi(app: Hono<any>, emit: () => void) {
  app.post('/api/skills/migration/plan', () => {
    const paths = skillPaths();
    requireSafeLibrary(paths);
    const plan = planMigration(paths);
    return Response.json({ ...plan, plan_id: planId(plan), backup_root: paths.backup, summary: summarizePlan(plan) });
  });

  // Compare two variants of one planned name (both must be variants in a fresh plan; the request names no other path).
  app.get('/api/skills/migration/diff', (c) => {
    requireSafeLibrary(skillPaths());
    const plan = planMigration(skillPaths());
    const decision = plan.decisions.find((d) => d.name === c.req.query('name'));
    if (!decision) throw new HttpError(404, `"${c.req.query('name') ?? ''}" is not in the migration plan.`);
    const pick = (path: string | undefined) => {
      const v = decision.variants.find((x) => x.path === path);
      if (!v) throw new HttpError(404, `${path ?? '(no path)'} is not a variant of "${decision.name}".`);
      return v;
    };
    const a = pick(c.req.query('a'));
    const b = pick(c.req.query('b'));
    let text: string;
    try { text = diff(a.resolvedPath, b.resolvedPath); } catch (e) { throw new HttpError(500, `diff failed: ${(e as Error).message}`); }
    return c.json(text.length > 1024 * 1024 ? { diff: text.slice(0, 1024 * 1024), truncated: true } : { diff: text });
  });

  app.get('/api/skills/migration/backups', (c) => c.json(listBackups(skillPaths())));

  app.post('/api/skills/migration/apply', async (c) => {
    const paths = skillPaths();
    requireSafeLibrary(paths);
    const b = await body<{ plan_id?: unknown; choices?: unknown; confirm?: unknown }>(c);
    if (b.confirm !== 'migrate') throw new HttpError(400, 'confirm must be the word "migrate".');
    if (typeof b.plan_id !== 'string' || !b.plan_id) throw new HttpError(400, 'plan_id is required: plan first, then apply that plan.');
    const raw = b.choices ?? {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.values(raw).every((x) => typeof x === 'string'))
      throw new HttpError(400, 'choices must be an object {name: candidatePath}.');
    const choices = raw as Record<string, string>;

    const plan = planMigration(paths);
    if (planId(plan) !== b.plan_id) throw new HttpError(409, 'The plan changed since you looked at it (a skill folder was edited, added or removed). Plan again and review it.');
    for (const [name, path] of Object.entries(choices)) {
      const decision = plan.decisions.find((d) => d.name === name);
      if (!decision) throw new HttpError(400, `choices: "${name}" is not in the plan.`);
      if (!decision.variants.some((v) => v.path === path)) throw new HttpError(400, `choices: ${path} is not a variant of "${name}" in the plan.`);
    }

    // The backup is taken (and hashed) before anything moves; apply then re-hashes every source immediately before acting.
    const saved = takeBackup(plan, paths);
    let result: ReturnType<typeof applyMigration>;
    try {
      result = applyMigration(plan, choices, paths, saved);
    } catch (e) {
      emit();
      const msg = (e as Error).message;
      const nothingMoved = saved.movedPaths.length === 0;
      throw new HttpError(
        /Library already has a different|not a real skill folder/.test(msg) ? 409 : 500,
        `Migration stopped: ${msg}. ${nothingMoved ? 'Nothing was moved.' : `${saved.movedPaths.length} entries were already moved: roll back backup ${saved.dir.split('/').pop()} to restore them.`}`,
      );
    }
    emit();
    const conflicts = scanSkills(paths).filter((e) => e.status === 'conflict' && e.root !== 'library')
      .map((e) => ({ name: e.name, root: e.root, path: e.path, conflict: e.conflict }));
    return c.json({
      backup: { id: result.backup.dir.split('/').pop()!, path: result.backup.dir, sha256: result.backup.sha256, size: result.backup.size },
      applied: result.replaced,
      selected: result.selected,
      // Differing copies with no explicit choice: not copied, every copy untouched (listed as Unmanaged afterwards).
      kept_as_conflict: plan.decisions.filter((d) => d.needsChoice && !(d.name in result.selected))
        .map((d) => ({ name: d.name, paths: d.variants.map((v) => v.path) })),
      skipped: result.skipped,
      conflicts_left: conflicts,
      link_conflicts: result.linkConflicts,
    });
  });

  app.post('/api/skills/migration/rollback', async (c) => {
    const paths = skillPaths();
    requireSafeLibrary(paths);
    const b = await body<{ backup_id?: unknown; confirm?: unknown }>(c);
    if (b.confirm !== 'rollback') throw new HttpError(400, 'confirm must be the word "rollback".');
    if (typeof b.backup_id !== 'string' || !b.backup_id) throw new HttpError(400, 'backup_id is required.');
    const found = readBackup(paths, b.backup_id);
    if (!found) throw new HttpError(404, `No migration backup "${b.backup_id}". GET /api/skills/migration/backups lists them.`);
    if (found.info.rolled_back_at) throw new HttpError(409, 'That backup was already rolled back.');
    const tar = readFileSync(found.manifest.tarPath);
    if (createHash('sha256').update(tar).digest('hex') !== found.manifest.sha256)
      throw new HttpError(409, 'The backup archive no longer matches its recorded SHA-256; refusing to restore from it.');
    let result: ReturnType<typeof rollback>;
    try {
      result = rollback(found.manifest, paths);
    } catch (e) {
      emit();
      throw new HttpError(409, `Rollback failed: ${(e as Error).message}`);
    }
    writeFileSync(assertWritable(join(found.info.path, 'rollback.json'), paths), `${JSON.stringify({ at: Date.now(), ...result })}\n`, { mode: 0o600 });
    emit();
    return c.json({ ...result, backup_id: found.info.id });
  });
}
