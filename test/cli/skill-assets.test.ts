// Sparrow's shipped skills must have spec-valid frontmatter that strict YAML parsers accept
// (an unquoted ": " in a description breaks Bun.YAML, Vercel's `skills` CLI and OpenCode's loader).
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS } from '../../src/shared/config';

const dir = join(ASSETS, 'skills');
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('assets/skills frontmatter', () => {
  for (const name of readdirSync(dir)) {
    test(name, () => {
      const text = readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(m).not.toBeNull();
      const fm = Bun.YAML.parse(m![1]) as Record<string, unknown>;
      expect(fm.name).toBe(name);
      expect(NAME_RE.test(name) && name.length <= 64).toBe(true);
      expect(typeof fm.description).toBe('string');
      expect((fm.description as string).length).toBeGreaterThan(0);
      expect((fm.description as string).length).toBeLessThanOrEqual(1024);
    });
  }
});

// D12/D15: what agents are taught about servers and process killing.
describe('worker skill + protocol teach server/process safety', () => {
  const skill = readFileSync(join(dir, 'sparrow-worker', 'SKILL.md'), 'utf8');
  const protocol = readFileSync(join(ASSETS, 'protocol.md'), 'utf8');
  test('never start/stop/kill a server you did not create; unreachable → report and stop', () => {
    for (const t of [skill, protocol]) {
      expect(t).toMatch(/never start, stop, restart or kill a Sparrow server you did not create/i);
      expect(t).toContain('unreachable');
      expect(t).toContain('sparrow sandbox up');
    }
  });
  test('sandboxes come from `sparrow sandbox up/down`; pkill/pgrep/killall -f are forbidden', () => {
    expect(skill).toContain('sparrow sandbox up');
    expect(skill).toContain('sparrow sandbox down');
    expect(skill).toContain('SPARROW_AGENT_URL');
    expect(skill).toMatch(/Never point your own reporting at a sandbox/);
    expect(skill).toMatch(/Never\*\* `pkill -f`, `pgrep -f`, `killall`/);
    expect(protocol).toMatch(/Never `pkill -f` \/ `pgrep -f` \/ `killall`/);
  });
  test('unset identity vars only in a subshell', () => {
    for (const t of [skill, protocol]) expect(t).toContain('(unset SPARROW_AGENT_ID SPARROW_URL SPARROW_CALL_ID; bun test)');
  });
});

describe('captain skill (multi-captain)', () => {
  const text = readFileSync(join(dir, 'sparrow-captain', 'SKILL.md'), 'utf8');
  test('worktrees belong to their repo project, one captain per worktree, and --cwd does not change the project', () => {
    expect(text).toContain('Worktrees belong to their repo\'s project');
    expect(text).toContain('one captain per worktree');
    expect(text).toContain('`--cwd` only sets where a hired agent works; it never changes the project');
  });
  test('teaches one captain per session, sparrow title, the private team and how to get back in', () => {
    expect(text).toContain('One captain per session');
    expect(text).toContain('Start every job with `sparrow title');
    expect(text).toContain('Your team is private');
    for (const c of ['sparrow captains', 'sparrow captain resume', 'sparrow captain adopt', 'CLAUDE_PID']) expect(text).toContain(c);
  });
});
