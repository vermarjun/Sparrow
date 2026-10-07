// Codex driver: interactive `codex` TUI. The system prompt goes in as `developer_instructions` (a TOML string
// written to a file and passed as `-c "$(cat file)"`, so arbitrary markdown survives quoting); turn ends come
// from a per-spawn `notify` override (the user's own notify in ~/.codex/config.toml is untouched on disk).
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../../shared/types';
import type { StartSpec } from '../index';
import { CODEX_BIN, CODEX_HOME, bunPath, hookEntry } from '../env';
import { writeAtomic, type Arg, type CallFiles } from '../launch';
import * as tmux from '../tmux';
import type { Driver, PreparedLaunch } from './types';

// JSON string syntax is a valid TOML basic string (\" \\ \n \t \uXXXX …).
export const tomlString = (s: string) => JSON.stringify(s);

// Codex asks "Trust this folder?" for git repos (verified; plain dirs don't ask) and keys trust by project root,
// so trust the cwd, its realpath and its git root — for this invocation only (-c is not persisted).
export function trustValue(cwd: string): string {
  const paths = new Set([cwd]);
  try {
    paths.add(realpathSync(cwd));
  } catch {}
  try {
    const r = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' });
    const root = new TextDecoder().decode(r.stdout).trim();
    if (r.exitCode === 0 && root) {
      paths.add(root);
      try {
        paths.add(realpathSync(root));
      } catch {}
    }
  } catch {}
  return `projects={ ${[...paths].map((p) => `${tomlString(p)} = { trust_level = "trusted" }`).join(', ')} }`;
}

export const codexDriver: Driver = {
  name: 'codex',

  async prepare(spec: StartSpec, files: CallFiles): Promise<PreparedLaunch> {
    const a = spec.agent;
    const resume = spec.resume && !!a.session_id;
    const devFile = join(files.dir, 'codex-developer-instructions.toml');
    writeAtomic(devFile, `developer_instructions=${tomlString(spec.system_prompt)}`);

    const opts: Arg[] = [
      // Run the agent loop in this process (not the shared app-server daemon) so the shell tool inherits
      // this window's env (SPARROW_AGENT_ID, PATH with `sparrow`) and `notify` runs with it too.
      '--no-daemon',
      '--yolo', // the user's flag; hidden alias of --dangerously-bypass-approvals-and-sandbox (verified on 0.162.1)
      '-C', a.cwd,
    ];
    if (a.model) opts.push('-m', a.model);
    if (a.effort) opts.push('-c', `model_reasoning_effort=${tomlString(a.effort)}`);
    opts.push('-c', { file: devFile });
    opts.push('-c', `notify=${JSON.stringify([bunPath(), hookEntry(), 'codex-notify'])}`);
    opts.push('-c', trustValue(a.cwd));

    const argv: Arg[] = [CODEX_BIN()];
    if (resume) argv.push('resume', ...opts, a.session_id!, { file: files.prompt });
    else argv.push(...opts, { file: files.prompt });
    return { argv, session_id: resume ? a.session_id : null };
  },

  async deliver(windowId: string, text: string) {
    await tmux.paste(windowId, text);
    await Bun.sleep(400);
    await tmux.sendKeys(windowId, 'Enter');
  },

  async discoverSession(agent: Agent, since: number): Promise<string | null> {
    try {
      const fromDb = discoverFromStateDb(agent, since);
      if (fromDb) return fromDb;
    } catch {}
    try {
      return discoverFromRollouts(agent, since);
    } catch {
      return null;
    }
  },
};

function cwdSet(cwd: string) {
  const s = new Set([cwd]);
  try {
    s.add(realpathSync(cwd));
  } catch {}
  return s;
}

function head(path: string, bytes = 256 * 1024): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(bytes, statSync(path).size));
      readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function openReadonly(file: string): Database {
  try {
    return new Database(file, { readonly: true });
  } catch {
    // Some sandboxes refuse to open a WAL db in place read-only; read a copy.
    const dir = mkdtempSync(join(tmpdir(), 'sparrow-codex-'));
    const copy = join(dir, 'state.sqlite');
    copyFileSync(file, copy);
    return new Database(copy, { readonly: true });
  }
}

function pick<T extends { id: string; path?: string }>(agent: Agent, cands: T[]): string | null {
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0].id;
  // Several Codex sessions in the same cwd: prefer the one whose rollout mentions this agent's id
  // (the protocol prompt includes {{agent_id}}).
  const match = cands.find((c) => c.path && head(c.path).includes(agent.id));
  return (match ?? cands[0]).id;
}

function discoverFromStateDb(agent: Agent, since: number): string | null {
  const file = join(CODEX_HOME(), 'state_5.sqlite');
  if (!existsSync(file)) return null;
  const db = openReadonly(file);
  try {
    const cwds = [...cwdSet(agent.cwd)];
    const rows = db
      .query(
        `SELECT id, rollout_path AS path FROM threads
         WHERE cwd IN (${cwds.map(() => '?').join(',')}) AND COALESCE(created_at_ms, created_at * 1000) >= ?
         ORDER BY COALESCE(created_at_ms, created_at * 1000) DESC LIMIT 10`,
      )
      .all(...cwds, since - 2000) as { id: string; path: string }[];
    return pick(agent, rows);
  } finally {
    db.close();
  }
}

function discoverFromRollouts(agent: Agent, since: number): string | null {
  const root = join(CODEX_HOME(), 'sessions');
  if (!existsSync(root)) return null;
  const cwds = cwdSet(agent.cwd);
  const files: { path: string; mtime: number }[] = [];
  const days = new Set<string>();
  for (const t of [since, Date.now()]) {
    const d = new Date(t);
    days.add(join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  for (const day of days) {
    const dir = join(root, day);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      const mtime = statSync(p).mtimeMs;
      if (mtime >= since - 2000) files.push({ path: p, mtime });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const cands: { id: string; path: string }[] = [];
  for (const f of files) {
    const first = head(f.path, 64 * 1024).split('\n')[0];
    try {
      const meta = JSON.parse(first);
      const p = meta.payload ?? meta;
      if (p?.id && cwds.has(p.cwd)) cands.push({ id: p.id, path: f.path });
    } catch {}
  }
  return pick(agent, cands);
}
