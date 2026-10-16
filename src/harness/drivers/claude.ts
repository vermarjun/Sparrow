// Claude Code driver: interactive `claude` TUI with the system prompt appended, a per-agent settings file
// adding the Stop hook, and the envelope as the positional (auto-submitted) first prompt.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../../shared/types';
import type { StartSpec } from '../index';
import { CLAUDE_BIN, CLAUDE_JSON } from '../env';
import { hookCommand, writeAtomic, type Arg, type CallFiles } from '../launch';
import { claudePluginDir, ensureClaudePlugin } from '../claude-plugin';
import * as tmux from '../tmux';
import type { Driver, PreparedLaunch } from './types';

export function claudeSettings() {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: hookCommand('claude-stop'), timeout: 15 }] }],
    },
  };
}

// Claude Code shows "Is this a project you trust?" for a new folder even with --dangerously-skip-permissions
// (default answer "No, exit"). Accepting writes ~/.claude.json projects[<abs cwd>].hasTrustDialogAccepted = true.
// Pre-set it (read-modify-write, atomic rename, only when missing). Claude rewrites this file itself, so keep
// the window small: re-read immediately before writing and never touch other keys.
export function preAcceptTrust(cwd: string, file = CLAUDE_JSON()): boolean {
  const paths = new Set([cwd]);
  try {
    paths.add(realpathSync(cwd));
  } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    let data: any = {};
    let mode: number | undefined;
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      try {
        data = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        // Mid-write by Claude: retry shortly.
        Bun.sleepSync(50);
        continue;
      }
      mode = statSync(file).mode & 0o777;
    }
    data.projects ??= {};
    const missing = [...paths].filter((p) => data.projects[p]?.hasTrustDialogAccepted !== true);
    if (missing.length === 0) return false;
    for (const p of missing) {
      data.projects[p] = { ...(data.projects[p] ?? {}), hasTrustDialogAccepted: true };
      data.projects[p].hasCompletedProjectOnboarding ??= true;
    }
    writeAtomic(file, JSON.stringify(data, null, 2), mode ?? 0o600);
    return true;
  }
  return false;
}

export const claudeDriver: Driver = {
  name: 'claude',

  async prepare(spec: StartSpec, files: CallFiles): Promise<PreparedLaunch> {
    const a = spec.agent;
    const resume = spec.resume && !!a.session_id;
    const sessionId = resume ? a.session_id! : crypto.randomUUID();
    const settingsPath = join(files.dir, 'claude-settings.json');
    writeAtomic(settingsPath, JSON.stringify(claudeSettings(), null, 2));
    preAcceptTrust(a.cwd);
    ensureClaudePlugin();

    const argv: Arg[] = [CLAUDE_BIN(), '--dangerously-skip-permissions', '--setting-sources', 'project,local', '--plugin-dir', claudePluginDir()];
    argv.push(resume ? '--resume' : '--session-id', sessionId);
    argv.push('-n', a.handle);
    if (a.model) argv.push('--model', a.model);
    if (a.effort) argv.push('--effort', a.effort);
    argv.push('--append-system-prompt', { file: files.system });
    argv.push('--settings', settingsPath);
    argv.push({ file: files.prompt });
    return { argv, session_id: sessionId };
  },

  async deliver(windowId: string, text: string) {
    await tmux.paste(windowId, text);
    // Claude collapses big pastes into "[Pasted text #1 +N lines]"; give it a moment before Enter.
    await Bun.sleep(400);
    await tmux.sendKeys(windowId, 'Enter');
  },

  async discoverSession(agent: Agent): Promise<string | null> {
    return agent.session_id;
  },
};
