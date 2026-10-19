// Mock of the multi-captain API (docs/plans/multi-captain.md §5): summaries, detail, patch, resume, fleet messages.
// Unread = waking messages to the captain newer than its last_seen_at (the real server counts pending deliveries).
import type {
  Agent, CaptainDetail, CaptainPatchReq, CaptainResume, CaptainStartRes, CaptainStatus, CaptainSummary, Card, FleetCounts,
  MessageView, ServerEvent,
} from '../../src/shared/types'

export interface CaptainsDb { agents: Agent[]; messages: MessageView[]; cards: Card[] }
type Emit = (ev: ServerEvent) => void

const HANDLE_RE = /^[a-z][a-z0-9-]{0,23}$/
const RESERVED = new Set(['captain', 'group', 'system', 'user', 'all', 'everyone', 'here', 'none'])
const STARS = ['orion', 'vega', 'lyra', 'sirius', 'rigel', 'altair', 'deneb', 'polaris', 'antares', 'castor', 'pollux', 'spica', 'mira', 'atlas']
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const threadIds = (thread: string) => (thread.startsWith('dm:') ? thread.slice(3).split(':') : [])

export function fleetOf(db: CaptainsDb, captainId: string): Agent[] {
  return db.agents.filter((a) => a.fleet_id === captainId)
}

export function fleetMessages(db: CaptainsDb, captainId: string): MessageView[] {
  const ids = new Set(fleetOf(db, captainId).map((a) => a.id))
  return db.messages.filter((m) => threadIds(m.thread).some((id) => ids.has(id)))
}

export function resumeOf(c: Agent): CaptainResume {
  const harness = c.captain?.harness ?? 'unknown'
  const sid = c.session_id
  const cd = `cd ${sh(c.cwd)} && `
  const command = !sid ? null
    : harness === 'codex' ? `${cd}codex resume ${sid}`
    : harness === 'opencode' ? `${cd}opencode -s ${sid}`
    : harness === 'claude' ? `${cd}claude --resume ${sid}`
    : null
  const attach = c.tmux_window_id ? `tmux attach -t ${c.tmux_session} \\; select-window -t ${c.tmux_window_id}` : null
  return { cwd: c.cwd, harness, session_id: sid, command, attach }
}

export function summarize(db: CaptainsDb, c: Agent, now = Date.now()): CaptainSummary {
  const fleet = fleetOf(db, c.id)
  const hires = fleet.filter((a) => a.id !== c.id)
  const counts: FleetCounts = { total: hires.length, working: 0, queued: 0, waiting: 0, crashed: 0, idle: 0, retired: 0 }
  for (const a of hires) counts[a.state]++
  const results = { ok: 0, blocked: 0, failed: 0 }
  for (const a of hires) if (a.last_result) results[a.last_result.status]++
  const msgs = fleetMessages(db, c.id)
  const seen = c.last_seen_at ?? 0
  const toMe = msgs.filter((m) => m.kind !== 'update' && m.mentions.includes(c.id) && m.created_at > seen)
  const unread = toMe.length
  const questions = toMe.filter((m) => m.kind === 'question').length
  const asking = hires.some((a) => a.state === 'crashed' || (a.state === 'waiting' && a.last_end_reason === 'ask'))
  const status: CaptainStatus = c.captain?.archived_at ? 'archived'
    : counts.working + counts.queued > 0 ? 'working'
    : unread > 0 || asking ? 'attention'
    : 'idle'
  const last = msgs.at(-1)
  const ids = new Set(fleet.map((a) => a.id))
  return {
    agent: c, status,
    online: !!c.tmux_window_id || (c.last_seen_at != null && now - c.last_seen_at < 15 * 60_000),
    fleet: counts, results, unread, questions,
    last_activity_at: Math.max(last?.created_at ?? 0, c.last_seen_at ?? 0, c.created_at),
    last_message: [...msgs].reverse().find((m) => m.kind !== 'update') ?? null,
    cards: db.cards.filter((k) => k.assignee_id && ids.has(k.assignee_id)).length,
    resume: resumeOf(c),
  }
}

export function detail(db: CaptainsDb, c: Agent): CaptainDetail {
  const fleet = fleetOf(db, c.id).sort((a, b) => a.created_at - b.created_at)
  const ids = new Set(fleet.map((a) => a.id))
  return {
    summary: summarize(db, c), agents: fleet,
    cards: db.cards.filter((k) => (k.assignee_id && ids.has(k.assignee_id)) || ids.has(k.created_by)),
  }
}

export function nextCaptainHandle(db: CaptainsDb, project: string): string {
  const taken = new Set(db.agents.filter((a) => a.project_id === project).map((a) => a.handle))
  if (!db.agents.some((a) => a.project_id === project && a.kind === 'human')) return 'captain'
  for (const s of STARS) if (!taken.has(`cap-${s}`)) return `cap-${s}`
  for (let n = 2; ; n++) if (!taken.has(`cap-${n}`)) return `cap-${n}`
}

/** Validate a captain name like hire names (§5 PATCH). Returns an error or null. */
export function nameError(db: CaptainsDb, project: string, name: string, self?: string): string | null {
  if (!HANDLE_RE.test(name)) return `name: "${name}" must be lowercase letters, digits and dashes, starting with a letter (max 24)`
  if (RESERVED.has(name) && name !== 'captain') return `name: "${name}" is reserved`
  if (db.agents.some((a) => a.project_id === project && a.handle === name && a.id !== self)) return `name: @${name} is taken in ${project}`
  return null
}

