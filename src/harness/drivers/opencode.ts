// OpenCode driver: interactive `opencode <cwd>` TUI with --auto (OpenCode has no --yolo), the system prompt
// added through OPENCODE_CONFIG_CONTENT `instructions`, and Sparrow's plugin (session id + session.idle →
// turn-end) loaded from OPENCODE_CONFIG_DIR=<SPARROW_HOME>/opencode. The plugin is inert without SPARROW_AGENT_ID.
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import type { Agent } from '../../shared/types';
import type { StartSpec } from '../index';
import { ASSETS } from '../../shared/config';
import { OPENCODE_BIN, agentDir, sparrowHome } from '../env';
import { writeAtomic, type Arg, type CallFiles } from '../launch';
import { frontmatterName, launchGrants, materializeLinks, withSparrow } from '../../skills/grant';
import { validSkillName } from '../../skills/frontmatter';
import * as tmux from '../tmux';
import type { Driver, PreparedLaunch } from './types';

export const pluginSource = () => join(ASSETS, 'opencode-plugin', 'sparrow.js');
export const opencodeConfigDir = () => join(sparrowHome(), 'opencode');
export const pluginTarget = () => join(opencodeConfigDir(), 'plugins', 'sparrow.js');

// Copy the plugin into the Sparrow OpenCode config dir when missing or stale. Returns true when it wrote.
export function ensurePlugin(): boolean {
  const src = readFileSync(pluginSource(), 'utf8');
  const dst = pluginTarget();
  if (existsSync(dst) && readFileSync(dst, 'utf8') === src) return false;
  writeAtomic(dst, src);
  return true;
}

// Spawned agents run as a generated primary agent "sparrow" (same tools as the default "build" agent).
// Model and effort live on it: OpenCode's TUI applies `agent.variant` (its name for reasoning effort) — verified
// ("· max" in the footer, message.model.variant = "max") — while `agent.build.variant` and the -m flag alone don't
// carry a variant. The system prompt is added via `instructions` (appended to OpenCode's own prompt).
export const OPENCODE_AGENT = 'sparrow';
// Skills: `skills.paths` adds the per-agent grants and project .claude/.agents roots to discovery; native project
// .opencode skills are discovered by OpenCode. Global XDG config and MCP settings stay inherited; the permission
// allowlist filters ungranted global skills out of <available_skills> (debug skill ignores it).
// Rules are wildcard, last match wins, so "*": "deny" must be the first key. Names are FRONTMATTER names.
export interface OpencodeSkills { dir: string; paths: string[]; names: string[] }
export const OPENCODE_BUILTIN_SKILLS = ['customize-opencode'];
export function opencodeConfig(spec: StartSpec, systemPath: string, skills?: OpencodeSkills): Record<string, unknown> {
  const agent: Record<string, unknown> = { mode: 'primary', description: 'Sparrow-managed agent' };
  if (spec.agent.model) agent.model = spec.agent.model;
  if (spec.agent.effort) agent.variant = spec.agent.effort;
  const top: Record<string, unknown> = {};
  if (skills) {
    const allow = Object.fromEntries([...OPENCODE_BUILTIN_SKILLS, ...skills.names].map((n) => [n, 'allow']));
    // JS (and so OpenCode, which parses the JSON) enumerates integer-like keys first, so an all-digit skill name
    // ("123" is a valid spec name) would land BEFORE "*" and be denied by it. Then the deny goes one layer up
    // (top-level permission rules come before the agent's), and the agent holds only the allows.
    // The top-level rules also cover the subagents the `task` tool spawns (general, explore), which have no rules of
    // their own and would otherwise see every discovered skill.
    if (Object.keys(allow).some((n) => /^\d+$/.test(n))) {
      top.permission = { skill: { '*': 'deny' } };
      agent.permission = { skill: allow };
    } else {
      top.permission = { skill: { '*': 'deny', ...allow } };
      agent.permission = { skill: { '*': 'deny', ...allow } };
    }
  }
  return { instructions: [systemPath], ...(skills ? { skills: { paths: skills.paths } } : {}), ...top, agent: { [OPENCODE_AGENT]: agent } };
}

export const opencodeSkillsDir = (agentId: string) => join(agentDir(agentId), 'skills');
const PROJECT_SKILL_DIRS = ['.claude', '.agents', '.opencode'] as const;

