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
      },
    });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    expect(code).toBe(7); // harness exit code is propagated
    expect(out).toContain("ARG1=line1\nline2 'q'");
    expect(out).toContain(`PWD=${cwd}`);
    expect(out).toContain(`AGENT=${agent.id} CALL=call_1 H=fake URL=http://127.0.0.1:4120 HOME=${TEST_HOME}`);
    expect(out).toContain('CC=unset CSID=unset CX=unset CXH=/keep OC=unset');
    expect(out).toContain(`SPARROW=${BIN}`);
    expect(out).toContain('EXTRA=e x');
  }, 20_000);
});

describe('drivers build the right commands', () => {
  test('claude new vs resume', async () => {
    const claudeJson = join(TEST_HOME, 'claude.json');
    process.env.SPARROW_CLAUDE_JSON = claudeJson;
    const agent = makeAgent({ harness: 'claude', model: 'haiku', effort: 'low' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    const a = await claudeDriver.prepare({ agent, call_id: 'c1', system_prompt: 'sys', prompt: 'hi', resume: false }, files);
    const s = buildScript(agent, 'c1', a);
    expect(s).toContain(`/claude --dangerously-skip-permissions --session-id ${a.session_id} -n ${agent.handle} --model haiku --effort low --append-system-prompt "$(cat ${files.system})" --settings `);
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
    const files = writeCallTexts(agent.id, 'c1', 'sys "q"\nline', 'hi');
    const a = await codexDriver.prepare({ agent, call_id: 'c1', system_prompt: 'sys "q"\nline', prompt: 'hi', resume: false }, files);
    expect(a.session_id).toBeNull();
    const s = buildScript(agent, 'c1', a);
    expect(s).toMatch(/codex --no-daemon --yolo -C \S+ -m gpt-x -c 'model_reasoning_effort="low"' -c "\$\(cat .*codex-developer-instructions.toml\)" -c 'notify=\[/);
    expect(readFileSync(join(files.dir, 'codex-developer-instructions.toml'), 'utf8')).toBe('developer_instructions="sys \\"q\\"\\nline"');
    const files2 = writeCallTexts(agent.id, 'c2', 's', 'hi');
    const r = await codexDriver.prepare({ agent: { ...agent, session_id: 'th-1' }, call_id: 'c2', system_prompt: 's', prompt: 'hi', resume: true }, files2);
    expect(buildScript(agent, 'c2', r)).toMatch(/codex resume --no-daemon .* th-1 "\$\(cat [^)]*c2.prompt.md\)"/);
    expect(tomlString('a"b')).toBe('"a\\"b"');
    expect(trustValue('/x.y')).toContain('"/x.y" = { trust_level = "trusted" }');
    const sub = join(agent.cwd, 'pkg');
    Bun.spawnSync(['git', 'init', '-q', agent.cwd]);
    Bun.spawnSync(['mkdir', '-p', sub]);
    expect(trustValue(sub)).toContain(`${JSON.stringify(agent.cwd)} = { trust_level = "trusted" }`);
  });

  test('opencode new vs resume', async () => {
    const agent = makeAgent({ harness: 'opencode', model: 'opencode-go/glm-5.3-flash' });
    const files = writeCallTexts(agent.id, 'c1', 'sys', 'hi');
    const a = await opencodeDriver.prepare({ agent, call_id: 'c1', system_prompt: 'sys', prompt: 'hi', resume: false }, files);
    const s = buildScript(agent, 'c1', a);
    expect(s).toMatch(/opencode \S+ --auto --agent sparrow -m opencode-go\/glm-5.3-flash --prompt "\$\(cat /);
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
    expect(b[0]).toBe(`OpenCode plugin: ${join(TEST_HOME, 'opencode', 'plugins', 'sparrow.js')} (up to date)`);
    expect(a.length).toBe(4);
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

  test('prepare exports XDG_STATE_HOME for the agent', async () => {
    const agent = makeAgent({ harness: 'opencode', model: 'opencode-go/x', effort: 'high' });
    const files = writeCallTexts(agent.id, 'c1', 's', 'p');
    const r = await opencodeDriver.prepare({ agent, call_id: 'c1', system_prompt: 's', prompt: 'p', resume: false }, files);
    expect(r.env!.XDG_STATE_HOME).toBe(join(TEST_HOME, 'agents', agent.id, 'opencode-state'));
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
