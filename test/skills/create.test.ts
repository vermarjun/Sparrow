import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkill } from '../../src/skills/create';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter';
import { readManifest } from '../../src/skills/manifest';
import { skillPaths } from '../../src/skills/paths';

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'skills-create-'));
  const home = join(base, 'home');
  const paths = skillPaths({ HOME: home, SPARROW_SKILLS_HOME: home, SPARROW_HOME: join(home, '.sparrow') });
  return { base, paths };
}

test('create writes a spec-valid starter skill, manifest and requested links', () => {
  const { base, paths } = sandbox();
  try {
    const result = createSkill('note-taking', 'Capture concise notes: safely.', ['claude', 'codex'], paths);
    expect(result.skill).toEqual({ name: 'note-taking', description: 'Capture concise notes: safely.', harnesses: ['claude', 'codex'] });
    const skillMd = readFileSync(join(paths.library, 'note-taking', 'SKILL.md'), 'utf8');
    expect(parseSkillFrontmatter(skillMd, 'note-taking').problems).toEqual([]);
    expect(skillMd).toContain('<!-- Add focused instructions for this skill. -->');
    expect(readManifest(paths.library).skills['note-taking']?.harnesses).toEqual(['claude', 'codex']);
    expect(existsSync(join(paths.roots.claude, 'note-taking', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(paths.roots.codex, 'note-taking', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(paths.roots.opencode, 'note-taking'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test('create rejects invalid names, descriptions and harnesses before writing', () => {
  const { base, paths } = sandbox();
  try {
    expect(() => createSkill('../escape', 'description', [], paths)).toThrow(/name must be/);
    expect(() => createSkill('valid-name', '   ', [], paths)).toThrow(/description must be/);
    expect(() => createSkill('valid-name', 'ok', ['unknown'], paths)).toThrow(/Unsupported harness/);
    expect(existsSync(paths.library)).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('create reports a library name collision as conflict', () => {
  const { base, paths } = sandbox();
  try {
    createSkill('taken', 'A short description.', [], paths);
    expect(() => createSkill('taken', 'Another description.', [], paths)).toThrow(/already exists/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
