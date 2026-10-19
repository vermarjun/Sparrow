import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDriver } from '../../src/harness/drivers/claude';
import { codexDriver } from '../../src/harness/drivers/codex';
import { opencodeDriver } from '../../src/harness/drivers/opencode';
import { writeCallTexts, buildScript } from '../../src/harness/launch';
import { TEST_HOME, makeAgent } from './helpers';

describe('D10a file-backed system prompts', () => {
  test('Claude and OpenCode receive protocol by file; Codex retains its supported argv config route', async () => {
    const protocol = 'SPARROW_PROTOCOL_MARKER_9417';
    const task = 'SPARROW_TASK_MARKER_9417';
    const agent = makeAgent({ harness: 'claude', model: 'haiku' });
    const previousClaudeJson = process.env.SPARROW_CLAUDE_JSON;
    process.env.SPARROW_CLAUDE_JSON = join(TEST_HOME, 'claude-d10a.json');
    try {
      const claudeFiles = writeCallTexts(agent.id, 'd10a-c', protocol, task);
      const claude = await claudeDriver.prepare({ agent, call_id: 'd10a-c', system_prompt: protocol, prompt: task, resume: false }, claudeFiles);
      const systemFlag = claude.argv.indexOf('--append-system-prompt-file');
      expect(systemFlag).toBeGreaterThan(-1);
      expect(claude.argv[systemFlag + 1]).toBe(claudeFiles.system);
      expect(claude.argv.some((arg) => typeof arg === 'object' && arg.file === claudeFiles.system)).toBe(false);
      expect(JSON.stringify(claude.argv)).not.toContain(protocol);
      expect(claude.argv.some((arg) => typeof arg === 'object' && arg.file === claudeFiles.prompt)).toBe(true);

      const codexAgent = makeAgent({ harness: 'codex', model: 'gpt-test' });
      const codexFiles = writeCallTexts(codexAgent.id, 'd10a-x', protocol, task);
      const codex = await codexDriver.prepare({ agent: codexAgent, call_id: 'd10a-x', system_prompt: protocol, prompt: task, resume: false }, codexFiles);
      const developerInstructionsArg = codex.argv.findIndex((arg) => typeof arg === 'object' && arg.file === join(codexFiles.dir, 'codex-developer-instructions.toml'));
      expect(developerInstructionsArg).toBeGreaterThan(-1);
      expect(readFileSync(join(codexFiles.dir, 'codex-developer-instructions.toml'), 'utf8')).toContain(`developer_instructions=${JSON.stringify(protocol)}`);
      expect(codex.argv.some((arg) => typeof arg === 'object' && arg.file === codexFiles.prompt)).toBe(true);
      expect(JSON.stringify(codex.argv)).not.toContain(protocol);

      const ocAgent = makeAgent({ harness: 'opencode', model: 'provider/model' });
      const ocFiles = writeCallTexts(ocAgent.id, 'd10a-o', protocol, task);
      const opencode = await opencodeDriver.prepare({ agent: ocAgent, call_id: 'd10a-o', system_prompt: protocol, prompt: task, resume: false }, ocFiles);
      expect(opencode.argv).toContain('--prompt');
      expect(opencode.argv.some((arg) => typeof arg === 'object' && arg.file === ocFiles.prompt)).toBe(true);
      expect(JSON.stringify(opencode.argv)).not.toContain(protocol);
      expect(JSON.parse(opencode.env!.OPENCODE_CONFIG_CONTENT).instructions).toEqual([ocFiles.system]);
      expect(buildScript(ocAgent, 'd10a-o', opencode)).not.toContain(protocol);
    } finally {
      if (previousClaudeJson === undefined) delete process.env.SPARROW_CLAUDE_JSON;
      else process.env.SPARROW_CLAUDE_JSON = previousClaudeJson;
    }
  });
});
