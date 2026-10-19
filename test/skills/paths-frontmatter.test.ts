import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { assertWritable, skillPaths } from '../../src/skills/paths';
import { parseSkillFrontmatter, validateFrontmatter } from '../../src/skills/frontmatter';
import { sandbox } from './helpers';

test('skillPaths honors explicit harness roots and expands settings skills_dir against resolved HOME', () => {
  const { home } = sandbox();
  const configHome = join(home, '.sparrow');
  mkdirSync(configHome, { recursive: true });
  writeFileSync(join(configHome, 'config.json'), JSON.stringify({ skills_dir: '~/My Library' }));
  const paths = skillPaths({
    HOME: home, SPARROW_HOME: configHome, CLAUDE_CONFIG_DIR: '~/claude-config',
    CODEX_HOME: '~/codex-home', XDG_CONFIG_HOME: '~/xdg',
  });
  expect(paths.home).toBe(home);
  expect(paths.library).toBe(join(home, 'My Library'));
  expect(paths.roots.claude).toBe(join(home, 'claude-config', 'skills'));
  expect(paths.roots.codex).toBe(join(home, 'codex-home', 'skills'));
  expect(paths.roots.opencode).toBe(join(home, 'xdg', 'opencode', 'skills'));
});

test('SPARROW_SKILLS_HOME overrides HOME and ignores all harness path overrides', () => {
  const { home } = sandbox();
  const paths = skillPaths({
    HOME: '/outside/home', SPARROW_SKILLS_HOME: home, SPARROW_HOME: join(home, '.sparrow'),
    CODEX_HOME: '/outside/codex', XDG_CONFIG_HOME: '/outside/xdg', CLAUDE_CONFIG_DIR: '/outside/claude',
  });
  expect(paths.home).toBe(home);
  expect(paths.library).toBe(join(home, 'Skills'));
  expect(paths.roots.claude).toBe(join(home, '.claude', 'skills'));
  expect(paths.roots.codex).toBe(join(home, '.codex', 'skills'));
  expect(paths.roots.opencode).toBe(join(home, '.config', 'opencode', 'skills'));
  expect(paths.roots.agents).toBe(join(home, '.agents', 'skills'));
  expect(paths.roots['claude-synced']).toBe(join(home, '.claude', 'skills', 'synced'));
});

test('assertWritable fences paths and resolves symlinked parents before allowing writes', () => {
  const { root, home, paths } = sandbox();
  mkdirSync(paths.roots.claude, { recursive: true });
  expect(assertWritable(join(paths.roots.claude, 'new-skill'), paths)).toBe(join(paths.roots.claude, 'new-skill'));
  expect(() => assertWritable(join(home, 'outside.txt'), paths)).toThrow('Refusing write outside');
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  const escape = join(paths.roots.claude, 'escape');
  symlinkSync(outside, escape, 'dir');
  expect(() => assertWritable(join(escape, 'file.txt'), paths)).toThrow('Refusing write outside');
  expect(existsSync(join(outside, 'file.txt'))).toBe(false);
});

test('production write fence rejects adjacent config and agents roots with a fake HOME', () => {
  const { home } = sandbox();
  const paths = skillPaths({ HOME: home, SPARROW_HOME: join(home, '.sparrow') });
  expect(paths.sandboxHome).toBe(false);
  expect(() => assertWritable(join(home, '.agents', 'skills', 'example'), paths)).toThrow('Refusing write outside');
  expect(() => assertWritable(join(home, '.claude', 'evil'), paths)).toThrow('Refusing write outside');
  expect(() => assertWritable(join(home, '.codex', 'config.toml'), paths)).toThrow('Refusing write outside');
  expect(() => assertWritable(join(home, '.config', 'other-tool', 'config.json'), paths)).toThrow('Refusing write outside');
  expect(assertWritable(join(home, '.claude', 'skills', 'example'), paths)).toBe(join(home, '.claude', 'skills', 'example'));
  expect(assertWritable(join(home, '.config', 'opencode', 'skills', 'example'), paths)).toBe(join(home, '.config', 'opencode', 'skills', 'example'));
});

test('strict YAML errors are recorded while lenient parsing preserves the skill listing fields', () => {
  sandbox();
  const parsed = parseSkillFrontmatter(`---\nname: linear-ticket\ndescription: Use this for tickets: title and body.\n---\nBody\n`, 'linear-ticket');
  expect(parsed.frontmatter?.name).toBe('linear-ticket');
  expect(parsed.frontmatter?.description).toBe('Use this for tickets: title and body.');
  expect(parsed.problems.some((p) => p.code === 'yaml')).toBe(true);
  const sparrow = readFileSync(join(import.meta.dir, '../../assets/skills/sparrow-captain/SKILL.md'), 'utf8');
  const source = parseSkillFrontmatter(sparrow, 'sparrow-captain');
  expect(source.frontmatter?.name).toBe('sparrow-captain');
  expect(source.problems.some((p) => p.code === 'yaml')).toBe(false);
});

test('spec validation covers name format and folder mismatch, description, compatibility, and nested metadata', () => {
  sandbox();
  const result = parseSkillFrontmatter(`---\nname: Music\ndescription: Fine\ncompatibility: ${'x'.repeat(501)}\nmetadata:\n  openclaw:\n    enabled: true\n---\n`, 'elevenlabs-music');
  const codes = result.problems.map((p) => p.code);
  expect(codes).toContain('name-format');
  expect(codes).toContain('name-folder');
  expect(codes).toContain('compatibility-length');
  expect(codes).toContain('metadata-type');
  expect(validateFrontmatter({ name: 'bad--name', description: '' }, 'bad--name').map((p) => p.code)).toContain('description-length');
});

test('valid frontmatter preserves unknown and harness-specific values', () => {
  sandbox();
  const result = parseSkillFrontmatter(`---\nname: docs\ndescription: Create docs.\nmetadata:\n  author: Nina\nargument-hint: "[topic]"\n---\nBody\n`, 'docs');
  expect(result.problems).toEqual([]);
  expect(result.frontmatter?.values['argument-hint']).toBe('[topic]');
  expect(result.frontmatter?.values.metadata).toEqual({ author: 'Nina' });
});