// OpenCode v1 walks from cwd to the Git worktree root (or filesystem root without a worktree) and finds
// `<source>/skills/*/SKILL.md` at each level.
// The external-skills flag used below hides the compatibility `.claude` and `.agents` sources too, so explicitly
// add those project roots back while leaving their global roots excluded. `.opencode/skills` remains native.
export function projectSkillRoots(cwd: string): { paths: string[]; names: string[] } {
  let start = resolve(cwd);
  try { start = realpathSync(start); } catch {}
  let root: string | null = null;
  try {
    const result = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' });
    const gitRoot = new TextDecoder().decode(result.stdout).trim();
    if (result.exitCode === 0 && gitRoot) {
      try { root = realpathSync(gitRoot); } catch { root = resolve(gitRoot); }
    }
  } catch {}
  // OpenCode walks project skills to the filesystem root when cwd is outside a Git worktree.
  root ??= parse(start).root;
  let homeRoot = resolve(process.env.HOME || homedir());
  try { homeRoot = realpathSync(homeRoot); } catch {}

  const bySource = new Map<(typeof PROJECT_SKILL_DIRS)[number], string[]>();
  for (const source of PROJECT_SKILL_DIRS) bySource.set(source, []);
  const names: string[] = [];
  const seenNames = new Set<string>();
  const ancestors: string[] = [];
  for (let current = start; ; current = dirname(current)) {
    ancestors.push(current);
    if (current === root) break;
  }
  // Register compatibility sources in OpenCode's precedence order: farthest parent first, then cwd.
  for (const source of ['.claude', '.agents', '.opencode'] as const) {
    for (const ancestor of [...ancestors].reverse()) {
      // The external-skills flag hides these user roots. Do not re-add them as project skills for a non-Git cwd
      // whose native walk reaches the home directory.
      if (ancestor === homeRoot && source !== '.opencode') continue;
      const dir = join(ancestor, source, 'skills');
      try {
        const entries = readdirSync(dir).sort();
        const found: string[] = [];
        for (const entry of entries) {
          const skillDir = join(dir, entry);
          const skillFile = join(skillDir, 'SKILL.md');
          try {
            if (!statSync(skillFile).isFile()) continue;
            found.push(skillFile);
            const name = frontmatterName(skillDir, entry);
            if (validSkillName(name) && !seenNames.has(name)) { seenNames.add(name); names.push(name); }
          } catch {}
        }
        // `.claude` and `.agents` need explicit paths because external discovery is disabled below.
        if (source !== '.opencode' && found.length && !bySource.get(source)!.includes(dir)) bySource.get(source)!.push(dir);
      } catch {}
    }
  }
  return { paths: [...bySource.get('.claude')!, ...bySource.get('.agents')!], names };
}

// Link the grants into <agentDir>/skills and add the current project's compatibility roots to OpenCode discovery.
export function prepareSkills(agentId: string, grants?: StartSpec['skills'], cwd?: string): OpencodeSkills {
  const dir = opencodeSkillsDir(agentId);
  const usable = launchGrants(withSparrow(grants));
  // Allow only what was actually linked: a real entry already holding a grant's name shadows it (materializeLinks skips it).
  const linked = new Set(materializeLinks(dir, usable));
  const project = cwd ? projectSkillRoots(cwd) : { paths: [], names: [] };
  return {
    dir,
    paths: [dir, ...project.paths],
    names: [...new Set([...usable.filter((g) => linked.has(g.name)).map((g) => frontmatterName(g.path, g.name)), ...project.names])],
  };
}

