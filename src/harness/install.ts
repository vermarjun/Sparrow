// installHarnessAssets(): idempotent harness-side setup for `sparrow install`. Returns human-readable lines.
//  - OpenCode plugin → <SPARROW_HOME>/opencode/plugins/sparrow.js (spawned OpenCode agents get
//    OPENCODE_CONFIG_DIR=<SPARROW_HOME>/opencode, so the user's global OpenCode config dir is never modified).
//  - Reports which harness binaries are present.
// Nothing else is global: Claude's Stop hook is a per-spawn --settings file, Codex's notify is a per-spawn -c
// override (the user's ~/.codex/config.toml is untouched), Claude folder trust is pre-accepted per cwd at start.
import { existsSync } from 'node:fs';
import { CLAUDE_BIN, CODEX_BIN, OPENCODE_BIN } from './env';
import { ensurePlugin, pluginTarget } from './drivers/opencode';

async function version(bin: string): Promise<string | null> {
  const path = bin.includes('/') ? (existsSync(bin) ? bin : null) : Bun.which(bin);
  if (!path) return null;
  try {
    const p = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const t = setTimeout(() => p.kill(), 10_000);
    const out = (await new Response(p.stdout).text()).trim().split('\n').pop() ?? '';
    clearTimeout(t);
    await p.exited;
    return `${path} (${out || 'unknown version'})`;
  } catch {
    return path;
  }
}

export async function installHarnessAssets(): Promise<string[]> {
  const lines: string[] = [];
  const wrote = ensurePlugin();
  lines.push(`OpenCode plugin: ${pluginTarget()} ${wrote ? '(installed)' : '(up to date)'}`);
  for (const [name, bin] of [['claude', CLAUDE_BIN()], ['codex', CODEX_BIN()], ['opencode', OPENCODE_BIN()]] as const) {
    const v = await version(bin);
    lines.push(v ? `${name}: ${v}` : `${name}: NOT FOUND (${bin}) — agents on this harness cannot start`);
  }
  return lines;
}
