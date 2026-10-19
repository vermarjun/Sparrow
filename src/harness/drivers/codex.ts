// Codex driver: interactive `codex` TUI. The system prompt goes in as `developer_instructions` (a TOML string
// written to a file and passed as `-c "$(cat file)"`, so arbitrary markdown survives quoting); turn ends come
// from a per-spawn `notify` override (the user's own notify in ~/.codex/config.toml is untouched on disk).
import { Database } from 'bun:sqlite';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../../shared/types';
import type { StartSpec } from '../index';
import { CODEX_BIN, CODEX_HOME, agentDir, bunPath, hookEntry } from '../env';
import { agentsSkillsRoots, launchGrants, materializeLinks, withSparrow } from '../../skills/grant';
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

// ---- per-agent CODEX_HOME. Codex reads skills from $CODEX_HOME/skills and ~/.agents/skills. Each agent gets its
// own home so only the granted folders are in skills/; auth.json, config.toml (and LINKED_FILES) are SYMLINKS to the real ones
// (a copy could hold a refreshed token that invalidates the real one). The same home is used for discoverSession
// and for resume: the session lives in it (state_5.sqlite, sessions/).
export const agentCodexHome = (agentId: string) => join(agentDir(agentId), 'codex-home');
// Linked from the real home when present: login, config, plugins, and the user's instructions/policy/MCP credentials
// that a Codex agent used before it had its own home. Never linked: skills/ (the point of the home), SQLite state and
// sessions (per-agent; a linked SQLite file gets its -wal/-shm beside the link).
const LINKED_FILES = ['auth.json', 'config.toml', 'plugins', 'AGENTS.md', 'AGENTS.override.md', '.credentials.json', 'rules', 'prompts'];

// Codex's own `.system` built-ins are re-created in skills/ on first use and are left alone.
export function prepareCodexHome(agentId: string, grants?: StartSpec['skills'], realHome = CODEX_HOME()): string {
  const home = agentCodexHome(agentId);
  mkdirSync(home, { recursive: true });
  for (const f of LINKED_FILES) {
    const src = join(realHome, f), dst = join(home, f);
    if (resolveReal(src) === resolveReal(dst) && existsSync(dst)) continue; // realHome IS this home
    let cur: ReturnType<typeof lstatSync> | null = null;
    try {
      cur = lstatSync(dst);
    } catch {}
    if (cur && !cur.isSymbolicLink()) continue; // a real file Codex wrote: never overwrite
    if (!existsSync(src)) {
      if (cur) unlinkSync(dst);
      continue;
    }
    if (cur && readlinkSync(dst) === src) continue;
    if (cur) unlinkSync(dst);
    symlinkSync(src, dst);
  }
  materializeLinks(join(home, 'skills'), launchGrants(withSparrow(grants)));
  return home;
}
const resolveReal = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// Every entry of the agents roots (real folders and symlinks to folders) that holds a SKILL.md, disabled by path.
export function agentsSkillPaths(roots = agentsSkillsRoots()): string[] {
  const out: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      const md = join(root, e, 'SKILL.md');
      try {
        if (statSync(md).isFile()) out.push(md);
      } catch {}
    }
  }
  return out;
}

// `skills.config` is a TOML array of inline tables (a JSON string is rejected: "expected a sequence").
export function skillsConfigValue(paths: string[]): string | null {
  if (paths.length === 0) return null;
  return `skills.config=[${paths.map((p) => `{path=${tomlString(p)},enabled=false}`).join(',')}]`;
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
    const home = prepareCodexHome(a.id, spec.skills);
    const disabled = skillsConfigValue(agentsSkillPaths());
    if (disabled) opts.push('-c', disabled);

    const argv: Arg[] = [CODEX_BIN()];
    if (resume) argv.push('resume', ...opts, a.session_id!, { file: files.prompt });
    else argv.push(...opts, { file: files.prompt });
    return { argv, session_id: resume ? a.session_id : null, env: { CODEX_HOME: home } };
  },

  async deliver(windowId: string, text: string) {
    await tmux.paste(windowId, text);
    await Bun.sleep(400);
    await tmux.sendKeys(windowId, 'Enter');
  },

  async discoverSession(agent: Agent, since: number): Promise<string | null> {
    try {
      const fromDb = discoverFromStateDb(agent, since, agentCodexHome(agent.id));
      if (fromDb) return fromDb;
    } catch {}
    try {
      return discoverFromRollouts(agent, since, agentCodexHome(agent.id));
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

function discoverFromStateDb(agent: Agent, since: number, home: string): string | null {
  const file = join(home, 'state_5.sqlite');
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

function discoverFromRollouts(agent: Agent, since: number, home: string): string | null {
  const root = join(home, 'sessions');
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
