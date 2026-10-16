// SQLite state for the server: schema + typed row <-> domain mappers.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Agent, AgentState, Call, CallEndReason, Card, CardNote, CardState, Delivery, Message, MessageKind, Project,
} from '../shared/types';

export const SCHEMA_VERSION = 1;

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
  long_notified INTEGER NOT NULL DEFAULT 0
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
  updated_at INTEGER NOT NULL
);
`;

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

export function rowToCard(r: Row): Card {
  return {
    id: r.id, project_id: r.project_id, title: r.title, details: r.details, category: r.category ?? null,
    state: r.state as CardState, position: r.position, assignee_id: r.assignee_id ?? null, created_by: r.created_by,
    notes: json<CardNote[]>(r.notes, []), created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function rowToDelivery(r: Row): Delivery {
  return { message_id: r.message_id, to_id: r.to_id, state: r.state, call_id: r.call_id ?? null, delivered_at: r.delivered_at ?? null };
}

const AGENT_COLS = [
  'id', 'project_id', 'handle', 'kind', 'resume', 'title', 'harness', 'model', 'effort', 'can_hire', 'parent_id', 'depth',
  'cwd', 'tmux_session', 'tmux_window', 'tmux_window_id', 'session_id', 'state', 'call_id', 'last_end_reason',
  'last_update', 'last_update_at', 'last_seen_at', 'created_at', 'updated_at',
] as const;

/** Thin typed wrapper over bun:sqlite. All methods are synchronous. */
export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
    this.db.exec(SCHEMA);
    const v = this.db.query('SELECT version FROM schema_version LIMIT 1').get() as Row | null;
    if (!v) this.db.query('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
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
  getAgent(id: string): Agent | null {
    const r = this.db.query('SELECT * FROM agents WHERE id = ?').get(id) as Row | null;
    return r ? rowToAgent(r) : null;
  }
  getAgentByHandle(projectId: string, handle: string): Agent | null {
    const r = this.db.query('SELECT * FROM agents WHERE project_id = ? AND handle = ?').get(projectId, handle) as Row | null;
    return r ? rowToAgent(r) : null;
  }
  listAgents(projectId?: string | null): Agent[] {
    const rows = projectId
      ? this.db.query('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId)
      : this.db.query('SELECT * FROM agents ORDER BY created_at DESC, rowid DESC').all();
    return (rows as Row[]).map(rowToAgent);
  }
  agentsInState(state: AgentState): Agent[] {
    return (this.db.query("SELECT * FROM agents WHERE state = ? AND kind = 'agent' ORDER BY created_at, rowid").all(state) as Row[]).map(rowToAgent);
  }
  children(agentId: string): Agent[] {
    return (this.db.query('SELECT * FROM agents WHERE parent_id = ? ORDER BY created_at, rowid').all(agentId) as Row[]).map(rowToAgent);
  }
  countWorking(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM agents WHERE state = 'working' AND kind = 'agent'").get() as Row).n;
  }
  oldestQueued(): Agent | null {
    const r = this.db.query("SELECT * FROM agents WHERE state = 'queued' AND kind = 'agent' ORDER BY queued_at, created_at, rowid LIMIT 1").get() as Row | null;
    return r ? rowToAgent(r) : null;
  }
  insertAgent(a: Agent) {
    const vals = AGENT_COLS.map((c) => (c === 'can_hire' ? JSON.stringify(a.can_hire) : (a as any)[c] ?? null));
    this.db.query(`INSERT INTO agents (${AGENT_COLS.join(', ')}) VALUES (${AGENT_COLS.map(() => '?').join(', ')})`).run(...vals);
  }
  /** Patch columns of an agent (bumps updated_at) and return the new row. */
  patchAgent(id: string, patch: Partial<Agent> & { queued_at?: number | null }, now: number): Agent {
    const entries = Object.entries({ ...patch, updated_at: now }).filter(([k]) => k !== 'id');
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const vals = entries.map(([k, v]) => (k === 'can_hire' ? JSON.stringify(v) : v ?? null));
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
    this.db.query('INSERT INTO calls (id, agent_id, started_at, ended_at, end_reason, exit_code, resumed, nudges, restarts, prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.agent_id, c.started_at, c.ended_at, c.end_reason, c.exit_code, c.resumed ? 1 : 0, c.nudges, c.restarts, c.prompt);
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
  insertMessage(m: Omit<Message, 'seq'>): Message {
    const res = this.db.query('INSERT INTO messages (id, project_id, thread, from_id, kind, text, mentions, card_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.project_id, m.thread, m.from_id, m.kind, m.text, JSON.stringify(m.mentions), m.card_id, JSON.stringify(m.meta), m.created_at);
    return { ...m, seq: Number(res.lastInsertRowid) };
  }
  getMessage(id: string): Message | null {
    const r = this.db.query('SELECT * FROM messages WHERE id = ?').get(id) as Row | null;
    return r ? rowToMessage(r) : null;
  }
  listMessages(q: { project?: string | null; thread?: string | null; threadLike?: string | null; after?: number | null; limit: number; fromOrTo?: string | null }): Message[] {
    const where: string[] = [];
    const args: any[] = [];
    if (q.project) { where.push('project_id = ?'); args.push(q.project); }
    if (q.thread) { where.push('thread = ?'); args.push(q.thread); }
    if (q.threadLike) { where.push('thread LIKE ?'); args.push(q.threadLike); }
    if (q.fromOrTo) { where.push("(from_id = ? OR thread LIKE ? OR mentions LIKE ?)"); args.push(q.fromOrTo, `%${q.fromOrTo}%`, `%${q.fromOrTo}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let rows: Row[];
    if (q.after != null) {
      rows = this.db.query(`SELECT * FROM messages ${w}${w ? ' AND' : ' WHERE'} seq > ? ORDER BY seq ASC LIMIT ?`).all(...args, q.after, q.limit) as Row[];
    } else {
      rows = (this.db.query(`SELECT * FROM messages ${w} ORDER BY seq DESC LIMIT ?`).all(...args, q.limit) as Row[]).reverse();
    }
    return rows.map(rowToMessage);
  }
  threadSummaries(project: string): { thread: string; count: number; last_seq: number }[] {
    return this.db.query('SELECT thread, COUNT(*) AS count, MAX(seq) AS last_seq FROM messages WHERE project_id = ? GROUP BY thread ORDER BY last_seq DESC').all(project) as any[];
  }
  messageBySeq(seq: number): Message | null {
    const r = this.db.query('SELECT * FROM messages WHERE seq = ?').get(seq) as Row | null;
    return r ? rowToMessage(r) : null;
  }
  insertDelivery(messageId: string, toId: string) {
    this.db.query("INSERT OR IGNORE INTO deliveries (message_id, to_id, state, call_id, delivered_at) VALUES (?, ?, 'pending', NULL, NULL)").run(messageId, toId);
  }
  /** Pending deliveries for an agent as messages, in seq order. */
  pendingFor(agentId: string): Message[] {
    return (this.db.query("SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.to_id = ? AND d.state = 'pending' ORDER BY m.seq").all(agentId) as Row[]).map(rowToMessage);
  }
  countPending(agentId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM deliveries WHERE to_id = ? AND state = 'pending'").get(agentId) as Row).n;
  }
  markDelivered(agentId: string, messageIds: string[], callId: string | null, now: number) {
    const q = this.db.query("UPDATE deliveries SET state = 'delivered', call_id = ?, delivered_at = ? WHERE to_id = ? AND message_id = ? AND state = 'pending'");
    for (const id of messageIds) q.run(callId, now, agentId, id);
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
    const res = this.db.query('INSERT INTO cards (project_id, title, details, category, state, position, assignee_id, created_by, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.project_id, c.title, c.details, c.category, c.state, c.position, c.assignee_id, c.created_by, JSON.stringify(c.notes), c.created_at, c.updated_at);
    return this.getCard(Number(res.lastInsertRowid))!;
  }
  patchCard(id: number, patch: Partial<Card>, now: number): Card {
    const entries = Object.entries({ ...patch, updated_at: now }).filter(([k]) => k !== 'id');
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const vals = entries.map(([k, v]) => (k === 'notes' ? JSON.stringify(v) : v ?? null));
    this.db.query(`UPDATE cards SET ${sets} WHERE id = ?`).run(...(vals as any[]), id);
    return this.getCard(id)!;
  }
  countCards(project: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM cards WHERE project_id = ?').get(project) as Row).n;
  }
}
