// Pure guard logic (D11/D12/D15): src/cli/guard.ts over an explicit env.
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inAgentWindow, isSandboxHome, lifecycleRefusal } from '../../src/cli/guard';

describe('lifecycleRefusal (pure)', () => {
  const def = join(homedir(), '.sparrow');
  test('humans are never refused', () => {
    expect(lifecycleRefusal('up', false, {})).toBeNull();
    expect(lifecycleRefusal('stop', false, { SPARROW_HOME: def })).toBeNull();
  });
  test('agents are refused unless --sandbox with a non-default SPARROW_HOME', () => {
    const msg = lifecycleRefusal('stop', false, { SPARROW_AGENT_ID: 'ag_X', SPARROW_HOME: '/tmp/sbx' });
    expect(msg).toContain("agents must not start/stop the user's Sparrow server; report it to your captain");
    expect(lifecycleRefusal('up', true, { SPARROW_AGENT_ID: 'ag_X' })).toContain('--sandbox needs SPARROW_HOME');
    expect(lifecycleRefusal('up', true, { SPARROW_AGENT_ID: 'ag_X', SPARROW_HOME: def })).toContain('--sandbox needs SPARROW_HOME');
    expect(lifecycleRefusal('up', true, { SPARROW_AGENT_ID: 'ag_X', SPARROW_HOME: def + '/' })).toContain('--sandbox needs SPARROW_HOME');
    expect(lifecycleRefusal('up', true, { SPARROW_AGENT_ID: 'ag_X', SPARROW_HOME: '/tmp/sbx', SPARROW_PORT: '4590' })).toBeNull();
    // belt and braces: a sandbox never uses 4040, explicitly or by leaving SPARROW_PORT unset
    for (const env of [{ SPARROW_PORT: '4040' }, {}, { SPARROW_URL: 'http://127.0.0.1:4040' }])
      expect(lifecycleRefusal('stop', true, { SPARROW_AGENT_ID: 'ag_X', SPARROW_HOME: '/tmp/sbx', ...env })).toContain('refuses port 4040');
    expect(lifecycleRefusal('up', true, { SPARROW_AGENT_ID: 'ag_X', SPARROW_HOME: '/tmp/sbx', SPARROW_PORT: '4590' }, 4040)).toContain('refuses port 4040');
  });
  test('an agent window that lost SPARROW_AGENT_ID still counts as an agent', () => {
    expect(inAgentWindow({ SPARROW_WINDOW: 'ag_X' })).toBe(true);
    expect(lifecycleRefusal('up', false, { SPARROW_WINDOW: 'ag_X' })).toContain('report it to your captain');
    expect(isSandboxHome({ SPARROW_HOME: '/tmp/sbx' })).toBe(true);
    expect(isSandboxHome({})).toBe(false);
  });
});
