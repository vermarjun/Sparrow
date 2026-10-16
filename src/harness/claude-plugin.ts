// Worker skills must remain available when user settings/plugins are isolated.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS, CLAUDE_PLUGIN_DIR } from '../shared/config';
import { sparrowHome } from './env';
import { writeAtomic } from './launch';

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
