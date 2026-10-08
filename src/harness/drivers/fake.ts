// Fake harness for tests: a Bun script that behaves like a TUI (see src/harness/fake-agent.ts).
import { join } from 'node:path';
import type { Agent } from '../../shared/types';
import type { StartSpec } from '../index';
import { bunPath, repoRoot } from '../env';
import type { Arg, CallFiles } from '../launch';
import * as tmux from '../tmux';
import type { Driver, PreparedLaunch } from './types';

export const fakeAgentEntry = () => join(repoRoot(), 'src', 'harness', 'fake-agent.ts');

export const fakeDriver: Driver = {
  name: 'fake',

  async prepare(spec: StartSpec, files: CallFiles): Promise<PreparedLaunch> {
    const a = spec.agent;
    const resume = spec.resume && !!a.session_id;
    const sessionId = resume ? a.session_id! : `fake-${crypto.randomUUID()}`;
    const argv: Arg[] = [
      bunPath(), fakeAgentEntry(),
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
