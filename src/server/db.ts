// SQLite state for the server: schema + typed row <-> domain mappers.
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Agent, AgentState, Call, CallEndReason, CaptainInfo, Card, CardNote, CardState, Delivery, DoctorCheck, DoctorRun,
  HarnessCatalog, Message, MessageKind, Project,
} from '../shared/types';

export const SCHEMA_VERSION = 5;

/** A patch for `Store.patchAgent`: agent columns, plus `captain` (merged into the captain_* columns) and bookkeeping columns. */
export type AgentPatch = Omit<Partial<Agent>, 'captain'> & {
  captain?: Partial<CaptainInfo>; queued_at?: number | null; resume_note?: string | null; captain_pid?: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  kind TEXT NOT NULL,
  resume TEXT NOT NULL,
  title TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  can_hire TEXT NOT NULL DEFAULT '[]',
  parent_id TEXT,
  depth INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  tmux_window TEXT NOT NULL,
  tmux_window_id TEXT,
  session_id TEXT,
  state TEXT NOT NULL,
  call_id TEXT,
  last_end_reason TEXT,
  last_update TEXT,
  last_update_at INTEGER,
  last_seen_at INTEGER,
  queued_at INTEGER,
  resume_hash TEXT,
  last_run TEXT,
  resume_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, handle)
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  exit_code INTEGER,
  resumed INTEGER NOT NULL DEFAULT 0,
  nudges INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL DEFAULT '',
  quiet_nudged_at INTEGER,
  long_notified INTEGER NOT NULL DEFAULT 0,
  harness TEXT,
  model TEXT,
  effort TEXT
);
CREATE INDEX IF NOT EXISTS calls_agent ON calls (agent_id, started_at);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  from_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  card_id INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (project_id, thread, seq);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  state TEXT NOT NULL,
  call_id TEXT,
  delivered_at INTEGER,
  wake INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (message_id, to_id)
);
CREATE INDEX IF NOT EXISTS deliveries_to ON deliveries (to_id, state);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  category TEXT,
  state TEXT NOT NULL,
  position REAL NOT NULL,
  assignee_id TEXT,
  created_by TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL DEFAULT '',
  approach TEXT NOT NULL DEFAULT '',
  checks TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  urgent INTEGER NOT NULL DEFAULT 0,
  impact TEXT,
  effort TEXT,
  estimate_min INTEGER,
  blocked_on TEXT,
  blocked_at INTEGER,
  later_at INTEGER,
  history TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS catalogs (
  harness TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doctor_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resume_tests (
  slug TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// Columns added after v1. A v1 database gets them via ALTER TABLE on open (new tables come from CREATE IF NOT EXISTS).
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['agents', 'resume_hash', 'TEXT'],
  ['agents', 'last_run', 'TEXT'],
  ['agents', 'resume_note', 'TEXT'],   // changed resume text to prepend to the next envelope ("apply to existing agents")
  ['calls', 'harness', 'TEXT'],
  ['calls', 'model', 'TEXT'],
  ['calls', 'effort', 'TEXT'],
  ['deliveries', 'wake', 'INTEGER NOT NULL DEFAULT 1'], // v3: 0 = quiet delivery (never wakes)
  // v5 multi-captain. `title` already means the resume title, so the captain's own title is `captain_title`.
  ['agents', 'fleet_id', 'TEXT'],
  ['agents', 'captain_title', 'TEXT'],
  ['agents', 'branch', 'TEXT'],
  ['agents', 'captain_harness', 'TEXT'],
  ['agents', 'origin', 'TEXT'],
  ['agents', 'archived_at', 'INTEGER'],
  ['agents', 'captain_pid', 'INTEGER'],   // the captain's harness process (CLAUDE_PID): survives /clear, which changes the session id
  ['messages', 'fleet_id', 'TEXT'],    // the fleet whose thread this is (both ends of a DM are always in one fleet)
  ['cards', 'context', "TEXT NOT NULL DEFAULT ''"],
  ['cards', 'problem', "TEXT NOT NULL DEFAULT ''"],
  ['cards', 'approach', "TEXT NOT NULL DEFAULT ''"],
  ['cards', 'checks', "TEXT NOT NULL DEFAULT '[]'"],
  ['cards', 'tags', "TEXT NOT NULL DEFAULT '[]'"],
  ['cards', 'urgent', 'INTEGER NOT NULL DEFAULT 0'],
  ['cards', 'impact', 'TEXT'],
  ['cards', 'effort', 'TEXT'],
  ['cards', 'estimate_min', 'INTEGER'],
  ['cards', 'blocked_on', 'TEXT'],
  ['cards', 'blocked_at', 'INTEGER'],
  ['cards', 'later_at', 'INTEGER'],
  ['cards', 'history', "TEXT NOT NULL DEFAULT '[]'"],
];

type Row = Record<string, any>;
const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export function rowToAgent(r: Row): Agent {
  return {
    id: r.id, project_id: r.project_id, handle: r.handle, kind: r.kind, resume: r.resume, title: r.title,
    harness: r.harness, model: r.model ?? null, effort: r.effort ?? null, can_hire: json<string[]>(r.can_hire, []),
    parent_id: r.parent_id ?? null, depth: r.depth, cwd: r.cwd, tmux_session: r.tmux_session, tmux_window: r.tmux_window,
    tmux_window_id: r.tmux_window_id ?? null, session_id: r.session_id ?? null, state: r.state as AgentState,
    call_id: r.call_id ?? null, last_end_reason: (r.last_end_reason ?? null) as CallEndReason | null,
    last_update: r.last_update ?? null, last_update_at: r.last_update_at ?? null, last_seen_at: r.last_seen_at ?? null,
    resume_hash: r.resume_hash ?? null, last_run: json(r.last_run, null),
    fleet_id: r.fleet_id ?? r.id,
    captain: r.kind === 'human' ? {
      title: r.captain_title ?? null, branch: r.branch ?? null, harness: (r.captain_harness ?? 'unknown') as CaptainInfo['harness'],
      origin: r.origin === 'sparrow' ? 'sparrow' : 'terminal', archived_at: r.archived_at ?? null,
    } : null,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export interface CallRow extends Call { quiet_nudged_at: number | null; long_notified: boolean }

export function rowToCall(r: Row): CallRow {
  return {
    id: r.id, agent_id: r.agent_id, started_at: r.started_at, ended_at: r.ended_at ?? null,
    end_reason: (r.end_reason ?? null) as CallEndReason | null, exit_code: r.exit_code ?? null, resumed: !!r.resumed,
    nudges: r.nudges, restarts: r.restarts, prompt: r.prompt, quiet_nudged_at: r.quiet_nudged_at ?? null,
    long_notified: !!r.long_notified, harness: r.harness ?? null, model: r.model ?? null, effort: r.effort ?? null,
  };
}

export function publicCall(c: CallRow): Call {
  const { quiet_nudged_at: _q, long_notified: _l, ...rest } = c;
  return rest;
}

export function rowToMessage(r: Row): Message {
  return {
    seq: r.seq, id: r.id, project_id: r.project_id, thread: r.thread, from_id: r.from_id, kind: r.kind as MessageKind,
    text: r.text, mentions: json<string[]>(r.mentions, []), card_id: r.card_id ?? null,
    meta: json<Record<string, unknown>>(r.meta, {}), created_at: r.created_at,
  };
}

/** Message plus the fleet it belongs to (stored in its own column; not part of the shared Message). */
export type MessageInsert = Omit<Message, 'seq'> & { fleet_id?: string | null };

export function rowToCard(r: Row): Card {
  return {
    id: r.id, project_id: r.project_id, title: r.title, details: r.details, category: r.category ?? null,
    state: r.state as CardState, position: r.position, assignee_id: r.assignee_id ?? null, created_by: r.created_by,
    notes: json<CardNote[]>(r.notes, []), created_at: r.created_at, updated_at: r.updated_at,
    context: r.context ?? '', problem: r.problem ?? '', approach: r.approach ?? '', checks: json(r.checks, []),
    tags: json(r.tags, []), urgent: !!r.urgent, impact: r.impact ?? null, effort: r.effort ?? null,
    estimate_min: r.estimate_min ?? null, blocked_on: r.blocked_on ?? null, blocked_at: r.blocked_at ?? null,
    later_at: r.later_at ?? null, history: json(r.history, []),
  };
}

export function rowToDelivery(r: Row): Delivery {
  return {
    message_id: r.message_id, to_id: r.to_id, state: r.state, wake: r.wake !== 0, call_id: r.call_id ?? null,
    delivered_at: r.delivered_at ?? null,
  };
}

const AGENT_COLS = [
  'id', 'project_id', 'handle', 'kind', 'resume', 'title', 'harness', 'model', 'effort', 'can_hire', 'parent_id', 'depth',
  'cwd', 'tmux_session', 'tmux_window', 'tmux_window_id', 'session_id', 'state', 'call_id', 'last_end_reason',
  'last_update', 'last_update_at', 'last_seen_at', 'resume_hash', 'last_run', 'fleet_id', 'created_at', 'updated_at',
] as const;
const JSON_COLS = new Set(['can_hire', 'last_run']);
const CAPTAIN_COLS: Record<keyof CaptainInfo, string> = {
  title: 'captain_title', branch: 'branch', harness: 'captain_harness', origin: 'origin', archived_at: 'archived_at',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thin typed wrapper over bun:sqlite. All methods are synchronous. */
export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
    if (path !== ':memory:') this.backupBeforeMigrating(path);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** First open of an older database by this version: keep a consistent copy next to it (`VACUUM INTO` is WAL-safe). */
  private backupBeforeMigrating(path: string) {
    try {
      const has = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_version', 'agents')").all() as Row[];
      if (has.length < 2) return; // brand-new database
      const v = (this.db.query('SELECT version FROM schema_version LIMIT 1').get() as Row | null)?.version ?? 0;
      if (v >= SCHEMA_VERSION) return;
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
      const dest = `${path}.bak-v${v}-${stamp}`;
      if (!existsSync(dest)) this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    } catch { /* a missing backup must not stop the server from opening */ }
  }

  /** Bring an older database up to SCHEMA_VERSION: add missing columns, then record the version. */
  private migrate() {
    for (const [table, column, type] of ADDED_COLUMNS) {
      const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Row[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    const v = this.db.query('SELECT version FROM schema_version LIMIT 1').get() as Row | null;
    if (!v) this.db.query('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    else if (v.version < SCHEMA_VERSION) this.db.query('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    // Idempotent and cheap: a server of an older version sharing this database inserts rows with a NULL fleet_id.
    this.db.transaction(() => this.backfillFleets())();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_fleet ON messages (project_id, fleet_id, seq);
      CREATE INDEX IF NOT EXISTS agents_fleet ON agents (fleet_id);
    `);
    // One human row per harness session within a project. Two rows can never both claim a session (a duplicate left by an
    // older server would make the index fail, so the older rows lose the session id first).
    this.db.exec(`UPDATE agents SET session_id = NULL WHERE kind = 'human' AND session_id IS NOT NULL AND rowid NOT IN (
      SELECT MAX(rowid) FROM agents WHERE kind = 'human' AND session_id IS NOT NULL GROUP BY project_id, session_id)`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agents_captain_session ON agents (project_id, session_id) WHERE kind = 'human' AND session_id IS NOT NULL`);
  }

  /**
   * v4 → v5: every human row is a captain and the root of its own fleet; every other agent joins the fleet of its root
   * ancestor (orphans: their own). Messages take the fleet of whichever end of their DM thread is a known agent.
   */
  private backfillFleets() {
    const needs = this.db.query('SELECT 1 AS x FROM agents WHERE fleet_id IS NULL LIMIT 1').get()
      || this.db.query("SELECT 1 AS x FROM messages WHERE fleet_id IS NULL AND thread LIKE 'dm:%' LIMIT 1").get();
    if (!needs) return;
    const rows = this.db.query('SELECT id, kind, parent_id, session_id FROM agents').all() as Row[];
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const fleetOf = (id: string): string => {
      const seen = new Set<string>();
      let cur = byId.get(id);
      while (cur && cur.kind !== 'human' && cur.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parent_id); }
      return (cur?.kind === 'human' ? cur.id : id) as string;
    };
    const upd = this.db.query('UPDATE agents SET fleet_id = ? WHERE id = ? AND fleet_id IS NULL');
    for (const r of rows) upd.run(fleetOf(r.id), r.id);
    const human = this.db.query("UPDATE agents SET origin = 'terminal', captain_harness = ? WHERE id = ? AND kind = 'human' AND origin IS NULL");
    for (const r of rows) if (r.kind === 'human') human.run(UUID_RE.test(r.session_id ?? '') ? 'claude' : 'unknown', r.id);
    const fleets = new Map(rows.map((r) => [r.id as string, fleetOf(r.id)]));
    const threads = this.db.query("SELECT DISTINCT thread FROM messages WHERE fleet_id IS NULL AND thread LIKE 'dm:%'").all() as Row[];
    const setMsg = this.db.query('UPDATE messages SET fleet_id = ? WHERE thread = ? AND fleet_id IS NULL');
    for (const t of threads) {
      const fleet = (t.thread as string).split(':').slice(1).map((id) => fleets.get(id)).find(Boolean);
      if (fleet) setMsg.run(fleet, t.thread);
    }
  }

  schemaVersion(): number {
    return ((this.db.query('SELECT version FROM schema_version LIMIT 1').get() as Row | null)?.version as number) ?? 0;
  }

  close() { this.db.close(); }

  tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // ---------- projects
  getProject(id: string): Project | null {
    return (this.db.query('SELECT * FROM projects WHERE id = ?').get(id) as Project | null) ?? null;
  }
  getProjectByRoot(root: string): Project | null {
    return (this.db.query('SELECT * FROM projects WHERE root = ?').get(root) as Project | null) ?? null;
  }
  listProjects(): Project[] {
    return this.db.query('SELECT * FROM projects ORDER BY created_at, rowid').all() as Project[];
  }
  insertProject(p: Project) {
    this.db.query('INSERT INTO projects (id, name, root, created_at) VALUES (?, ?, ?, ?)').run(p.id, p.name, p.root, p.created_at);
  }

  // ---------- agents
  /**
   * Row → Agent. A row with no fleet_id (inserted by a server of an older version into this database) is placed in
   * its fleet from its parent chain, and written back, so every read path sees the same fleet.
   */
  private toAgent(r: Row): Agent {
    if (r.fleet_id == null) {
      let top: Row = r;
      for (let i = 0; i < 10 && top.kind !== 'human' && top.parent_id; i++) {
        const p = this.db.query('SELECT * FROM agents WHERE id = ?').get(top.parent_id) as Row | null;
        if (!p) break;
        top = p;
      }
      r.fleet_id = top.kind === 'human' ? top.id : r.id;
      this.db.query('UPDATE agents SET fleet_id = ? WHERE id = ? AND fleet_id IS NULL').run(r.fleet_id, r.id);
      if (r.kind === 'human' && r.origin == null) {
        r.origin = 'terminal';
        r.captain_harness = UUID_RE.test(r.session_id ?? '') ? 'claude' : 'unknown';
        this.db.query('UPDATE agents SET origin = ?, captain_harness = ? WHERE id = ?').run(r.origin, r.captain_harness, r.id);
      }
    }
    return rowToAgent(r);
  }
  getAgent(id: string): Agent | null {
    const r = this.db.query('SELECT * FROM agents WHERE id = ?').get(id) as Row | null;
    return r ? this.toAgent(r) : null;
  }
  getAgentByHandle(projectId: string, handle: string): Agent | null {
    const r = this.db.query('SELECT * FROM agents WHERE project_id = ? AND handle = ?').get(projectId, handle) as Row | null;
    return r ? this.toAgent(r) : null;
  }
  /** The human row that owns a harness session in a project (at most one: the partial unique index). */
  getCaptainBySession(projectId: string, sessionId: string): Agent | null {
    const r = this.db.query("SELECT * FROM agents WHERE project_id = ? AND session_id = ? AND kind = 'human'").get(projectId, sessionId) as Row | null;
    return r ? this.toAgent(r) : null;
  }
  /** A human row whose harness process is `pid` and that was seen since `since` (re-attach after /clear). */
  getCaptainByPid(projectId: string, pid: number, since: number): Agent | null {
    const r = this.db.query("SELECT * FROM agents WHERE project_id = ? AND kind = 'human' AND captain_pid = ? AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 1").get(projectId, pid, since) as Row | null;
    return r ? this.toAgent(r) : null;
  }
  /** Human captains of a project, oldest first. */
  listCaptains(projectId: string, includeArchived = false): Agent[] {
    const rows = this.db.query(`SELECT * FROM agents WHERE project_id = ? AND kind = 'human' ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY created_at, rowid`).all(projectId) as Row[];
    return rows.map((r) => this.toAgent(r));
  }
  /** Everyone in a fleet (the captain included), oldest first. */
  fleetMembers(fleetId: string): Agent[] {
    return (this.db.query('SELECT * FROM agents WHERE fleet_id = ? ORDER BY created_at, rowid').all(fleetId) as Row[]).map((r) => this.toAgent(r));
  }
  /** Hires of a fleet (everyone but the human at its root). */
  fleetHires(fleetId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM agents WHERE fleet_id = ? AND kind != 'human'").get(fleetId) as Row).n;
  }
  /** Delete a row nothing refers to yet (a pre-created captain whose launch failed). */
  deleteAgent(id: string) { this.db.query('DELETE FROM agents WHERE id = ?').run(id); }
  listAgents(projectId?: string | null): Agent[] {
    const rows = projectId
      ? this.db.query('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId)
      : this.db.query('SELECT * FROM agents ORDER BY created_at DESC, rowid DESC').all();
    return (rows as Row[]).map((r) => this.toAgent(r));
  }
  /** Spawned agents (kind agent or probe) in a state. */
  agentsInState(state: AgentState): Agent[] {
    return (this.db.query("SELECT * FROM agents WHERE state = ? AND kind != 'human' ORDER BY created_at, rowid").all(state) as Row[]).map((r) => this.toAgent(r));
  }
  /** Changed resume text waiting to be prepended to the agent's next envelope; read-and-clear. */
  takeResumeNote(id: string): string | null {
    const r = this.db.query('SELECT resume_note FROM agents WHERE id = ?').get(id) as Row | null;
    if (!r?.resume_note) return null;
    this.db.query('UPDATE agents SET resume_note = NULL WHERE id = ?').run(id);
    return r.resume_note as string;
  }
  children(agentId: string): Agent[] {
    return (this.db.query('SELECT * FROM agents WHERE parent_id = ? ORDER BY created_at, rowid').all(agentId) as Row[]).map((r) => this.toAgent(r));
  }
  /** Working agents that count against max_running (probes don't). */
  countWorking(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM agents WHERE state = 'working' AND kind = 'agent'").get() as Row).n;
  }
  /** Working agents per fleet (same rule as countWorking). */
  workingByFleet(): Map<string, number> {
    const rows = this.db.query("SELECT fleet_id, COUNT(*) AS n FROM agents WHERE state = 'working' AND kind = 'agent' GROUP BY fleet_id").all() as Row[];
    return new Map(rows.map((r) => [r.fleet_id as string, r.n as number]));
  }
  countWorkingInFleet(fleetId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM agents WHERE state = 'working' AND kind = 'agent' AND fleet_id = ?").get(fleetId) as Row).n;
  }
  /** Queued agents, oldest first. */
  queuedAgents(): Agent[] {
    return (this.db.query("SELECT * FROM agents WHERE state = 'queued' AND kind = 'agent' ORDER BY queued_at, created_at, rowid").all() as Row[]).map((r) => this.toAgent(r));
  }
  insertAgent(a: Agent) {
    const captain = a.captain
      ? Object.fromEntries((Object.keys(CAPTAIN_COLS) as (keyof CaptainInfo)[]).map((k) => [CAPTAIN_COLS[k], a.captain![k] ?? null]))
      : {};
    const cols = [...AGENT_COLS, ...Object.keys(captain)];
    const vals = [
      ...AGENT_COLS.map((c) => (JSON_COLS.has(c) ? ((a as any)[c] == null ? null : JSON.stringify((a as any)[c])) : (a as any)[c] ?? null)),
      ...Object.values(captain),
    ];
    this.db.query(`INSERT INTO agents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(vals as any[]));
  }
  /** Patch columns of an agent (bumps updated_at) and return the new row. */
  patchAgent(id: string, patch: AgentPatch, now: number): Agent {
    const { captain, ...rest } = patch;
    const captainCols = Object.fromEntries(Object.entries(captain ?? {}).map(([k, v]) => [CAPTAIN_COLS[k as keyof CaptainInfo], v]));
    const entries = Object.entries({ ...rest, ...captainCols, updated_at: now }).filter(([k]) => k !== 'id');
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const vals = entries.map(([k, v]) => (JSON_COLS.has(k) ? (v == null ? null : JSON.stringify(v)) : v ?? null));
    this.db.query(`UPDATE agents SET ${sets} WHERE id = ?`).run(...(vals as any[]), id);
    return this.getAgent(id)!;
  }

  // ---------- calls
  getCall(id: string): CallRow | null {
    const r = this.db.query('SELECT * FROM calls WHERE id = ?').get(id) as Row | null;
    return r ? rowToCall(r) : null;
  }
  callsFor(agentId: string, limit = 20): CallRow[] {
    return (this.db.query('SELECT * FROM calls WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(agentId, limit) as Row[]).map(rowToCall);
  }
  latestCall(agentId: string): CallRow | null {
    return this.callsFor(agentId, 1)[0] ?? null;
  }
  insertCall(c: Call) {
    this.db.query('INSERT INTO calls (id, agent_id, started_at, ended_at, end_reason, exit_code, resumed, nudges, restarts, prompt, harness, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.agent_id, c.started_at, c.ended_at, c.end_reason, c.exit_code, c.resumed ? 1 : 0, c.nudges, c.restarts, c.prompt, c.harness ?? null, c.model ?? null, c.effort ?? null);
  }
  patchCall(id: string, patch: Partial<CallRow>): CallRow {
    const entries = Object.entries(patch).filter(([k]) => k !== 'id');
    if (entries.length) {
      const sets = entries.map(([k]) => `${k} = ?`).join(', ');
      const vals = entries.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null));
      this.db.query(`UPDATE calls SET ${sets} WHERE id = ?`).run(...(vals as any[]), id);
    }
    return this.getCall(id)!;
  }

  // ---------- messages + deliveries
  insertMessage(m: MessageInsert): Message {
    const res = this.db.query('INSERT INTO messages (id, project_id, thread, from_id, kind, text, mentions, card_id, meta, created_at, fleet_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.project_id, m.thread, m.from_id, m.kind, m.text, JSON.stringify(m.mentions), m.card_id, JSON.stringify(m.meta), m.created_at, m.fleet_id ?? null);
    const { fleet_id: _f, ...msg } = m;
    return { ...msg, seq: Number(res.lastInsertRowid) };
  }
  getMessage(id: string): Message | null {
    const r = this.db.query('SELECT * FROM messages WHERE id = ?').get(id) as Row | null;
    return r ? rowToMessage(r) : null;
  }
  /** Old 'group' rows (group chat was removed) are never listed. */
  listMessages(q: { project?: string | null; thread?: string | null; threadLike?: string | null; after?: number | null; before?: number | null; limit: number; fromOrTo?: string | null; fleet?: string | null }): Message[] {
    const where: string[] = ["thread != 'group'"];
    const args: any[] = [];
    if (q.fleet) { where.push('fleet_id = ?'); args.push(q.fleet); }
    if (q.project) { where.push('project_id = ?'); args.push(q.project); }
    if (q.thread) { where.push('thread = ?'); args.push(q.thread); }
    if (q.threadLike) { where.push('thread LIKE ?'); args.push(q.threadLike); }
    if (q.fromOrTo) { where.push("(from_id = ? OR thread LIKE ? OR mentions LIKE ?)"); args.push(q.fromOrTo, `%${q.fromOrTo}%`, `%${q.fromOrTo}%`); }
    const w = `WHERE ${where.join(' AND ')}`;
    let rows: Row[];
    if (q.after != null) {
      rows = this.db.query(`SELECT * FROM messages ${w} AND seq > ? ORDER BY seq ASC LIMIT ?`).all(...args, q.after, q.limit) as Row[];
    } else if (q.before != null) {
      // the `limit` messages just older than `before`, returned in seq order
      rows = (this.db.query(`SELECT * FROM messages ${w} AND seq < ? ORDER BY seq DESC LIMIT ?`).all(...args, q.before, q.limit) as Row[]).reverse();
    } else {
      rows = (this.db.query(`SELECT * FROM messages ${w} ORDER BY seq DESC LIMIT ?`).all(...args, q.limit) as Row[]).reverse();
    }
    return rows.map(rowToMessage);
  }
  /** Latest `result` message per sender (the agent's last `done`), for one project or all. */
  lastResults(project?: string | null): Map<string, Message> {
    const rows = this.db.query(
      `SELECT m.* FROM messages m WHERE m.kind = 'result' ${project ? 'AND m.project_id = ?' : ''}
       AND m.seq = (SELECT MAX(seq) FROM messages x WHERE x.kind = 'result' AND x.from_id = m.from_id)`,
    ).all(...(project ? [project] : [])) as Row[];
    return new Map(rows.map((r) => [r.from_id as string, rowToMessage(r)]));
  }
  threadSummaries(project: string, fleet?: string | null): { thread: string; count: number; last_seq: number }[] {
    return this.db.query(`SELECT thread, COUNT(*) AS count, MAX(seq) AS last_seq FROM messages WHERE project_id = ? AND thread != 'group' ${fleet ? 'AND fleet_id = ?' : ''} GROUP BY thread ORDER BY last_seq DESC`).all(...(fleet ? [project, fleet] : [project])) as any[];
  }
  /** Per fleet of a project: newest message time (any kind), and the newest message that is not an `update`. */
  fleetMessageStats(project: string): { activity: Map<string, number>; last: Map<string, Message> } {
    const act = this.db.query("SELECT fleet_id, MAX(created_at) AS at FROM messages WHERE project_id = ? AND thread != 'group' AND fleet_id IS NOT NULL GROUP BY fleet_id").all(project) as Row[];
    const last = this.db.query("SELECT * FROM messages WHERE seq IN (SELECT MAX(seq) FROM messages WHERE project_id = ? AND kind != 'update' AND thread != 'group' AND fleet_id IS NOT NULL GROUP BY fleet_id)").all(project) as Row[];
    return { activity: new Map(act.map((r) => [r.fleet_id as string, r.at as number])), last: new Map(last.map((r) => [r.fleet_id as string, rowToMessage(r)])) };
  }
  /** Pending deliveries to the project's human captains: total, waking, and `question` messages. */
  captainPending(project: string): Map<string, { unread: number; waking: number; questions: number }> {
    const rows = this.db.query(
      `SELECT d.to_id AS id, COUNT(*) AS unread, SUM(d.wake = 1) AS waking, SUM(m.kind = 'question') AS questions
       FROM deliveries d JOIN messages m ON m.id = d.message_id JOIN agents a ON a.id = d.to_id
       WHERE d.state = 'pending' AND a.kind = 'human' AND a.project_id = ? GROUP BY d.to_id`,
    ).all(project) as Row[];
    return new Map(rows.map((r) => [r.id as string, { unread: r.unread, waking: r.waking ?? 0, questions: r.questions ?? 0 }]));
  }
  /** Cards assigned to a member of each fleet in a project. */
  cardsByFleet(project: string): Map<string, number> {
    const rows = this.db.query('SELECT a.fleet_id AS fleet_id, COUNT(*) AS n FROM cards c JOIN agents a ON a.id = c.assignee_id WHERE c.project_id = ? GROUP BY a.fleet_id').all(project) as Row[];
    return new Map(rows.map((r) => [r.fleet_id as string, r.n as number]));
  }
  messageBySeq(seq: number): Message | null {
    const r = this.db.query('SELECT * FROM messages WHERE seq = ?').get(seq) as Row | null;
    return r ? rowToMessage(r) : null;
  }
  /** wake = false: a quiet delivery (pending like any other, but never wakes the recipient). */
  insertDelivery(messageId: string, toId: string, wake = true) {
    this.db.query("INSERT OR IGNORE INTO deliveries (message_id, to_id, state, call_id, delivered_at, wake) VALUES (?, ?, 'pending', NULL, NULL, ?)").run(messageId, toId, wake ? 1 : 0);
  }
  /** Pending deliveries for an agent (waking and quiet) as messages, in seq order. */
  pendingFor(agentId: string): Message[] {
    return (this.db.query("SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_id = ? AND d.state = 'pending' ORDER BY m.seq").all(agentId) as Row[]).map(rowToMessage);
  }
  /** Most recent delivered messages for an agent, returned in seq order. */
  deliveredFor(agentId: string, limit: number): Message[] {
    return (this.db.query("SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_id = ? AND d.state = 'delivered' ORDER BY m.seq DESC LIMIT ?")
      .all(agentId, limit) as Row[]).reverse().map(rowToMessage);
  }
  /** All pending deliveries, waking and quiet. */
  countPending(agentId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM deliveries WHERE to_id = ? AND state = 'pending'").get(agentId) as Row).n;
  }
  /** Pending deliveries that wake the recipient (quiet ones excluded): these start calls and end long-polls. */
  countWaking(agentId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM deliveries WHERE to_id = ? AND state = 'pending' AND wake = 1").get(agentId) as Row).n;
  }
  markDelivered(agentId: string, messageIds: string[], callId: string | null, now: number) {
    const q = this.db.query("UPDATE deliveries SET state = 'delivered', call_id = ?, delivered_at = ? WHERE to_id = ? AND message_id = ? AND state = 'pending'");
    for (const id of messageIds) q.run(callId, now, agentId, id);
  }
  markPending(agentId: string, messageIds: string[], callId: string) {
    const q = this.db.query("UPDATE deliveries SET state = 'pending', call_id = NULL, delivered_at = NULL WHERE to_id = ? AND message_id = ? AND call_id = ? AND state = 'delivered'");
    for (const id of messageIds) q.run(agentId, id, callId);
  }
  dropPending(agentId: string) {
    this.db.query("UPDATE deliveries SET state = 'dropped' WHERE to_id = ? AND state = 'pending'").run(agentId);
  }
  deliveriesFor(messageId: string): Delivery[] {
    return (this.db.query('SELECT * FROM deliveries WHERE message_id = ?').all(messageId) as Row[]).map(rowToDelivery);
  }
  countMessages(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM messages').get() as Row).n;
  }

  // ---------- cards
  getCard(id: number): Card | null {
    const r = this.db.query('SELECT * FROM cards WHERE id = ?').get(id) as Row | null;
    return r ? rowToCard(r) : null;
  }
  listCards(project?: string | null): Card[] {
    const rows = project
      ? this.db.query('SELECT * FROM cards WHERE project_id = ? ORDER BY state, position, id').all(project)
      : this.db.query('SELECT * FROM cards ORDER BY project_id, state, position, id').all();
    return (rows as Row[]).map(rowToCard);
  }
  maxPosition(project: string, state: CardState): number {
    const r = this.db.query('SELECT MAX(position) AS p FROM cards WHERE project_id = ? AND state = ?').get(project, state) as Row;
    return r.p ?? 0;
  }
  insertCard(c: Omit<Card, 'id'>): Card {
    const res = this.db.query(`INSERT INTO cards (
      project_id, title, details, category, state, position, assignee_id, created_by, notes, created_at, updated_at,
      context, problem, approach, checks, tags, urgent, impact, effort, estimate_min, blocked_on, blocked_at, later_at, history
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.project_id, c.title, c.details, c.category, c.state, c.position, c.assignee_id, c.created_by, JSON.stringify(c.notes), c.created_at, c.updated_at,
        c.context, c.problem, c.approach, JSON.stringify(c.checks), JSON.stringify(c.tags), c.urgent ? 1 : 0, c.impact, c.effort,
        c.estimate_min, c.blocked_on, c.blocked_at, c.later_at, JSON.stringify(c.history));
    return this.getCard(Number(res.lastInsertRowid))!;
  }
  patchCard(id: number, patch: Partial<Card>, now: number): Card {
    const entries = Object.entries({ ...patch, updated_at: now }).filter(([k]) => k !== 'id');
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const vals = entries.map(([k, v]) => (['notes', 'checks', 'tags', 'history'].includes(k) ? JSON.stringify(v) : k === 'urgent' ? (v ? 1 : 0) : v ?? null));
    this.db.query(`UPDATE cards SET ${sets} WHERE id = ?`).run(...(vals as any[]), id);
    return this.getCard(id)!;
  }
  countCards(project: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM cards WHERE project_id = ?').get(project) as Row).n;
  }

  // ---------- catalogs (U1)
  saveCatalog(c: HarnessCatalog) {
    this.db.query('INSERT INTO catalogs (harness, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(harness) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
      .run(c.harness, JSON.stringify(c), c.fetched_at);
  }
  listCatalogs(): HarnessCatalog[] {
    return (this.db.query('SELECT data FROM catalogs ORDER BY harness').all() as Row[]).map((r) => json<HarnessCatalog | null>(r.data, null)).filter((x): x is HarnessCatalog => !!x);
  }

  // ---------- doctor runs (U1)
  saveDoctorRun(r: DoctorRun) {
    this.db.query('INSERT INTO doctor_runs (id, started_at, ended_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, data = excluded.data')
      .run(r.id, r.started_at, r.ended_at, JSON.stringify(r));
  }
  latestDoctorRun(finishedOnly = false): DoctorRun | null {
    const r = this.db.query(`SELECT data FROM doctor_runs ${finishedOnly ? 'WHERE ended_at IS NOT NULL' : ''} ORDER BY started_at DESC, rowid DESC LIMIT 1`).get() as Row | null;
    return r ? json<DoctorRun | null>(r.data, null) : null;
  }

  // ---------- resume tests (U1): latest "Test resume" check per slug
  saveResumeTest(slug: string, c: DoctorCheck) {
    this.db.query('INSERT INTO resume_tests (slug, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(slug, JSON.stringify(c), c.updated_at);
  }
  getResumeTest(slug: string): DoctorCheck | null {
    const r = this.db.query('SELECT data FROM resume_tests WHERE slug = ?').get(slug) as Row | null;
    return r ? json<DoctorCheck | null>(r.data, null) : null;
  }
}
