import { TEST_HOME, makeAgent, tempDir } from './helpers';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildScript, callFiles, sq, writeCallTexts, writeScript } from '../../src/harness/launch';
import { claudeDriver, preAcceptTrust } from '../../src/harness/drivers/claude';
import { codexDriver, tomlString, trustValue } from '../../src/harness/drivers/codex';
import { opencodeDriver, opencodeConfig, screenIdle, screenBusy, seedState } from '../../src/harness/drivers/opencode';
import { BIN } from '../../src/shared/config';

describe('shell quoting', () => {
  test('sq round-trips awkward strings through bash', async () => {
    const vals = ['plain', 'with space', "it's", '$HOME `x` "q" \\ !', 'new\nline', ''];
    for (const v of vals) {
      const p = Bun.spawn(['bash', '-c', `printf %s ${sq(v)}`], { stdout: 'pipe' });
      expect(await new Response(p.stdout).text()).toBe(v);
    }
  });
});

describe('launch script', () => {
  test('cd, env identity, unsets, PATH, big texts via $(cat), exit hook', async () => {
    const cwd = tempDir("odd dir 'x' $y");
    const agent = makeAgent({ harness: 'fake', cwd });
    const files = writeCallTexts(agent.id, 'call_1', 'SYSTEM "prompt" with $vars and `ticks`', 'line1\nline2 \'q\'');
    expect(files.system).toBe(join(TEST_HOME, 'agents', agent.id, 'system.md'));
    expect(files.prompt).toBe(join(TEST_HOME, 'agents', agent.id, 'calls', 'call_1.prompt.md'));
    // A probe "harness" that prints what it got.
    const probe = join(TEST_HOME, 'probe.sh');
    await Bun.write(probe, [
      'printf "ARG1=%s\\n" "$1"; printf "ARG2=%s\\n" "$2"; printf "PWD=%s\\n" "$PWD"',
      'echo "AGENT=$SPARROW_AGENT_ID CALL=$SPARROW_CALL_ID H=$SPARROW_HARNESS URL=$SPARROW_URL HOME=$SPARROW_HOME"',
      'echo "CC=${CLAUDECODE:-unset} CSID=${CLAUDE_CODE_SESSION_ID:-unset} CX=${CODEX_THREAD_ID:-unset} CXH=${CODEX_HOME:-unset} OC=${OPENCODE_SERVER:-unset}"',
      'echo "CHILD=${CLAUDE_CODE_CHILD_SESSION:-unset} ATTENDED=${CLAUDE_CODE_SESSION_ATTENDED:-unset} EXECPATH=${CLAUDE_CODE_EXECPATH:-unset} WINDOW=$SPARROW_WINDOW AGENTURL=$SPARROW_AGENT_URL"',
      'echo "SPARROW=$(command -v sparrow)"; echo "EXTRA=$EXTRA"; exit 7',
    ].join('\n'));
    const script = buildScript(agent, 'call_1', { argv: ['bash', probe, { file: files.prompt }], env: { EXTRA: 'e x' } });
    writeScript(files.script, script);
    const p = Bun.spawn(['bash', files.script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CODEX_THREAD_ID: 't', CODEX_HOME: '/keep', OPENCODE_SERVER: 'x',
        CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_EXECPATH: '/some/claude', SPARROW_WINDOW: 'ag_STALE',
      },
    });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    expect(code).toBe(7); // harness exit code is propagated
    expect(out).toContain("ARG1=line1\nline2 'q'");
    expect(out).toContain(`PWD=${cwd}`);
    expect(out).toContain(`AGENT=${agent.id} CALL=call_1 H=fake URL=http://127.0.0.1:${process.env.SPARROW_PORT} HOME=${TEST_HOME}`);
    expect(out).toContain('CC=unset CSID=unset CX=unset CXH=/keep OC=unset');
    // D12: a server started from a Claude Code session leaks these; the harness must not inherit them
    expect(out).toContain('CHILD=unset ATTENDED=unset EXECPATH=unset');
    expect(script).toMatch(/unset .*CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_EXECPATH/);
    // D11: the marker survives `unset SPARROW_AGENT_ID` and names this agent
    expect(out).toContain(`WINDOW=${agent.id}`);
    expect(out).toContain(`AGENTURL=http://127.0.0.1:${process.env.SPARROW_PORT}`); // D19: where this agent reports
    expect(out).toContain(`SPARROW=${BIN}`);
    expect(out).toContain('EXTRA=e x');
  }, 20_000);
});

