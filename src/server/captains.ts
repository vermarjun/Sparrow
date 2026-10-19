// Captain read model: one CaptainSummary per human captain (status, fleet counts, unread, results, how to resume),
// and CaptainDetail (the whole fleet and its cards). Pure reads over the Store; GET /api/captains* is a thin wrapper.
import { attachLine } from '../harness/captain';
import { sq } from '../harness/launch';
import type {
  Agent, CaptainDetail, CaptainResume, CaptainStatus, CaptainSummary, FleetCounts, HarnessName,
} from '../shared/types';
import type { Core } from './core';

const ONLINE_MS = 15 * 60_000;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The exact shell line that reopens a captain's own session, per harness; null without a session id (or for 'unknown'). */
export function resumeCommand(harness: HarnessName | 'unknown', cwd: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const run = harness === 'claude' ? `claude --resume ${sq(sessionId)}`
    : harness === 'codex' ? `codex resume ${sq(sessionId)}`
    : harness === 'opencode' ? `opencode -s ${sq(sessionId)}`
    : null;
  return run ? `cd ${quote(cwd)} && ${run}` : null;
}

/** `open` = the captain's Sparrow-launched tmux window is open (null: not checked, so no attach line). */
export function captainResume(cap: Agent, open: boolean | null): CaptainResume {
  const harness = cap.captain?.harness ?? 'unknown';
  return {
    cwd: cap.cwd, harness, session_id: cap.session_id,
    command: resumeCommand(harness, cap.cwd, cap.session_id),
    attach: open && cap.tmux_window_id && cap.tmux_session ? attachLine(cap.tmux_session, cap.tmux_window_id) : null,
  };
}

/** A session that registered but never did anything captain-like: no team, no title, found in a terminal. (Background sessions and nested `claude -p` runs look like this.) */
export function isPhantom(cap: Agent, hasHires: boolean): boolean {
  return !hasHires && !cap.captain?.title && cap.captain?.origin === 'terminal';
}

const emptyCounts = (): FleetCounts => ({ total: 0, working: 0, queued: 0, waiting: 0, crashed: 0, idle: 0, retired: 0 });

/** working > attention > idle; archived wins over everything. */
export function captainStatus(o: { archived: boolean; hires: Agent[]; waking: number }): CaptainStatus {
  if (o.archived) return 'archived';
  if (o.hires.some((a) => a.state === 'working' || a.state === 'queued')) return 'working';
  if (o.waking > 0 || o.hires.some((a) => a.state === 'crashed' || (a.state === 'waiting' && a.last_end_reason === 'ask'))) return 'attention';
  return 'idle';
}

/** Summaries for the given captains of one project (computed in bulk, so 100 captains cost a handful of queries). */
async function summarize(core: Core, project: string, captains: Agent[]): Promise<CaptainSummary[]> {
  const store = core.store;
  const now = core.now();
  const hiresBy = new Map<string, Agent[]>();
  for (const a of store.listAgents(project)) {
    if (a.kind === 'human') continue;
    const list = hiresBy.get(a.fleet_id);
    if (list) list.push(a); else hiresBy.set(a.fleet_id, [a]);
  }
  const results = store.lastResults(project);
  const stats = store.fleetMessageStats(project);
  const pending = store.captainPending(project);
  const cards = store.cardsByFleet(project);
  const open = new Map(await Promise.all(captains.map(async (c) => [c.id, !!c.tmux_window_id && await core.captainWindowOpen(c).catch(() => false)] as const)));
  return captains.map((cap) => {
    const hires = hiresBy.get(cap.id) ?? [];
    const fleet = emptyCounts();
    const res = { ok: 0, blocked: 0, failed: 0 };
    for (const a of hires) {
      fleet.total++;
      fleet[a.state]++;
      const m = results.get(a.id);
      if (m) res[m.meta?.status === 'blocked' ? 'blocked' : m.meta?.status === 'failed' ? 'failed' : 'ok']++;
    }
    const p = pending.get(cap.id) ?? { unread: 0, waking: 0, questions: 0 };
    const isOpen = open.get(cap.id) ?? false;
    const last = stats.last.get(cap.id) ?? null;
    return {
      agent: cap,
      status: captainStatus({ archived: !!cap.captain?.archived_at, hires, waking: p.waking }),
      online: isOpen || (cap.last_seen_at != null && now - cap.last_seen_at < ONLINE_MS),
      fleet, results: res, unread: p.unread, questions: p.questions,
      last_activity_at: Math.max(stats.activity.get(cap.id) ?? 0, cap.last_seen_at ?? 0, 0) || cap.created_at,
      last_message: last ? core.view(last) : null,
      cards: cards.get(cap.id) ?? 0,
      resume: captainResume(cap, isOpen),
    };
  });
}

/** The project's captains, newest activity first. `archived` adds archived ones; `all` adds phantom ones. */
export async function captainSummaries(core: Core, project: string, o: { archived?: boolean; all?: boolean } = {}): Promise<CaptainSummary[]> {
  let list = await summarize(core, project, core.store.listCaptains(project, !!o.archived));
  if (!o.all) list = list.filter((s) => !isPhantom(s.agent, s.fleet.total > 0));
  return list.sort((a, b) => b.last_activity_at - a.last_activity_at);
}

export async function captainSummary(core: Core, cap: Agent): Promise<CaptainSummary> {
  return (await summarize(core, cap.project_id, [cap]))[0];
}

export async function captainDetail(core: Core, cap: Agent): Promise<CaptainDetail> {
  const members = core.store.fleetMembers(cap.id);
  const ids = new Set(members.map((a) => a.id));
  const cards = core.store.listCards(cap.project_id)
    .filter((c) => (c.assignee_id && ids.has(c.assignee_id)) || (c.state === 'proposed' && ids.has(c.created_by)));
  return { summary: await captainSummary(core, cap), agents: core.withResults(members, cap.project_id), cards };
}
