// Per-agent skills at launch: what each driver's prepare() puts in argv / env / files for a grant set.
import { TEST_HOME, makeAgent } from './helpers';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillGrant, StartSpec } from '../../src/harness/index';
import { agentDir } from '../../src/harness/env';
import { buildScript, writeCallTexts } from '../../src/harness/launch';
import { claudeDriver } from '../../src/harness/drivers/claude';
import { agentCodexHome, agentsSkillPaths, codexDriver, skillsConfigValue } from '../../src/harness/drivers/codex';
import { opencodeConfig, opencodeDriver, opencodeSkillsDir, prepareSkills, projectSkillRoots } from '../../src/harness/drivers/opencode';
import { fakeDriver } from '../../src/harness/drivers/fake';
import { ASSETS } from '../../src/shared/config';

const SPARROW = [
  { name: 'sparrow-worker', path: join(ASSETS, 'skills', 'sparrow-worker') },
  { name: 'sparrow-captain', path: join(ASSETS, 'skills', 'sparrow-captain') },
];
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `sp-sl-${p}-`));
function skill(root: string, folder: string, name = folder) {
  const d = join(root, folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${folder}\n---\n`);
  return d;
}

let lib: string, alpha: SkillGrant, beta: SkillGrant;
let fakeHome: string, realCodex: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['HOME', 'SPARROW_SKILLS_HOME', 'SPARROW_SKILLS_DIR', 'CODEX_HOME']) saved[k] = process.env[k];
  fakeHome = tmp('home');
  realCodex = join(fakeHome, '.codex');
  mkdirSync(realCodex, { recursive: true });
  writeFileSync(join(realCodex, 'auth.json'), '{"tok":1}');
  writeFileSync(join(realCodex, 'config.toml'), 'model = "x"\n');
  process.env.HOME = fakeHome;
  process.env.SPARROW_SKILLS_HOME = fakeHome;
  process.env.CODEX_HOME = realCodex;
  lib = tmp('lib');
  process.env.SPARROW_SKILLS_DIR = lib; // the launch-time boundary: granted folders must still be inside the library
  alpha = { name: 'alpha', path: skill(lib, 'alpha') };
  beta = { name: 'beta', path: skill(lib, 'beta', 'beta-front') }; // frontmatter name differs from the folder
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const specFor = (agent: ReturnType<typeof makeAgent>, skills?: SkillGrant[], resume = false): StartSpec =>
  ({ agent, call_id: 'c1', system_prompt: 'sys', prompt: 'hi', resume, skills });

describe('claude: per-agent plugin dir', () => {
  test('--plugin-dir is <agentDir>/claude-plugin holding exactly the grants; rebuilt each call', async () => {
    process.env.SPARROW_CLAUDE_JSON = join(TEST_HOME, 'claude.json');
    const agent = makeAgent({ harness: 'claude' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    const dir = join(agentDir(agent.id), 'claude-plugin');
    const a = await claudeDriver.prepare(specFor(agent, [...SPARROW, alpha, beta]), files);
    expect(buildScript(agent, 'c1', a)).toContain(`--setting-sources project,local --plugin-dir ${dir} --session-id`);
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('sparrow');
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['alpha', 'beta', 'sparrow-captain', 'sparrow-worker']);
    expect(readlinkSync(join(dir, 'skills', 'alpha'))).toBe(alpha.path);
    expect(readlinkSync(join(dir, 'skills', 'sparrow-worker'))).toBe(SPARROW[0].path);
    // next call with a smaller grant: stale links go, real entries stay
    mkdirSync(join(dir, 'skills', 'real-dir'));
    await claudeDriver.prepare(specFor(agent, [alpha]), files);
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['alpha', 'real-dir', 'sparrow-captain', 'sparrow-worker']);
    // undefined grant ⇒ Sparrow's skills only
    await claudeDriver.prepare(specFor(agent, undefined), files);
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['real-dir', 'sparrow-captain', 'sparrow-worker']);
    delete process.env.SPARROW_CLAUDE_JSON;
  });

  test('resume without a skills list keeps Claude built-ins, Sparrow skills and project skills without user skills', async () => {
    const cwd = tmp('claude-project');
    const project = skill(join(cwd, '.claude', 'skills'), 'project-claude');
    const global = skill(join(fakeHome, '.claude', 'skills'), 'global-claude');
    process.env.SPARROW_CLAUDE_JSON = join(TEST_HOME, 'claude-no-list.json');
    const agent = makeAgent({ harness: 'claude', cwd, session_id: 'claude-session' });
    const a = await claudeDriver.prepare(specFor(agent, undefined, true), writeCallTexts(agent.id, 'c1', 'sys', 'hi'));
    const argv = a.argv as string[];
    const pluginDir = argv[argv.indexOf('--plugin-dir') + 1];
    expect(argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project,local']);
    expect(argv).toContain('--resume');
    expect(argv).toContain('claude-session');
    expect(readdirSync(join(pluginDir, 'skills')).sort()).toEqual(['sparrow-captain', 'sparrow-worker']);
    expect(readlinkSync(join(pluginDir, 'skills', 'sparrow-worker'))).toBe(SPARROW[0].path);
    expect(existsSync(project)).toBe(true);
    expect(existsSync(global)).toBe(true);
    expect(pluginDir).not.toContain(global);
    delete process.env.SPARROW_CLAUDE_JSON;
  });
});

describe('codex: user instructions, policy and MCP credentials follow the agent into its own home', () => {
  test('AGENTS.md, rules/, prompts/, .credentials.json and plugins/ are linked; sessions and SQLite state stay private', async () => {
    writeFileSync(join(realCodex, 'AGENTS.md'), 'global rules');
    mkdirSync(join(realCodex, 'rules'), { recursive: true });
    writeFileSync(join(realCodex, 'rules', 'default.rules'), 'r');
    mkdirSync(join(realCodex, 'prompts'), { recursive: true });
    writeFileSync(join(realCodex, '.credentials.json'), '{}');
    mkdirSync(join(realCodex, 'plugins', 'p', 'skills', 'leak'), { recursive: true });
    mkdirSync(join(realCodex, 'sessions'), { recursive: true });
    writeFileSync(join(realCodex, 'state_5.sqlite'), '');
    const agent = makeAgent({ harness: 'codex', model: 'gpt-x' });
    await codexDriver.prepare(specFor(agent, [...SPARROW]), writeCallTexts(agent.id, 'c1', 'sys', 'hi'));
    const home = agentCodexHome(agent.id);
    for (const f of ['AGENTS.md', 'rules', 'prompts', '.credentials.json', 'plugins']) {
      expect(lstatSync(join(home, f)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, f))).toBe(join(realCodex, f));
    }
    for (const f of ['sessions', 'state_5.sqlite']) expect(existsSync(join(home, f))).toBe(false);
  });
});

describe('launch-time boundary', () => {
  test('a snapshot grant whose real path left the library (or never was in it) is not linked by any driver', async () => {
    process.env.SPARROW_CLAUDE_JSON = join(TEST_HOME, 'claude.json');
    const outside = skill(tmp('outside'), 'sneaky');
    symlinkSync(outside, join(lib, 'sneaky'), 'dir'); // swapped for an outside symlink after hire
    const grants: SkillGrant[] = [...SPARROW, alpha, { name: 'sneaky', path: join(lib, 'sneaky') }, { name: 'elsewhere', path: outside }];
    const claude = makeAgent({ harness: 'claude' });
    await claudeDriver.prepare(specFor(claude, grants), writeCallTexts(claude.id, 'c1', 's', 'p'));
    expect(readdirSync(join(agentDir(claude.id), 'claude-plugin', 'skills')).sort()).toEqual(['alpha', 'sparrow-captain', 'sparrow-worker']);
    const codex = makeAgent({ harness: 'codex' });
    await codexDriver.prepare(specFor(codex, grants), writeCallTexts(codex.id, 'c1', 's', 'p'));
    expect(readdirSync(join(agentCodexHome(codex.id), 'skills')).sort()).toEqual(['alpha', 'sparrow-captain', 'sparrow-worker']);
    const oc = makeAgent({ harness: 'opencode' });
    const a = await opencodeDriver.prepare(specFor(oc, grants), writeCallTexts(oc.id, 'c1', 's', 'p'));
    expect(readdirSync(join(agentDir(oc.id), 'skills')).sort()).toEqual(['alpha', 'sparrow-captain', 'sparrow-worker']);
    expect(Object.keys(JSON.parse(a.env!.OPENCODE_CONFIG_CONTENT).agent.sparrow.permission.skill)).not.toContain('sneaky');
    delete process.env.SPARROW_CLAUDE_JSON;
  });
});

describe('opencode: skills.paths + allowlist', () => {
  test('a real entry shadowing a grant in the agent skills dir keeps that grant out of the allowlist', () => {
    const agent = makeAgent({ harness: 'opencode', model: 'm' });
    mkdirSync(join(opencodeSkillsDir(agent.id), 'alpha'), { recursive: true }); // a real folder, not our link
    const res = prepareSkills(agent.id, [...SPARROW, alpha, beta]);
    expect(res.names).not.toContain('alpha');
    expect(res.names).toContain('beta-front');
    expect(lstatSync(join(opencodeSkillsDir(agent.id), 'alpha')).isSymbolicLink()).toBe(false);
  });

  test('env, config and links', async () => {
    const agent = makeAgent({ harness: 'opencode', model: 'opencode/big-pickle' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    const a = await opencodeDriver.prepare(specFor(agent, [...SPARROW, alpha, beta]), files);
    const skillsDir = join(agentDir(agent.id), 'skills');
    expect(a.env!.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');
    expect(a.env!.XDG_CONFIG_HOME).toBeUndefined();
    const cfg = JSON.parse(a.env!.OPENCODE_CONFIG_CONTENT);
    expect(cfg.skills).toEqual({ paths: [skillsDir] });
    const perm = cfg.agent.sparrow.permission.skill;
    // "*": deny first (last match wins); frontmatter names (beta-front), not folder names; built-in kept
    expect(Object.keys(perm)).toEqual(['*', 'customize-opencode', 'sparrow-worker', 'sparrow-captain', 'alpha', 'beta-front']);
    expect(perm['*']).toBe('deny');
    expect(Object.entries(perm).filter(([k]) => k !== '*').every(([, v]) => v === 'allow')).toBe(true);
    expect(cfg.agent.sparrow.model).toBe('opencode/big-pickle');
    expect(cfg.instructions).toEqual([files.system]);
    expect(readdirSync(skillsDir).sort()).toEqual(['alpha', 'beta', 'sparrow-captain', 'sparrow-worker']);
    expect(readlinkSync(join(skillsDir, 'beta'))).toBe(beta.path);
    // the shared plugin config dir is untouched: no skills/ there
    expect(a.env!.OPENCODE_CONFIG_DIR).toBe(join(TEST_HOME, 'opencode'));
    expect(existsSync(join(TEST_HOME, 'opencode', 'skills'))).toBe(false);
    // next call, smaller grant
    const b = await opencodeDriver.prepare(specFor(agent, [alpha]), files);
    expect(Object.keys(JSON.parse(b.env!.OPENCODE_CONFIG_CONTENT).agent.sparrow.permission.skill)).toEqual(['*', 'customize-opencode', 'sparrow-worker', 'sparrow-captain', 'alpha']);
    expect(readdirSync(skillsDir).sort()).toEqual(['alpha', 'sparrow-captain', 'sparrow-worker']);
  });

  test('integer-like (all-digit) names: the deny moves to the top-level rules so it still comes first', () => {
    const agent = makeAgent({ harness: 'opencode' });
    const cfg: any = opencodeConfig(specFor(agent), '/s.md', { dir: '/d', paths: ['/d'], names: ['sparrow-worker', '123', 'alpha'] });
    expect(cfg.permission).toEqual({ skill: { '*': 'deny' } });
    expect(cfg.agent.sparrow.permission.skill).toEqual({ 'customize-opencode': 'allow', '123': 'allow', 'sparrow-worker': 'allow', alpha: 'allow' });
    expect('*' in cfg.agent.sparrow.permission.skill).toBe(false); // would be emitted after "123" and win
    // without an integer-like name the allowlist is on the agent with "*" first, and the same rules sit at the top
    const plain: any = opencodeConfig(specFor(agent), '/s.md', { dir: '/d', paths: ['/d'], names: ['alpha'] });
    expect(Object.keys(plain.agent.sparrow.permission.skill)[0]).toBe('*');
    expect(plain.permission.skill).toEqual(plain.agent.sparrow.permission.skill);
  });

  test('subagents spawned by the task tool get the skill deny too (top-level rules)', () => {
    const agent = makeAgent({ harness: 'opencode' });
    const cfg: any = opencodeConfig(specFor(agent), '/s.md', { dir: '/d', paths: ['/d'], names: ['sparrow-worker', 'alpha'] });
    expect(Object.keys(cfg.permission.skill)[0]).toBe('*');
    expect(cfg.permission.skill).toEqual({ '*': 'deny', 'customize-opencode': 'allow', 'sparrow-worker': 'allow', alpha: 'allow' });
  });

  test('opencodeConfig without skills is unchanged (no permission, no skills.paths)', () => {
    const agent = makeAgent({ harness: 'opencode' });
    expect(opencodeConfig(specFor(agent), '/s.md')).toEqual({ instructions: ['/s.md'], agent: { sparrow: { mode: 'primary', description: 'Sparrow-managed agent' } } });
  });

  test('resume without a skills list adds project skills and omits ungranted globals from the allowlist', async () => {
    const cwd = tmp('opencode-project');
    const nested = join(cwd, 'packages', 'web');
    mkdirSync(nested, { recursive: true });
    Bun.spawnSync(['git', '-C', cwd, 'init', '-q']);
    skill(join(cwd, '.claude', 'skills'), 'project-claude');
    skill(join(nested, '.claude', 'skills'), 'nested-claude');
    skill(join(cwd, '.agents', 'skills'), 'project-agent');
    skill(join(nested, '.agents', 'skills'), 'nested-agent');
    skill(join(cwd, '.opencode', 'skills'), 'project-opencode');
    skill(join(nested, '.opencode', 'skills'), 'nested-opencode');
    skill(join(cwd, '.claude', 'skills'), 'unsafe-name', '*');
    skill(join(fakeHome, '.claude', 'skills'), 'global-claude');
    skill(join(fakeHome, '.agents', 'skills'), 'global-agent');
    skill(join(fakeHome, '.config', 'opencode', 'skills'), 'global-opencode');

    const roots = projectSkillRoots(nested);
    expect(roots.paths).toEqual([
      realpathSync(join(cwd, '.claude', 'skills')), realpathSync(join(nested, '.claude', 'skills')),
      realpathSync(join(cwd, '.agents', 'skills')), realpathSync(join(nested, '.agents', 'skills')),
    ]);
    expect(roots.names.sort()).toEqual(['nested-agent', 'nested-claude', 'nested-opencode', 'project-agent', 'project-claude', 'project-opencode']);

    const agent = makeAgent({ harness: 'opencode', cwd: nested, session_id: 'opencode-session' });
    const a = await opencodeDriver.prepare(specFor(agent, undefined, true), writeCallTexts(agent.id, 'c1', 'sys', 'hi'));
    const cfg = JSON.parse(a.env!.OPENCODE_CONFIG_CONTENT);
    expect(a.argv as string[]).toContain('-s');
    expect(a.argv as string[]).toContain('opencode-session');
    expect(cfg.skills.paths).toEqual([opencodeSkillsDir(agent.id), ...roots.paths]);
    const allows = cfg.agent.sparrow.permission.skill;
    for (const name of ['customize-opencode', 'sparrow-worker', 'sparrow-captain', ...roots.names]) expect(allows[name]).toBe('allow');
    for (const name of ['global-claude', 'global-agent', 'global-opencode']) expect(allows[name]).toBeUndefined();
    expect(allows['*']).toBe('deny'); // invalid frontmatter name "*" cannot override the catch-all
    expect(a.env!.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');
    expect(a.env!.XDG_CONFIG_HOME).toBeUndefined();
  });

  test('non-Git cwd walks ancestor project skills but does not re-add user-global .claude or .agents roots', () => {
    const cwd = join(fakeHome, 'no-git', 'parent', 'child');
    mkdirSync(cwd, { recursive: true });
    skill(join(fakeHome, '.claude', 'skills'), 'global-claude');
    skill(join(fakeHome, '.agents', 'skills'), 'global-agent');
    skill(join(fakeHome, 'no-git', '.claude', 'skills'), 'ancestor-claude');
    skill(join(fakeHome, 'no-git', 'parent', '.agents', 'skills'), 'parent-agent');
    skill(join(cwd, '.claude', 'skills'), 'cwd-claude');

    const roots = projectSkillRoots(cwd);
    expect(roots.paths).toEqual([
      realpathSync(join(fakeHome, 'no-git', '.claude', 'skills')),
      realpathSync(join(cwd, '.claude', 'skills')),
      realpathSync(join(fakeHome, 'no-git', 'parent', '.agents', 'skills')),
    ]);
    expect(roots.names.sort()).toEqual(['ancestor-claude', 'cwd-claude', 'parent-agent']);
    expect(roots.names).not.toContain('global-claude');
    expect(roots.names).not.toContain('global-agent');
  });

  test('a grant whose folder lost SKILL.md is neither linked nor allowed', async () => {
    const agent = makeAgent({ harness: 'opencode' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    const a = await opencodeDriver.prepare(specFor(agent, [alpha, { name: 'gone', path: join(lib, 'gone') }]), files);
    expect(Object.keys(JSON.parse(a.env!.OPENCODE_CONFIG_CONTENT).agent.sparrow.permission.skill)).not.toContain('gone');
  });
});

describe('codex: per-agent CODEX_HOME', () => {
  function agentsRoot() {
    const root = join(fakeHome, '.agents', 'skills');
    skill(root, 'aws-one');
    skill(root, "odd 'name\" two"); // spaces + both quote kinds
    const outside = skill(tmp('ext'), 'linked-skill');
    symlinkSync(outside, join(root, 'terminal-browser'), 'dir'); // symlinked entry
    mkdirSync(join(root, 'no-skill-md'));
    return root;
  }

  test('home, symlinked auth/config, skills links, env, and the skills.config TOML array', async () => {
    const root = agentsRoot();
    const pluginRoot = join(realCodex, 'plugins', 'cache', 'openai-primary-runtime', 'documents', '1');
    mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'documents', version: '1', description: 'Docs', skills: './skills/' }));
    skill(join(pluginRoot, 'skills'), 'doc-skill');
    writeFileSync(join(realCodex, 'config.toml'), '[features]\nplugins = true\n[plugins."documents@openai-primary-runtime"]\nenabled = true\n');
    const agent = makeAgent({ harness: 'codex', model: 'gpt-x' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    const a = await codexDriver.prepare(specFor(agent, [...SPARROW, alpha, beta]), files);
    const home = agentCodexHome(agent.id);
    expect(home).toBe(join(agentDir(agent.id), 'codex-home'));
    expect(a.env).toEqual({ CODEX_HOME: home });
    // auth.json / config.toml are symlinks to the real files, never copies
    for (const f of ['auth.json', 'config.toml']) {
      expect(lstatSync(join(home, f)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, f))).toBe(join(realCodex, f));
    }
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"tok":1}');
    expect(readlinkSync(join(home, 'plugins'))).toBe(join(realCodex, 'plugins'));
    expect(existsSync(join(home, 'plugins', 'cache', 'openai-primary-runtime', 'documents', '1', 'skills', 'doc-skill', 'SKILL.md'))).toBe(true);
    writeFileSync(join(realCodex, 'config.toml'), 'model = "updated"\n');
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('model = "updated"\n');
    // absent optional config is simply not linked
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
    expect(readdirSync(join(home, 'skills')).sort()).toEqual(['alpha', 'beta', 'sparrow-captain', 'sparrow-worker']);
    // -c skills.config=[…] is present, parses as TOML, and lists every entry of the agents root
    const argv = a.argv as string[];
    const arg = argv.filter((x, i) => argv[i - 1] === '-c' && typeof x === 'string' && x.startsWith('skills.config='))[0];
    expect(arg).toBeDefined();
    const parsed = Bun.TOML.parse(arg) as { skills: { config: { path: string; enabled: boolean }[] } };
    const paths = parsed.skills.config.map((e) => e.path).sort();
    expect(paths).toEqual([
      join(root, 'aws-one', 'SKILL.md'), join(root, "odd 'name\" two", 'SKILL.md'), join(root, 'terminal-browser', 'SKILL.md'),
    ].sort());
    expect(parsed.skills.config.every((e) => e.enabled === false)).toBe(true);
    // notify + trust are kept
    expect(argv.some((x) => typeof x === 'string' && x.startsWith('notify='))).toBe(true);
    expect(argv.some((x) => typeof x === 'string' && x.startsWith('projects='))).toBe(true);
    // the launch script exports CODEX_HOME for this agent
    expect(buildScript(agent, 'c1', a)).toContain(`export CODEX_HOME=${home}`);
  });

  test('stale skill links are removed on the next call; Codex\'s .system and a real auth file are left alone', async () => {
    const agent = makeAgent({ harness: 'codex' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    await codexDriver.prepare(specFor(agent, [alpha, beta]), files);
    const home = agentCodexHome(agent.id);
    mkdirSync(join(home, 'skills', '.system'));
    await codexDriver.prepare(specFor(agent, [beta]), files);
    expect(readdirSync(join(home, 'skills')).sort()).toEqual(['.system', 'beta', 'sparrow-captain', 'sparrow-worker']);
    // a refreshed auth.json that Codex replaced with a real file is not overwritten
    const real = join(home, 'auth.json');
    require('node:fs').unlinkSync(real);
    writeFileSync(real, '{"tok":2}');
    await codexDriver.prepare(specFor(agent, [beta]), files);
    expect(lstatSync(real).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(realCodex, 'auth.json'), 'utf8')).toBe('{"tok":1}');
  });

  test('resume keeps the same CODEX_HOME; no agents root → no skills.config', async () => {
    const agent = makeAgent({ harness: 'codex' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    const a = await codexDriver.prepare({ ...specFor(agent, [alpha], true), agent: { ...agent, session_id: 'th-1' } }, files);
    expect(a.env!.CODEX_HOME).toBe(agentCodexHome(agent.id));
    expect((a.argv as string[])[1]).toBe('resume');
    expect((a.argv as string[]).some((x) => typeof x === 'string' && x.startsWith('skills.config='))).toBe(false);
  });

  test('resume without a skills list keeps Sparrow defaults and the project .agents skill', async () => {
    const cwd = tmp('codex-project');
    const root = join(cwd, '.agents', 'skills');
    skill(root, 'project-agent');
    Bun.spawnSync(['git', '-C', cwd, 'init', '-q']);
    const agent = makeAgent({ harness: 'codex', cwd, session_id: 'codex-session' });
    const a = await codexDriver.prepare(specFor(agent, undefined, true), writeCallTexts(agent.id, 'c1', 'sys', 'hi'));
    const home = agentCodexHome(agent.id);
    expect((a.argv as string[])[1]).toBe('resume');
    expect(readdirSync(join(home, 'skills')).sort()).toEqual(['sparrow-captain', 'sparrow-worker']);
    expect((a.argv as string[]).some((x) => typeof x === 'string' && x.startsWith('skills.config='))).toBe(false);
    expect(existsSync(join(root, 'project-agent', 'SKILL.md'))).toBe(true);
  });

  test('skillsConfigValue quotes paths with spaces, quotes and backslashes as TOML basic strings', () => {
    expect(skillsConfigValue([])).toBeNull();
    const weird = ['/a b/SKILL.md', '/q"uote/SKILL.md', '/back\\slash/SKILL.md', "/it's/SKILL.md"];
    const v = skillsConfigValue(weird)!;
    expect((Bun.TOML.parse(v) as any).skills.config.map((e: any) => e.path)).toEqual(weird);
  });

  test('agentsSkillPaths follows symlinked entries and skips folders without SKILL.md', () => {
    const root = agentsRoot();
    expect(agentsSkillPaths([root]).map((p) => p.slice(root.length + 1)).sort()).toEqual(
      ["aws-one/SKILL.md", `odd 'name" two/SKILL.md`, 'terminal-browser/SKILL.md'].sort(),
    );
  });
});

describe('fake: records the grants', () => {
  test('fake-skills.json in the agent dir', async () => {
    const agent = makeAgent({ harness: 'fake' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    await fakeDriver.prepare(specFor(agent, [...SPARROW, alpha]), files);
    const rec = JSON.parse(readFileSync(join(files.dir, 'fake-skills.json'), 'utf8'));
    expect(rec.call_id).toBe('c1');
    expect(rec.skills.map((g: SkillGrant) => g.name)).toEqual(['sparrow-worker', 'sparrow-captain', 'alpha']);
    await fakeDriver.prepare(specFor(agent, undefined), files);
    expect(JSON.parse(readFileSync(join(files.dir, 'fake-skills.json'), 'utf8')).skills).toBeNull();
  });
});