// ---- effort: the TUI remembers a variant per model in $XDG_STATE_HOME/opencode/model.json, and that
// remembered value WINS over agent.variant (verified: a stale "max" there made every agent run at max).
// Each agent gets a private state dir, seeded so variant[model] = effort (or no entry when no effort).
export const opencodeStateHome = (agentId: string) => join(agentDir(agentId), 'opencode-state');
export function seedState(agentId: string, model: string | null, effort: string | null): string {
  const home = opencodeStateHome(agentId);
  const file = join(home, 'opencode', 'model.json');
  let data: any = { recent: [], favorite: [], variant: {} };
  try {
    if (existsSync(file)) data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {}
  data.variant = data.variant && typeof data.variant === 'object' ? data.variant : {};
  if (model) {
    if (effort) data.variant[model] = effort;
    else delete data.variant[model];
  }
  writeAtomic(file, JSON.stringify(data));
  return home;
}

// ---- TUI readiness. Footer when idle: "… ctrl+p commands …"; busy: "esc interrupt … ctrl+p commands";
// narrow windows truncate it ("ctrl+p co"). Ready = idle footer seen on two consecutive identical frames.
export const BUSY_RE = /esc (to )?interrupt/;
export const IDLE_RE = /ctrl\+p/;
// Only the bottom of the screen (prompt box + footer) — transcript text must not count.
export function footer(screen: string, n = 3): string {
  return screen.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}
export function screenIdle(screen: string): boolean {
  const f = footer(screen);
  return IDLE_RE.test(f) && !BUSY_RE.test(f);
}
export const screenBusy = (screen: string) => BUSY_RE.test(footer(screen));

export async function waitForReady(windowId: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  let prev = '';
  while (Date.now() < end) {
    if (!(await tmux.windowAlive(windowId))) return false;
    const screen = await tmux.capture(windowId, 0);
    if (screenIdle(screen) && screen === prev) return true;
    prev = screen;
    await Bun.sleep(400);
  }
  return false;
}

// ---- OpenCode's own DB (sessions/messages), read-only.
export function opencodeDbPath(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}
function openDb(): Database | null {
  const file = opencodeDbPath();
  if (!existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true });
  } catch {
    try {
      // Copy db + WAL + SHM together so recent writes are visible.
      const dir = mkdtempSync(join(tmpdir(), 'sparrow-oc-'));
      const copy = join(dir, 'oc.db');
      copyFileSync(file, copy);
      for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) copyFileSync(file + ext, copy + ext);
      return new Database(copy, { readonly: true });
    } catch {
      return null;
    }
  }
}
// Number of user messages in a session (null when the DB can't be read).
export function userMessageCount(sessionId: string): number | null {
  const db = openDb();
  if (!db) return null;
  try {
    const r = db
      .query(`SELECT count(*) AS n FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'`)
      .get(sessionId) as { n: number } | null;
    return r?.n ?? 0;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// Submit `text` and confirm it landed: a new user message for the session in OpenCode's DB (authoritative)
// or, when the DB can't be read, the busy footer. Retries: Enter again if the text is still in the input,
// else paste again. Throws when it never lands (start() then fails and the server takes the crash path).
export async function submitConfirmed(windowId: string, sessionId: string, text: string, attempts = 3): Promise<void> {
  const before = userMessageCount(sessionId);
  const landed = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const n = userMessageCount(sessionId);
      if (n !== null && before !== null && n > before) return true;
      if ((n === null || before === null) && screenBusy(await tmux.capture(windowId, 0))) return true;
      if (!(await tmux.windowAlive(windowId))) return false;
      await Bun.sleep(300);
    }
    return false;
  };
  const probe = text.split('\n').find((l) => l.trim().length > 8)?.trim().slice(0, 30) ?? '';
  for (let i = 0; i < attempts; i++) {
    if (i === 0) await opencodeDriver.deliver(windowId, text);
    else {
      const screen = await tmux.capture(windowId, 0);
      if (probe && screen.includes(probe) && screenIdle(screen)) {
        await tmux.sendKeys(windowId, 'Enter'); // pasted but Enter was lost
      } else {
        await waitForReady(windowId, 15_000);
        await opencodeDriver.deliver(windowId, text);
      }
    }
    if (await landed(8000)) return;
    if (!(await tmux.windowAlive(windowId))) break;
  }
  throw new Error(`opencode: the resume prompt was not accepted by the TUI in window ${windowId} after ${attempts} attempts`);
}

export const opencodeDriver: Driver = {
  name: 'opencode',

  async prepare(spec: StartSpec, files: CallFiles): Promise<PreparedLaunch> {
    const a = spec.agent;
    const resume = spec.resume && !!a.session_id;
    ensurePlugin();
    const argv: Arg[] = [OPENCODE_BIN(), a.cwd, '--auto', '--agent', OPENCODE_AGENT];
    if (a.model) argv.push('-m', a.model);
    // OpenCode 1.18.33 ignores --prompt when -s is given (verified: neither submitted nor pre-filled), so on
    // resume the envelope is typed in by afterStart() once the TUI is ready.
    if (resume) argv.push('-s', a.session_id!);
    else argv.push('--prompt', { file: files.prompt });
    return {
      argv,
      session_id: resume ? a.session_id : null,
      env: {
        XDG_STATE_HOME: seedState(a.id, a.model, a.effort),
        OPENCODE_CONFIG_DIR: opencodeConfigDir(),
        // Drops global and native project ~/.claude and ~/.agents scans; project compatibility paths are explicit.
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(spec, files.system, prepareSkills(a.id, spec.skills, a.cwd))),
      },
    };
  },

  async afterStart(windowId: string, spec: StartSpec) {
    if (!(spec.resume && spec.agent.session_id)) return;
    if (!(await waitForReady(windowId, 90_000))) {
      throw new Error(`opencode: TUI in window ${windowId} never became ready to accept the resume prompt`);
    }
    await submitConfirmed(windowId, spec.agent.session_id, spec.prompt);
  },

  async deliver(windowId: string, text: string) {
    await tmux.paste(windowId, text);
    await Bun.sleep(400);
    await tmux.sendKeys(windowId, 'Enter');
  },

  async discoverSession(agent: Agent, since: number): Promise<string | null> {
    const db = openDb();
    if (!db) return null;
    try {
      const cwds = new Set([agent.cwd]);
      try {
        cwds.add(realpathSync(agent.cwd));
      } catch {}
      const list = [...cwds];
      const row = db
        .query(
          `SELECT id FROM session WHERE parent_id IS NULL AND directory IN (${list.map(() => '?').join(',')})
           AND time_created >= ? ORDER BY time_created DESC LIMIT 1`,
        )
        .get(...list, since - 2000) as { id: string } | null;
      return row?.id ?? null;
    } catch {
      return null;
    } finally {
      db.close();
    }
  },
};
