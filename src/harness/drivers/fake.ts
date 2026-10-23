// Fake harness for tests: a Bun script that behaves like a TUI (see src/harness/fake-agent.ts).
import { join } from 'node:path';
import type { Agent } from '../../shared/types';
import type { StartSpec } from '../index';
import { COMPILED, BIN } from '../../shared/config';
import { bunPath, repoRoot } from '../env';
import { writeAtomic, type Arg, type CallFiles } from '../launch';
import * as tmux from '../tmux';
import type { Driver, PreparedLaunch } from './types';

export const fakeAgentEntry = () => join(repoRoot(), 'src', 'harness', 'fake-agent.ts');
// Compiled mode has no repo: the binary runs the same logic through its hidden `__fake-agent` subcommand.
export const fakeAgentArgv = (compiled: boolean, bin: string, bun: string, entry: string): string[] => (compiled ? [bin, '__fake-agent'] : [bun, entry]);

export const fakeDriver: Driver = {
  name: 'fake',

  async prepare(spec: StartSpec, files: CallFiles): Promise<PreparedLaunch> {
    const a = spec.agent;
    const resume = spec.resume && !!a.session_id;
    // Record the grants this spawn received so tests can assert hire → call start end to end.
    writeAtomic(join(files.dir, 'fake-skills.json'), JSON.stringify({ call_id: spec.call_id, skills: spec.skills ?? null }, null, 2) + '\n');
    const sessionId = resume ? a.session_id! : `fake-${crypto.randomUUID()}`;
    const argv: Arg[] = [
      ...fakeAgentArgv(COMPILED, BIN, bunPath(), fakeAgentEntry()),
      '--prompt-file', files.prompt,
      '--system-file', files.system,
      '--session', sessionId,
      '--agent-dir', files.dir,
    ];
    if (resume) argv.push('--resume');
    return { argv, session_id: sessionId };
  },

  async deliver(windowId: string, text: string) {
    await tmux.paste(windowId, text);
    await Bun.sleep(100);
    await tmux.sendKeys(windowId, 'Enter');
  },

  async discoverSession(agent: Agent): Promise<string | null> {
    return agent.session_id;
  },
};