const json = (data: unknown, status = 200) => Response.json(data, { status })
const err = (status: number, error: string) => json({ error }, status)

export function createCaptains(db: CaptainsDb, emit: Emit) {
  const find = (ref: string, project: string | null) => {
    const h = decodeURIComponent(ref).replace(/^@/, '')
    return db.agents.find((a) => a.kind === 'human' && (a.id === h || (a.handle === h && (!project || a.project_id === project))))
  }
  const touch = (c: Agent) => { c.updated_at = Date.now(); emit({ type: 'agent.updated', project_id: c.project_id, agent: c }) }

  /** Called by the u1 start handler once it validated the request: create the captain row first, then "launch". */
  function start(b: { name?: string; title?: string; model?: string | null; effort?: string | null }, cwd: string, project: string): CaptainStartRes | string | undefined {
    if (!db.agents.some((a) => a.project_id === project)) return undefined // not a seeded project: plain launch, no row
    const name = b.name?.trim() || nextCaptainHandle(db, project)
    const bad = nameError(db, project, name)
    if (bad) return bad
    const id = `ag_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const session = name === 'captain' ? `sparrow-${project}` : `sparrow-${project}-${name}`
    const window_id = `@${70 + db.agents.length}`
    const now = Date.now()
    const c: Agent = {
      id, project_id: project, handle: name, kind: 'human', resume: 'captain', title: 'Captain', harness: 'human', model: b.model ?? null,
      effort: b.effort ?? null, can_hire: ['*'], parent_id: null, depth: 0, cwd, tmux_session: session, tmux_window: name, tmux_window_id: window_id,
      session_id: crypto.randomUUID(), state: 'idle', call_id: null, last_end_reason: null, last_update: null, last_update_at: null,
      last_seen_at: now, resume_hash: null, last_run: null, fleet_id: id,
      captain: { title: b.title?.trim() || null, branch: cwd.includes('plutus-') ? `feat/${cwd.split('/').pop()}` : 'main', harness: 'claude', origin: 'sparrow', archived_at: null },
      created_at: now, updated_at: now,
    }
    db.agents.push(c)
    touch(c)
    return { session, window: name, window_id, cwd, attach: `tmux attach -t ${session} \\; select-window -t ${window_id}`, agent_id: id }
  }

  async function handle(req: Request, url: URL, body: unknown): Promise<Response | null> {
    const p = url.pathname
    const project = url.searchParams.get('project')
    if (p === '/api/captains' && req.method === 'GET') {
      if (!project) return err(400, 'project: required (?project=<id>)')
      const all = url.searchParams.get('archived') === '1'
      const list = db.agents.filter((a) => a.project_id === project && a.kind === 'human')
        .map((c) => summarize(db, c))
        .filter((s) => all || s.status !== 'archived')
        .sort((a, b) => b.last_activity_at - a.last_activity_at)
      return json(list)
    }
    let m: RegExpMatchArray | null
    if ((m = p.match(/^\/api\/captains\/([^/]+)$/))) {
      const c = find(m[1], project)
      if (!c) return err(404, `no captain ${decodeURIComponent(m[1])}`)
      if (req.method === 'GET') return json(detail(db, c))
      if (req.method === 'PATCH') {
        const b = (body ?? {}) as CaptainPatchReq
        if (b.name !== undefined) {
          const bad = nameError(db, c.project_id, b.name, c.id)
          if (bad) return err(400, bad)
          c.handle = b.name
        }
        if (b.title !== undefined) c.captain = { ...c.captain!, title: b.title?.trim() || null }
        if (b.archived !== undefined) c.captain = { ...c.captain!, archived_at: b.archived ? Date.now() : null }
        touch(c)
        return json({ agent: c })
      }
    }
    if ((m = p.match(/^\/api\/captains\/([^/]+)\/resume$/)) && req.method === 'POST') {
      const c = find(m[1], project)
      if (!c) return err(404, `no captain ${decodeURIComponent(m[1])}`)
      const r = resumeOf(c)
      if (r.attach) return err(409, `@${c.handle} is already open in tmux. Attach: ${r.attach}`)
      if (!r.session_id) return err(400, `@${c.handle} has no session id yet; run it once from its terminal`)
      if (r.harness !== 'claude') return err(400, `Sparrow can only reopen Claude captains for now. Run it yourself: ${r.command}`)
      const session = c.handle === 'captain' ? `sparrow-${c.project_id}` : `sparrow-${c.project_id}-${c.handle}`
      c.tmux_session = session
      c.tmux_window = c.handle
      c.tmux_window_id = `@${80 + db.agents.length}`
      c.last_seen_at = Date.now()
      touch(c)
      const res: CaptainStartRes = { session, window: c.handle, window_id: c.tmux_window_id, cwd: c.cwd, attach: resumeOf(c).attach!, agent_id: c.id }
      return json(res)
    }
    if (p === '/api/messages' && url.searchParams.get('fleet')) {
      const c = find(url.searchParams.get('fleet')!, project)
      if (!c) return err(404, 'no such captain')
      const after = Number(url.searchParams.get('after') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 500)
      return json(fleetMessages(db, c.id).filter((x) => x.seq > after).slice(-limit))
    }
    return null
  }

  return { handle, start }
}
