// D11 (pure part): src/cli/guard.ts lostIdentityRefusal over an explicit env. The CLI-level cases are in cli.test.ts.
import { describe, expect, test } from 'bun:test';
import { lostIdentityRefusal } from '../../src/cli/guard';

describe('lostIdentityRefusal (pure)', () => {
  test('refuses only an agent window without its id', () => {
    expect(lostIdentityRefusal({ SPARROW_WINDOW: 'ag_X' })).toContain('inside agent window ag_X but SPARROW_AGENT_ID is unset');
    expect(lostIdentityRefusal({ SPARROW_HARNESS: 'codex' })).toContain('SPARROW_AGENT_ID is unset');
    expect(lostIdentityRefusal({ SPARROW_AGENT_ID: 'ag_X', SPARROW_WINDOW: 'ag_X' })).toBeNull();
    expect(lostIdentityRefusal({ TMUX: '/tmp/t,1,0', TMUX_PANE: '%1' })).toBeNull();
    expect(lostIdentityRefusal({})).toBeNull();
  });
});