describe('sandbox skills isolation reaches the agent window', () => {
  test('the launch script exports the server\'s SPARROW_SKILLS_HOME, and omits it when the server has none', () => {
    const agent = makeAgent({ harness: 'fake', cwd: tempDir('skh-') });
    const before = process.env.SPARROW_SKILLS_HOME;
    try {
      process.env.SPARROW_SKILLS_HOME = '/sbx/skills home';
      expect(buildScript(agent, 'c1', { argv: ['true'] })).toContain(`export SPARROW_SKILLS_HOME=${sq('/sbx/skills home')}`);
      delete process.env.SPARROW_SKILLS_HOME;
      expect(buildScript(agent, 'c1', { argv: ['true'] })).not.toContain('SPARROW_SKILLS_HOME');
    } finally { if (before === undefined) delete process.env.SPARROW_SKILLS_HOME; else process.env.SPARROW_SKILLS_HOME = before; }
  });
});

describe('drivers build the right commands', () => {
  test('claude new vs resume', async () => {
    const claudeJson = join(TEST_HOME, 'claude.json');
    process.env.SPARROW_CLAUDE_JSON = claudeJson;
    const agent = makeAgent({ harness: 'claude', model: 'haiku', effort: 'low' });
    const files = writeCallTexts(agent.id, 'c1', 'SYSTEM_SECRET_MARKER_41', 'TASK_SECRET_MARKER_41');
    const a = await claudeDriver.prepare({ agent, call_id: 'c1', system_prompt: 'SYSTEM_SECRET_MARKER_41', prompt: 'TASK_SECRET_MARKER_41', resume: false }, files);
    const s = buildScript(agent, 'c1', a);
    expect(s).toContain(`/claude --dangerously-skip-permissions --setting-sources project,local --plugin-dir ${join(files.dir, 'claude-plugin')} --session-id ${a.session_id} -n ${agent.handle} --model haiku --effort low --append-system-prompt-file ${files.system} --settings `);
    expect(s).not.toContain('SYSTEM_SECRET_MARKER_41');
    expect(a.session_id).toMatch(/^[0-9a-f-]{36}$/);
    const settings = JSON.parse(readFileSync(join(files.dir, 'claude-settings.json'), 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('hook.ts claude-stop');
    // trust pre-accepted for the cwd
    const cj = JSON.parse(readFileSync(claudeJson, 'utf8'));
    expect(cj.projects[agent.cwd].hasTrustDialogAccepted).toBe(true);
    const r = await claudeDriver.prepare({ agent: { ...agent, session_id: a.session_id }, call_id: 'c2', system_prompt: 'sys', prompt: 'hi', resume: true }, files);
    expect(r.session_id).toBe(a.session_id);
    expect(buildScript(agent, 'c2', r)).toContain(`--resume ${a.session_id}`);
    delete process.env.SPARROW_CLAUDE_JSON;
  });

  test('preAcceptTrust keeps other keys and is idempotent', async () => {
    const f = join(TEST_HOME, 'claude2.json');
    await Bun.write(f, JSON.stringify({ numStartups: 5, projects: { '/a': { allowedTools: ['x'] } } }));
    expect(preAcceptTrust('/a', f)).toBe(true);
    expect(preAcceptTrust('/a', f)).toBe(false);
    const d = JSON.parse(readFileSync(f, 'utf8'));
    expect(d.numStartups).toBe(5);
    expect(d.projects['/a']).toEqual({ allowedTools: ['x'], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
  });

  test('codex new vs resume (options after `resume`)', async () => {
    const agent = makeAgent({ harness: 'codex', model: 'gpt-x', effort: 'low' });
    const system = 'SYSTEM_SECRET_MARKER_42';
    const prompt = 'TASK_SECRET_MARKER_42';
    const files = writeCallTexts(agent.id, 'c1', system, prompt);
    const a = await codexDriver.prepare({ agent, call_id: 'c1', system_prompt: system, prompt, resume: false }, files);
    expect(a.session_id).toBeNull();
    const s = buildScript(agent, 'c1', a);
    expect(s).toContain('codex --no-daemon --yolo -C');
    expect(s).toContain(`-c "$(cat ${join(files.dir, 'codex-developer-instructions.toml')})"`);
    expect(s).not.toContain(system);
    expect(s).not.toContain(prompt);
    expect(a.argv.some((arg) => typeof arg === 'object' && arg.file === files.prompt)).toBe(true);
    expect(readFileSync(join(files.dir, 'codex-developer-instructions.toml'), 'utf8')).toContain(`developer_instructions=${JSON.stringify(system)}`);
    const files2 = writeCallTexts(agent.id, 'c2', 's', 'hi');
    const r = await codexDriver.prepare({ agent: { ...agent, session_id: 'th-1' }, call_id: 'c2', system_prompt: 's', prompt: 'hi', resume: true }, files2);
    expect(buildScript(agent, 'c2', r)).toContain(`codex resume --no-daemon --yolo -C ${agent.cwd}`);
    expect(buildScript(agent, 'c2', r)).toContain(`"$(cat ${files2.prompt})"`);
    expect(tomlString('a"b')).toBe('"a\\"b"');
    expect(trustValue('/x.y')).toContain('"/x.y" = { trust_level = "trusted" }');
    const sub = join(agent.cwd, 'pkg');
    Bun.spawnSync(['git', 'init', '-q', agent.cwd]);
    Bun.spawnSync(['mkdir', '-p', sub]);
    expect(trustValue(sub)).toContain(`${JSON.stringify(agent.cwd)} = { trust_level = "trusted" }`);
  });

  test('opencode new vs resume', async () => {
    const agent = makeAgent({ harness: 'opencode', model: 'opencode-go/glm-5.3-flash' });
    const files = writeCallTexts(agent.id, 'c1', 'SYSTEM_SECRET_MARKER_43', 'TASK_SECRET_MARKER_43');
    const a = await opencodeDriver.prepare({ agent, call_id: 'c1', system_prompt: 'SYSTEM_SECRET_MARKER_43', prompt: 'TASK_SECRET_MARKER_43', resume: false }, files);
    const s = buildScript(agent, 'c1', a);
    expect(s).toMatch(/opencode \S+ --auto --agent sparrow -m opencode-go\/glm-5.3-flash --prompt "\$\(cat /);
    expect(s).not.toContain('SYSTEM_SECRET_MARKER_43');
    expect(s).not.toContain('TASK_SECRET_MARKER_43');
    expect(a.argv.some((arg) => typeof arg === 'object' && arg.file === files.prompt)).toBe(true);
    expect(JSON.parse(a.env!.OPENCODE_CONFIG_CONTENT).instructions).toEqual([files.system]);
    expect(s).toContain(`export OPENCODE_CONFIG_DIR=${join(TEST_HOME, 'opencode')}`);
    expect(existsSync(join(TEST_HOME, 'opencode', 'plugins', 'sparrow.js'))).toBe(true);
    expect(opencodeConfig({ agent: { ...agent, effort: 'max' }, call_id: 'c1', system_prompt: '', prompt: '', resume: false }, '/s.md')).toEqual({
      instructions: ['/s.md'],
      agent: { sparrow: { mode: 'primary', description: 'Sparrow-managed agent', model: 'opencode-go/glm-5.3-flash', variant: 'max' } },
    });
    const r = await opencodeDriver.prepare({ agent: { ...agent, session_id: 'ses_1' }, call_id: 'c2', system_prompt: 's', prompt: 'hi', resume: true }, files);
    const rs = buildScript(agent, 'c2', r);
    expect(rs).toContain('--auto --agent sparrow -m opencode-go/glm-5.3-flash -s ses_1\n');
    expect(rs).not.toContain('--prompt');
  });

  test('callFiles layout', () => {
    const f = callFiles('ag_x', 'call_y');
    expect(f.script).toBe(join(TEST_HOME, 'agents', 'ag_x', 'calls', 'call_y.sh'));
  });
});

describe('installHarnessAssets', () => {
  test('installs the OpenCode plugin under SPARROW_HOME, idempotent, reports binaries', async () => {
    const { installHarnessAssets } = await import('../../src/harness/install');
    const a = await installHarnessAssets();
    const b = await installHarnessAssets();
    expect(b).toContain(`OpenCode plugin: ${join(TEST_HOME, 'opencode', 'plugins', 'sparrow.js')} (up to date)`);
    expect(a.length).toBe(5);
    expect(b.some((l) => l.startsWith('claude: '))).toBe(true);
    expect(b.some((l) => l.startsWith('codex: '))).toBe(true);
    expect(b.some((l) => l.startsWith('opencode: '))).toBe(true);
  }, 30_000);
});

describe('opencode helpers (fix round 2)', () => {
  test('per-agent state dir seeds the remembered variant = effort (or clears it)', () => {
    const home = seedState('ag_seed', 'prov/model-a', 'low');
    expect(home).toBe(join(TEST_HOME, 'agents', 'ag_seed', 'opencode-state'));
    const f = join(home, 'opencode', 'model.json');
    expect(JSON.parse(readFileSync(f, 'utf8')).variant).toEqual({ 'prov/model-a': 'low' });
    seedState('ag_seed', 'prov/model-a', null);
    expect(JSON.parse(readFileSync(f, 'utf8')).variant).toEqual({});
  });

  test('prepare exports per-agent state home for the effort override', async () => {
    const agent = makeAgent({ harness: 'opencode', model: 'opencode-go/x', effort: 'high' });
    const files = writeCallTexts(agent.id, 'c1', 's', 'p');
    const r = await opencodeDriver.prepare({ agent, call_id: 'c1', system_prompt: 's', prompt: 'p', resume: false }, files);
    expect(r.env!.XDG_STATE_HOME).toBe(join(TEST_HOME, 'agents', agent.id, 'opencode-state'));
    expect(r.env!.XDG_DATA_HOME).toBeUndefined();
  });

  test('idle vs busy footer, truncated footer, transcript text ignored', () => {
    const body = 'some transcript\nThinking about esc interrupt in old text\n\n\n\n\n\n\n\n';
    const idle = body + '┃  Sparrow auto · DeepSeek V4 Flash\n╹▀▀▀▀\n  20.7K (2%) · $0.00  ctrl+p commands    • OpenCode 1.19.0';
    const busy = body + '┃  Sparrow auto · DeepSeek V4 Flash\n╹▀▀▀▀\n   ⬝⬝⬝■  esc interrupt        20.5K (2%) · $0.00  ctrl+p commands';
    const narrow = 'a\nb\nc\nd\ne\nf\ng\n┃ Sparrow auto\n╹▀▀\n 20K (2%) ctrl+p co';
    expect(screenIdle(idle)).toBe(true);
    expect(screenIdle(busy)).toBe(false);
    expect(screenBusy(busy)).toBe(true);
    expect(screenIdle(narrow)).toBe(true);
    expect(screenIdle('loading…')).toBe(false);
  });
});
