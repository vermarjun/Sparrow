import { Hono, type Context, type Env, type Schema } from 'hono';
import { createSkill } from '../skills/create';
import { checkUpdates, importStaged, previewSource, SkillImportError, validateHarnesses } from '../skills/importer';
import { skillPaths } from '../skills/paths';
import { stageUpload } from '../skills/upload';
import type { SkillPaths } from '../skills/types';

export interface SkillAddRouteDeps {
  /** Optional fixed paths for tests; production paths are resolved on every request. */
  paths?: SkillPaths;
  gitTimeoutMs?: number;
  /** Called after a library write so the mounted API can publish its global skills SSE event. */
  onSkillsChanged?: () => void;
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try { return objectBody(await c.req.json()); }
  catch { throw new SkillImportError('Request body must be valid JSON.'); }
}

function errorReply(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  let status = error instanceof SkillImportError ? error.status : 500;
  let reply = message;
  if (!(error instanceof SkillImportError)) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') { status = 400; reply = 'The requested source path does not exist.'; }
    else if (code === 'ENAMETOOLONG') { status = 400; reply = 'A file name or path is too long.'; }
    else if (code === 'EEXIST' || code === 'ENOTDIR') { status = 400; reply = 'The upload contains a file and directory path collision.'; }
    else if (message.startsWith('Refusing write outside the skills fence')) { status = 400; reply = message; }
    else if (message.startsWith('Refusing write: The skills library')) { status = 409; reply = message.replace('Refusing write: ', ''); }
    else if (error instanceof TypeError || /form data|multipart|decode form/i.test(message)) { status = 400; reply = 'Malformed multipart form data.'; }
  }
  return c.json({ error: status >= 500 ? 'Internal server error.' : reply }, status as any);
}

export function mountSkillAddRoutes<E extends Env, S extends Schema, BasePath extends string>(
  app: Hono<E, S, BasePath>, deps: SkillAddRouteDeps = {},
): Hono<E, S, BasePath> {
  const getPaths = () => deps.paths ?? skillPaths();
  const changed = () => { try { deps.onSkillsChanged?.(); } catch {} };

  app.post('/api/skills', async (c) => {
    try {
      const body = await jsonBody(c);
      const result = createSkill(body.name, body.description, body.harnesses, getPaths());
      changed();
      return c.json({ skill: result.skill }, 201);
    } catch (error) { return errorReply(c, error); }
  });

  app.post('/api/skills/upload', async (c) => {
    try {
      let form: FormData;
      try { form = await c.req.formData(); }
      catch { throw new SkillImportError('The upload is not a readable multipart form.', 400); }
      return c.json({ staged: await stageUpload(form, getPaths()) }, 201);
    } catch (error) { return errorReply(c, error); }
  });

  app.post('/api/skills/import/preview', async (c) => {
    try {
      const body = await jsonBody(c);
      if (typeof body.source !== 'string' || !body.source.trim()) throw new SkillImportError('source must be a non-empty string.');
      return c.json({ staged: await previewSource(body.source, getPaths(), process.env, deps.gitTimeoutMs) }, 201);
    } catch (error) { return errorReply(c, error); }
  });

  app.post('/api/skills/import', async (c) => {
    try {
      const body = await jsonBody(c);
      if (typeof body.staged_id !== 'string') throw new SkillImportError('staged_id must be a string.');
      const result = await importStaged(body.staged_id, body.skills, body.harnesses, getPaths());
      changed();
      return c.json({ skills: result.skills, actions: result.actions, conflicts: result.conflicts }, 201);
    } catch (error) { return errorReply(c, error); }
  });

  // POST, not GET: a check shallow-clones every Git source (network, disk), so a page must not trigger it cross-site.
  // Behind guardWrites like every other write; it changes nothing in the library.
  app.post('/api/skills/updates', async (c) => {
    try { return c.json(await checkUpdates(getPaths(), deps.gitTimeoutMs)); }
    catch (error) {
      // Update checks are advisory. A broken manifest or staging environment is reported as data.
      return c.json([{ name: 'library', current: null, latest: null, available: false, error: (error as Error).message }]);
    }
  });
  return app;
}
