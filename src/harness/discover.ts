// Portable harness discovery: where are claude / codex / opencode on THIS machine?
// Order: SPARROW_<NAME>_BIN override -> Bun.which on a widened PATH -> well-known install locations -> null.
// Always absolute: the tmux server's PATH (inherited by new windows) can be minimal, so a bare name is not enough.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export type HarnessName = 'claude' | 'codex' | 'opencode';

const home = () => process.env.HOME || homedir();

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

// `<root>/<child>/<tail>` for every child dir of root, newest-looking name first (nvm/fnm keep one dir per node version).
function versionedBins(root: string, tail: string): string[] {
  try {
    return readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((d) => join(root, d, tail));
  } catch { return []; }
}

/** Directories searched for harness binaries: the process PATH first, then the usual install locations. Deduped. */
export function harnessSearchPath(): string {
  const h = home();
  const e = process.env;
  const npmPrefix = e.npm_config_prefix ?? e.NPM_CONFIG_PREFIX;
  const dirs = [
    ...(e.PATH ?? '').split(delimiter),
    join(h, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    join(h, '.opencode', 'bin'),
    join(h, '.bun', 'bin'),
    join(h, '.npm-global', 'bin'),
    ...(npmPrefix ? [join(npmPrefix, 'bin')] : []),
    ...(e.NVM_BIN ? [e.NVM_BIN] : []),
    ...versionedBins(join(e.NVM_DIR ?? join(h, '.nvm'), 'versions', 'node'), 'bin'),
    ...versionedBins(join(h, '.local', 'share', 'fnm', 'node-versions'), join('installation', 'bin')),
    join(h, '.volta', 'bin'),
    ...(e.PNPM_HOME ? [e.PNPM_HOME] : []),
    join(h, '.local', 'share', 'pnpm'),
    join(h, '.yarn', 'bin'),
    join(h, '.asdf', 'shims'),
    join(h, '.local', 'share', 'mise', 'shims'),
  ];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

const ENV_VAR: Record<HarnessName, string> = {
  claude: 'SPARROW_CLAUDE_BIN', codex: 'SPARROW_CODEX_BIN', opencode: 'SPARROW_OPENCODE_BIN',
};

export function knownHarnessPaths(h: HarnessName): string[] {
  const u = home();
  switch (h) {
    case 'claude': return [
      join(u, '.local', 'bin', 'claude'), join(u, '.claude', 'local', 'claude'),
      join(u, '.claude', 'local', 'node_modules', '.bin', 'claude'),
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(u, '.npm-global', 'bin', 'claude'),
    ];
    case 'codex': return [
      '/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(u, '.local', 'bin', 'codex'),
      join(u, '.npm-global', 'bin', 'codex'), join(u, '.bun', 'bin', 'codex'),
    ];
    case 'opencode': return [
      join(u, '.opencode', 'bin', 'opencode'), join(u, '.local', 'bin', 'opencode'),
      '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', join(u, '.bun', 'bin', 'opencode'),
      join(u, '.npm-global', 'bin', 'opencode'),
    ];
  }
}

// Only a hit is cached (a harness installed while the server runs must still be found), and it is re-checked on use
// (an upgrade can delete a versioned path under a long-running server).
const cache = new Map<HarnessName, string>();
/** Forget cached lookups (tests, or after the environment changed). */
export function resetHarnessCache(): void { cache.clear(); }

function viaOverride(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (isAbsolute(v) || v.includes('/')) { const p = resolve(v); return isExecutable(p) ? p : null; }
  return Bun.which(v, { PATH: harnessSearchPath() }); // a bare command name
}

/** Search `searchPath`, then the `known` locations (exported for tests: the real search path includes system dirs). */
export function lookupHarness(h: HarnessName, searchPath: string, known: string[]): string | null {
  return Bun.which(h, { PATH: searchPath }) ?? known.find(isExecutable) ?? null;
}

/** Absolute path of the harness binary, or null when it is not installed anywhere we know to look. */
export function resolveHarnessBin(h: HarnessName): string | null {
  const over = viaOverride(process.env[ENV_VAR[h]]);
  if (over) return over;
  const hit = cache.get(h);
  if (hit && isExecutable(hit)) return hit;
  cache.delete(h);
  const found = lookupHarness(h, harnessSearchPath(), knownHarnessPaths(h));
  if (found) cache.set(h, found);
  return found;
}
