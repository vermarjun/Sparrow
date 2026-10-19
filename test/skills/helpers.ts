import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { afterEach } from 'bun:test';
import { skillPaths } from '../../src/skills/paths';

const REPO = join(import.meta.dir, '../..');
const SANDBOX_BASE = join(REPO, '.sandbox', 'test-skills');
const roots: string[] = [];
const previousEnv: Record<string, string | undefined> = {};
let capturedEnv = false;

afterEach(() => {
  for (const root of roots.splice(0)) {
    const archive = join(SANDBOX_BASE, 'test-backups', basename(root));
    mkdirSync(dirname(archive), { recursive: true });
    renameSync(root, archive);
  }
  if (capturedEnv) {
    for (const key of ['HOME', 'SPARROW_SKILLS_HOME', 'SPARROW_HOME']) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    capturedEnv = false;
  }
});

export function sandbox() {
  const root = join(SANDBOX_BASE, randomUUID());
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  roots.push(root);
  if (!capturedEnv) {
    for (const key of ['HOME', 'SPARROW_SKILLS_HOME', 'SPARROW_HOME']) previousEnv[key] = process.env[key];
    capturedEnv = true;
  }
  process.env.HOME = home;
  process.env.SPARROW_SKILLS_HOME = home;
  process.env.SPARROW_HOME = join(home, '.sparrow');
  const env = { HOME: home, SPARROW_SKILLS_HOME: home, SPARROW_HOME: join(home, '.sparrow') } as NodeJS.ProcessEnv;
  return { root, home, env, paths: skillPaths(env) };
}

export function makeSkill(path: string, name: string, body = 'Body\n', extra = ''): string {
  mkdirSync(path, { recursive: true });
  const content = `---\nname: ${name}\ndescription: A test skill description.${extra ? `\n${extra}` : ''}\n---\n${body}`;
  writeFileSync(join(path, 'SKILL.md'), content);
  return path;
}

export function makeSymlink(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'dir');
}
