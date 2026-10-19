import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountSkillAddRoutes } from '../../src/server/skills-add-routes';
import { skillPaths } from '../../src/skills/paths';
import { setup } from './helpers';
import { makeZip } from '../skills/zip-fixture';

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'skills-add-api-'));
  const home = join(base, 'home');
  const paths = skillPaths({ HOME: home, SPARROW_SKILLS_HOME: home, SPARROW_HOME: join(home, '.sparrow') });
  return { base, paths };
}

function uploadForm(zip: Buffer): FormData {
  const bytes = new Uint8Array(zip.byteLength);
  bytes.set(zip);
  const form = new FormData();
  form.append('file', new File([bytes], 'safe-skill.zip', { type: 'application/zip' }));
  return form;
}

test('Create, upload, preview, import and updates routes return their contract responses in a sandbox', async () => {
  const { base, paths } = sandbox();
  try {
    let changed = 0;
    const app = mountSkillAddRoutes(new Hono(), { paths, onSkillsChanged: () => { changed++; } });

    const create = await app.request('/api/skills', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'created-skill', description: 'Created from the API.', harnesses: ['claude'] }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toEqual({ skill: { name: 'created-skill', description: 'Created from the API.', harnesses: ['claude'] } });
    expect(existsSync(join(paths.library, 'created-skill', 'SKILL.md'))).toBe(true);

    const collision = await app.request('/api/skills', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'created-skill', description: 'Collision.', harnesses: [] }),
    });
    expect(collision.status).toBe(409);
    expect((await collision.json()).error).toContain('already exists');

    const upload = await app.request('/api/skills/upload', { method: 'POST', body: uploadForm(makeZip([
      { name: 'safe-skill/SKILL.md', data: '---\nname: safe-skill\ndescription: API upload.\n---\n\n# Safe\n' },
      { name: 'safe-skill/scripts/check.sh', data: '#!/bin/sh\necho safe\n' },
    ])) });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { staged: { id: string; skills: { name: string; scripts: string[] }[] } };
    expect(uploaded.staged.skills).toEqual([expect.objectContaining({ name: 'safe-skill', scripts: ['scripts/check.sh'] })]);
    expect(changed).toBe(1);

    const imported = await app.request('/api/skills/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staged_id: uploaded.staged.id, skills: ['safe-skill'], harnesses: ['codex'] }),
    });
    expect(imported.status).toBe(201);
    expect((await imported.json()).skills).toEqual([expect.objectContaining({ name: 'safe-skill', harnesses: ['codex'] })]);
    expect(existsSync(join(paths.roots.codex, 'safe-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(paths.sparrowHome, 'skills-staging', 'import-' + uploaded.staged.id))).toBe(false);
    expect(changed).toBe(2);

    const localSource = join(base, 'local-source', 'from-link');
    mkdirSync(localSource, { recursive: true });
    writeFileSync(join(localSource, 'SKILL.md'), '---\nname: linked-skill\ndescription: Local source.\n---\n');
    const preview = await app.request('/api/skills/import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: localSource }),
    });
    expect(preview.status).toBe(201);
    const previewBody = await preview.json() as { staged: { id: string; source?: { sourceType: string }; skills: { name: string }[] } };
    expect(previewBody.staged.source?.sourceType).toBe('local');
    expect(previewBody.staged.skills.map((skill) => skill.name)).toEqual(['linked-skill']);

    const updates = await app.request('/api/skills/updates', { method: 'POST' });
    expect(updates.status).toBe(200);
    expect(await updates.json()).toEqual([]);
    expect(changed).toBe(2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Add routes return validation errors for malformed JSON, empty uploads and invalid staged selections', async () => {
  const { base, paths } = sandbox();
  try {
    const app = mountSkillAddRoutes(new Hono(), { paths });

    const malformed = await app.request('/api/skills', { method: 'POST', body: '{' });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toContain('valid JSON');

    const emptyUpload = await app.request('/api/skills/upload', { method: 'POST', body: new FormData() });
    expect(emptyUpload.status).toBe(400);
    expect((await emptyUpload.json()).error).toContain('must contain files');

    const noSelection = await app.request('/api/skills/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staged_id: '11111111-1111-4111-8111-111111111111', skills: ['missing'], harnesses: [] }),
    });
    expect(noSelection.status).toBe(404);

    const noSource = await app.request('/api/skills/import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: '  ' }),
    });
    expect(noSource.status).toBe(400);
    expect((await noSource.json()).error).toContain('non-empty string');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('skills mutations reject cross-site requests, foreign origins, and simple text/plain JSON posts', async () => {
  const { base, paths } = sandbox();
  const previous = Object.fromEntries(['HOME', 'SPARROW_HOME', 'SPARROW_SKILLS_HOME', 'SPARROW_SKILLS_DIR', 'SPARROW_PORT']
    .map((key) => [key, process.env[key]]));
  try {
    process.env.HOME = paths.home;
    process.env.SPARROW_HOME = paths.sparrowHome;
    process.env.SPARROW_SKILLS_HOME = paths.home;
    process.env.SPARROW_SKILLS_DIR = paths.library;
    process.env.SPARROW_PORT = '4040';
    const ctx = await setup();
    const body = JSON.stringify({ name: 'csrf-probe', description: 'Should not be created.', harnesses: [] });

    const crossSite = await ctx.app.request('/api/skills', {
      method: 'POST', headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body,
    });
    expect(crossSite.status).toBe(403);
    // Refused by the global D13 guard (guardWrites), which answers for every /api write.
    expect((await crossSite.json()).error).toMatch(/cross-site/i);

    const foreignOrigin = await ctx.app.request('/api/skills', {
      method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body,
    });
    expect(foreignOrigin.status).toBe(403);
    expect((await foreignOrigin.json()).error).toContain('Origin');

    const simpleText = await ctx.app.request('/api/skills', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body,
    });
    expect(simpleText.status).toBe(415);
    expect(existsSync(join(paths.library, 'csrf-probe'))).toBe(false);

    const phaseTwoJson = await ctx.app.request('/api/skills/example/harnesses', {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ harnesses: [] }),
    });
    expect(phaseTwoJson.status).toBe(415);

    // Routes added later (the matrix toggle) are covered by the rule, not a hand-kept list.
    const garbage = await ctx.app.request('/api/skills/upload', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--y',
    });
    expect(garbage.status).toBe(400);

    const matrixText = await ctx.app.request('/api/skills/matrix', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ slug: 'builder', skill: 'x', on: true }),
    });
    expect(matrixText.status).toBe(415);
    const formPost = await ctx.app.request('/api/skills/git/commit', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'message=x&push=true',
    });
    expect(formPost.status).toBe(415);

    const phaseTwoWrite = await ctx.app.request('/api/skills/sync', {
      method: 'POST', headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(phaseTwoWrite.status).toBe(403);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test('add routes resolve the skills library per request and emit skills.updated after writes', async () => {
  const { base, paths } = sandbox();
  const previous = Object.fromEntries(['HOME', 'SPARROW_HOME', 'SPARROW_SKILLS_HOME', 'SPARROW_SKILLS_DIR', 'SPARROW_PORT']
    .map((key) => [key, process.env[key]]));
  try {
    const first = join(paths.home, 'LibraryOne');
    const second = join(paths.home, 'LibraryTwo');
    process.env.HOME = paths.home;
    process.env.SPARROW_HOME = paths.sparrowHome;
    process.env.SPARROW_SKILLS_HOME = paths.home;
    process.env.SPARROW_SKILLS_DIR = first;
    process.env.SPARROW_PORT = '4040';
    const ctx = await setup();
    ctx.events.length = 0;
    // Absolute URL: the D13 guard checks Origin against the port the request arrived on (the Host header).
    const requestCreate = (name: string) => ctx.app.request('http://localhost:4040/api/skills', {
      method: 'POST', headers: { origin: 'http://localhost:4040', 'content-type': 'application/json' },
      body: JSON.stringify({ name, description: 'Created in the active library.', harnesses: [] }),
    });

    expect((await requestCreate('first-skill')).status).toBe(201);
    expect(existsSync(join(first, 'first-skill', 'SKILL.md'))).toBe(true);
    expect(ctx.events.filter((event) => event.type === 'skills.updated')).toHaveLength(1);
    process.env.SPARROW_SKILLS_DIR = second;
    expect((await requestCreate('second-skill')).status).toBe(201);
    expect(existsSync(join(second, 'second-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(first, 'second-skill'))).toBe(false);
    expect(ctx.events.filter((event) => event.type === 'skills.updated')).toHaveLength(2);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test('add routes return 4xx errors for missing sources, malformed multipart, path collisions, and write-fence failures', async () => {
  const { base, paths } = sandbox();
  try {
    const app = mountSkillAddRoutes(new Hono(), { paths });
    const missing = await app.request('/api/skills/import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: join(base, 'missing') }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain('does not exist');

    const malformed = await app.request('/api/skills/upload', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=broken' }, body: 'not a multipart body',
    });
    expect(malformed.status).toBe(400);

    const collision = new FormData();
    collision.append('files', new File(['x'], 'safe-skill/item'));
    collision.append('files', new File(['x'], 'safe-skill/item/child'));
    const collisionResponse = await app.request('/api/skills/upload', { method: 'POST', body: collision });
    expect(collisionResponse.status).toBe(400);
    expect((await collisionResponse.json()).error).toContain('both a file and a directory');

    const longName = new FormData();
    longName.append('files', new File(['x'], `safe-skill/${'x'.repeat(256)}.txt`));
    const longNameResponse = await app.request('/api/skills/upload', { method: 'POST', body: longName });
    expect(longNameResponse.status).toBe(400);
    expect((await longNameResponse.json()).error).toContain('too long');

    // A staging folder outside the sandbox is still refused by the write fence (a SPARROW_HOME outside it is not: see paths.staging).
    const badPaths = { ...paths, staging: join(base, 'outside', 'skills-staging') };
    const fenced = await mountSkillAddRoutes(new Hono(), { paths: badPaths }).request('/api/skills/upload', {
      method: 'POST', body: uploadForm(makeZip([{ name: 'safe-skill/SKILL.md', data: '---\nname: safe-skill\ndescription: x\n---\n' }])),
    });
    expect(fenced.status).toBe(400);
    expect((await fenced.json()).error).toContain('Refusing write outside');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the mounted API serves /api/skills/updates before the dynamic skill detail route', async () => {
  const { base, paths } = sandbox();
  const previous = {
    HOME: process.env.HOME,
    SPARROW_HOME: process.env.SPARROW_HOME,
    SPARROW_SKILLS_HOME: process.env.SPARROW_SKILLS_HOME,
    SPARROW_SKILLS_DIR: process.env.SPARROW_SKILLS_DIR,
  };
  try {
    process.env.HOME = paths.home;
    process.env.SPARROW_HOME = paths.sparrowHome;
    process.env.SPARROW_SKILLS_HOME = paths.home;
    process.env.SPARROW_SKILLS_DIR = paths.library;
    const ctx = await setup();
    const response = await ctx.app.request('/api/skills/updates', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.SPARROW_HOME === undefined) delete process.env.SPARROW_HOME; else process.env.SPARROW_HOME = previous.SPARROW_HOME;
    if (previous.SPARROW_SKILLS_HOME === undefined) delete process.env.SPARROW_SKILLS_HOME; else process.env.SPARROW_SKILLS_HOME = previous.SPARROW_SKILLS_HOME;
    if (previous.SPARROW_SKILLS_DIR === undefined) delete process.env.SPARROW_SKILLS_DIR; else process.env.SPARROW_SKILLS_DIR = previous.SPARROW_SKILLS_DIR;
    rmSync(base, { recursive: true, force: true });
  }
});
