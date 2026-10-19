// Worker skills must remain available when user settings/plugins are isolated.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS, CLAUDE_PLUGIN_DIR } from '../shared/config';
import { agentDir, sparrowHome } from './env';
import { writeAtomic } from './launch';
import type { SkillGrant } from './index';
import { launchGrants, materializeLinks, withSparrow } from '../skills/grant';

export function claudePluginDir() {
  return process.env.SPARROW_HOME ? join(sparrowHome(), 'claude-plugin') : CLAUDE_PLUGIN_DIR;
}
function copyChanged(from: string, to: string): boolean {
  let changed = false;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name), dst = join(to, entry.name);
    if (entry.isDirectory()) changed = copyChanged(src, dst) || changed;
    else if (!existsSync(dst) || !readFileSync(src).equals(readFileSync(dst))) {
      cpSync(src, dst); changed = true;
    }
  }
  return changed;
}
export function ensureClaudePlugin(): boolean {
  const dir = claudePluginDir();
  const file = join(dir, '.claude-plugin', 'plugin.json');
  const manifest = JSON.stringify({ name: 'sparrow', version: '0.1.0', description: 'Sparrow captain and worker protocols' }, null, 2) + '\n';
  let changed = !existsSync(file) || readFileSync(file, 'utf8') !== manifest;
  if (changed) writeAtomic(file, manifest);
  for (const skill of ['sparrow-worker', 'sparrow-captain']) {
    changed = copyChanged(join(ASSETS, 'skills', skill), join(dir, 'skills', skill)) || changed;
  }
  return changed;
}

// Per-agent plugin: exactly the granted skills (Sparrow's included) as symlinks, so an agent sees its own set.
// Skills show up as `sparrow:<name>`; Claude's bundled built-ins are always present and cannot be removed.
export const agentPluginDir = (agentId: string) => join(agentDir(agentId), 'claude-plugin');
export function ensureAgentPlugin(agentId: string, grants?: SkillGrant[]): string {
  const dir = agentPluginDir(agentId);
  const file = join(dir, '.claude-plugin', 'plugin.json');
  const manifest = JSON.stringify({ name: 'sparrow', version: '0.1.0', description: 'Sparrow skills granted to this agent' }, null, 2) + '\n';
  if (!existsSync(file) || readFileSync(file, 'utf8') !== manifest) writeAtomic(file, manifest);
  materializeLinks(join(dir, 'skills'), launchGrants(withSparrow(grants)));
  return dir;
}
