// Shared contract — server, harness, cli and web. U1 additions are specified in .orchestra/U1-CONTRACT.md.
// All times are epoch milliseconds.

export type HarnessName = 'claude' | 'codex' | 'opencode' | 'fake';
export type AgentKind = 'human' | 'agent' | 'probe'; // probe = doctor / "test resume" agent: hidden project, not counted in max_running

export type AgentState =
  | 'idle'     // no window; resumable; a delivery wakes it
  | 'queued'   // has pending deliveries, waiting for a free slot (max_running)
  | 'working'  // tmux window open, call in progress
  | 'waiting'  // ended its call with `ask` or `wait`; no window; a delivery wakes it
  | 'crashed'  // last call died and the auto-restart was used up; no window; a delivery wakes it
  | 'retired'; // released; never wakes again

export type CallEndReason =
  | 'done'           // agent ran `sparrow done`
  | 'ask'            // agent ran `sparrow ask`
  | 'wait'           // agent ran `sparrow wait`
  | 'unreported'     // turn ended / exited 0 without done|ask|wait, nudges used up
  | 'provider_error' // the turn ended on a model-provider error (API error screen / OpenCode session.error); not nudged
  | 'crashed'        // harness exited non-zero or its window vanished
  | 'released'       // a captain ran `sparrow release`
  | 'server_restart';// window found dead when the server booted

export type MessageKind = 'task' | 'chat' | 'update' | 'question' | 'result' | 'system';
export type CardState = 'proposed' | 'todo' | 'in_progress' | 'review' | 'done' | 'dropped';
export type DoneStatus = 'ok' | 'blocked' | 'failed';

export const CARD_STATES: CardState[] = ['proposed', 'todo', 'in_progress', 'review', 'done', 'dropped'];

export interface Project {
  id: string;        // slug, e.g. 'tortuga' (basename of the git root; '-2' suffix on clash)
  name: string;
  root: string;      // absolute path of the git root (or cwd when not a git repo)
  created_at: number;
}

export interface Agent {
  id: string;                    // 'ag_' + ulid — the phone number; never changes
  project_id: string;
  handle: string;                // unique within the project: /^[a-z][a-z0-9-]{0,23}$/
  kind: AgentKind;               // 'human' = the user's own captain session (never spawned)
  resume: string;                // resume slug; 'captain' for the human captain
  title: string;                 // resume title
  harness: HarnessName | 'human';
  model: string | null;          // null = harness default
  effort: string | null;
  can_hire: string[];            // resume slugs this agent may hire; ['*'] for the human captain
  parent_id: string | null;      // who hired it (results/questions go here)
  depth: number;                 // human captain 0, its hires 1, their hires 2 (max_depth)
  cwd: string;                   // absolute
  tmux_session: string;          // e.g. 'sparrow-tortuga'
  tmux_window: string;           // window NAME, e.g. 'james'
  tmux_window_id: string | null; // tmux window id like '@17' while a window is open, else null
  session_id: string | null;     // harness session id (the "SIM"); null until known
  state: AgentState;
  call_id: string | null;        // the open call, if any
  last_end_reason: CallEndReason | null;
  last_update: string | null;    // text of the latest `update`
  last_update_at: number | null;
  last_seen_at: number | null;   // latest CLI request or hook from this agent
  last_result?: AgentResult | null; // the latest `done` this agent sent (API read paths only; web keeps it fresh from events)
  call_started_at?: number | null; // start of the open call (API read paths only: /api/agents, CaptainDetail.agents)
  resume_hash: string | null;    // ResumeView.hash of the resume copy this agent was hired from (or last applied)
  last_run: RunInfo | null;      // what the latest call actually launched with
  // Multi-captain (docs/DESIGN.md). A fleet = one human captain + everyone hired under it.
  fleet_id: string;              // id of the human captain at the root of this agent's tree; a human captain: its own id
  captain: CaptainInfo | null;   // set on kind 'human' rows only
  created_at: number;
  updated_at: number;
}

/** What a human captain is: one Claude Code / Codex / OpenCode session the user runs, with its own team (fleet). */
export interface CaptainInfo {
  title: string | null;          // what it works on ("Rate limiting for login"): `sparrow title`, the UI, or `--title`
  branch: string | null;         // git branch of its cwd at the latest register (null outside git / detached)
  harness: HarnessName | 'unknown'; // the captain's own harness (Agent.harness stays 'human')
  origin: 'terminal' | 'sparrow';// the user started it in a terminal, or Sparrow launched it (`sparrow captain`, the UI)
  archived_at: number | null;    // hidden from the default lists (UI / `sparrow captains`); its fleet is untouched
}

export type CaptainStatus = 'working' | 'attention' | 'idle' | 'archived';
// working   = a fleet agent is working or queued
// attention = nothing working, and the captain has unread waking messages, or a fleet agent is crashed / waiting on an `ask`
// idle      = neither; archived = archived_at set (wins over everything)

/** How to get back into a captain: the exact lines, so the user never has to remember a session id. */
export interface CaptainResume {
  cwd: string;
  harness: HarnessName | 'unknown';
  session_id: string | null;
  command: string | null;        // shell line to reopen it yourself, e.g. "cd '/x/tortuga-feat1' && claude --resume 7f3a…"; null without a session id
  attach: string | null;         // tmux attach line while its Sparrow-launched window is open, else null
}

export interface FleetCounts { total: number; working: number; queued: number; waiting: number; crashed: number; idle: number; retired: number }

export interface CaptainSummary {
  agent: Agent;                  // the human captain row (agent.captain is set)
  status: CaptainStatus;
  online: boolean;               // seen in the last 15 min, or its Sparrow-launched window is open
  fleet: FleetCounts;            // hires only (the captain itself is not counted)
  results: { ok: number; blocked: number; failed: number }; // latest `done` per fleet agent
  unread: number;                // deliveries to the captain still pending (it has not run a sparrow command since)
  questions: number;             // pending `question` deliveries to the captain
  last_activity_at: number;      // newest fleet message, or the captain's last_seen_at
  last_message: MessageView | null; // newest fleet message that is not an `update`
  cards: number;                 // cards assigned to a fleet member (captain included)
  resume: CaptainResume;
}

export interface CaptainDetail {
  summary: CaptainSummary;
  agents: Agent[];               // the whole fleet incl. the captain, with last_result, created_at order
  cards: Card[];                 // assigned to a fleet member, or proposed by one
}

export interface CaptainPatchReq { title?: string | null; name?: string; archived?: boolean }

export interface AgentResult { status: DoneStatus; text: string; at: number }

export interface RunInfo { harness: HarnessName | 'human'; model: string | null; effort: string | null; at: number }

// One call = one window lifetime (spawn → done/ask/wait/crash/...).
export interface Call {
  id: string;                    // 'call_' + ulid
  agent_id: string;
  started_at: number;
  ended_at: number | null;
  end_reason: CallEndReason | null;
  exit_code: number | null;
  resumed: boolean;              // started by resuming agent.session_id
  nudges: number;                // reminders sent during this call
  restarts: number;              // auto-restarts already used in this chain of calls
  prompt: string;                // envelope passed as the first prompt
  harness: HarnessName | null;   // launched with (null for rows from before U1)
  model: string | null;
  effort: string | null;
}

export interface Message {
  seq: number;                   // global monotonic
  id: string;                    // 'msg_' + ulid
  project_id: string;
  thread: string;                // 'dm:<agentIdA>:<agentIdB>' (ids sorted ascending); old 'group' rows are hidden by the API
  from_id: string;               // agent id, or 'system', or 'user' (web UI, unused in v1)
  kind: MessageKind;
  text: string;
  mentions: string[];            // agent ids woken by this message (quiet recipients are not listed)
  card_id: number | null;
  meta: Record<string, unknown>; // result: {status, call_ms?}; system: {about: agentId, fyi?, exit_code?, screen?}
  created_at: number;
}

// Message as returned by the API (adds display fields).
export interface MessageView extends Message {
  from_handle: string;           // 'system' for system messages
  thread_label: string;          // 'dm @a ↔ @b'
  to_handles: string[];          // handles of mentions (DM target included)
}

export type DeliveryState = 'pending' | 'delivered' | 'dropped';
export interface Delivery {
  message_id: string;
  to_id: string;
  state: DeliveryState;
  wake: boolean;                 // false = quiet: never wakes or ends a long-poll; handed over with the next waking delivery
  call_id: string | null;        // the call that consumed it
  delivered_at: number | null;
}

// Board v2 (.orchestra/BOARD-CONTRACT.md). Notes are the card's timeline: 'comment' = written by a person or agent,
// 'event' = written by the server (moves, assignment, flags, edits). Notes from before v2 have no kind: treat as 'comment'.
export type CardNoteKind = 'comment' | 'event';
export interface CardNote { at: number; by: string; text: string; kind?: CardNoteKind }
export type CardLevel = 'low' | 'medium' | 'high';
export const CARD_LEVELS: CardLevel[] = ['low', 'medium', 'high'];
export interface CardCheck { text: string; done: boolean }                       // one "Done when" item
export interface CardTransition { at: number; by: string; from: CardState | null; to: CardState } // from=null: creation

export interface Card {
  id: number;                    // global autoincrement, shown as #12
  project_id: string;
  title: string;
  details: string;
  category: string | null;
  state: CardState;
  position: number;              // order within its column (ascending float)
  assignee_id: string | null;
  created_by: string;            // agent id, or 'user' (web UI)
  notes: CardNote[];
  created_at: number;            // = proposed/created date
  updated_at: number;
  // ---- Board v2. The four brief sections (markdown; '' when empty). `details` stays as free-form "More details".
  context: string;               // why it exists: who asked, where it came from (a meeting, a chat), what it unblocks
  problem: string;               // what is wrong right now (observed vs expected)
  approach: string;              // plain-English proposal of the fix. NEVER code.
  checks: CardCheck[];           // "Done when": verifiable acceptance checks
  tags: string[];                // free labels (lowercase, trimmed, unique); `category` is the one primary bucket
  urgent: boolean;
  impact: CardLevel | null;      // the "return" of doing it
  effort: CardLevel | null;
  estimate_min: number | null;   // proposer's estimate of time to done, minutes
  blocked_on: string | null;     // who/what we are waiting on ("IT: NetSuite sandbox access"); null = not blocked
  blocked_at: number | null;     // when it became blocked
  later_at: number | null;       // shelved under the "Later" line of its column; null = not shelved
  history: CardTransition[];     // every state change, oldest first (creation included)
}

export interface Resume {
  slug: string;                  // file name without .md
  title: string;
  description: string;
  harness: HarnessName;
  model: string | null;
  effort: string | null;
  can_hire: string[];
  limits: { quiet_minutes: number; max_call_minutes: number };
  body: string;                  // role prompt (markdown after the frontmatter)
  path: string;
  skills?: string[];             // library skill names granted to agents hired from this resume (Sparrow's own are always on)
  helper?: boolean;              // a leaf assistant (deckhand, advisor): never hires; hiring only helpers does not make an agent a captain
  one_shot?: boolean;            // released (retired) by the server as soon as it reports with `sparrow done`
}

// ---------- U1: model catalog, doctor, editable resumes, captain launcher

export interface CatalogModel {
  id: string;                    // exactly what is passed to the harness (--model / -m)
  label: string;                 // display name
  efforts: string[];             // effort values this model accepts, in harness order; [] = no effort control
  default_effort: string | null;
  hidden: boolean;               // harness marks it hidden (codex visibility 'hide'); still valid, shown last
  cost: { input: number; output: number } | null; // USD per 1M tokens when the harness reports it
  resolves_to: string | null;    // claude alias -> full id (e.g. 'opus' -> 'claude-opus-5-5'); else null
  description: string | null;
}

export interface HarnessCatalog {
  harness: HarnessName;          // 'claude' | 'codex' | 'opencode' (never 'fake')
  ok: boolean;                   // fetch succeeded
  error: string | null;          // why the fetch failed (binary missing, command error, ...), with a fix hint
  version: string | null;        // harness --version at fetch time
  binary: string | null;         // absolute path used
  models: CatalogModel[];
  fetched_at: number;
}

export type CheckStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  id: string;                    // stable key, e.g. 'claude.binary', 'claude.login', 'claude.catalog', 'claude.spawn', 'claude.roundtrip', 'tmux', 'port', 'path', 'skills', 'hooks'
  harness: HarnessName | null;   // null for shared checks
  label: string;
  status: CheckStatus;
  detail: string;                // what was observed (version, path, model used, duration, error text)
  fix: string | null;            // what the user should do when status is warn/fail
  duration_ms: number | null;
  updated_at: number;
}

export interface DoctorRun {
  id: string;                    // 'doc_' + ulid
  started_at: number;
  ended_at: number | null;       // null while running
  checks: DoctorCheck[];
  versions: Record<string, string | null>;   // harness -> version seen this run
  version_changed: string[];     // harnesses whose version differs from the previous run ("re-verified on new version")
}

// Per-harness verdict used by the hire gate and the UI. From the latest finished doctor run; null fields = not checked yet.
export interface HarnessHealth {
  harness: HarnessName;
  installed: boolean | null;
  logged_in: boolean | null;
  working: boolean | null;       // round trip passed
  fix: string | null;
  checked_at: number | null;
}

/** Model-provider health (D2): consecutive provider errors per harness + provider (provider = model prefix, else the harness). */
export interface ProviderHealth {
  harness: HarnessName;
  provider: string;              // e.g. 'opencode-go' for model opencode-go/kimi-k3; 'claude' when the harness default is used
  degraded: boolean;             // N consecutive errors within M minutes, no success since
  errors: number;                // errors in the current streak (within the window)
  last_error: string | null;     // first line of the latest error
  last_error_at: number | null;
  last_ok_at: number | null;
  degraded_since: number | null;
}

export type ResumeStatus = 'ok' | 'harness_missing' | 'harness_logged_out' | 'harness_broken' | 'model_gone' | 'effort_invalid' | 'unchecked';

export interface ResumeView extends Resume {
  hash: string;                  // sha256 (first 12 hex) of the file content; changes on every edit
  builtin: boolean;              // served from assets/resumes (not yet copied to ~/.sparrow/resumes)
  status: ResumeStatus;
  status_detail: string | null;  // human text, e.g. "model gpt-6-nova no longer offered by codex"
  resolved_model: string | null; // claude alias resolved through the catalog
  stale_agents: string[];        // ids of non-retired agents hired from an older copy (agent.resume_hash !== hash)
  provider?: string;             // the provider this resume's agents talk to (model prefix, else the harness)
  provider_health?: ProviderHealth | null; // set while that harness + provider is degraded (D2); never blocks hiring
}

export interface ResumeWriteReq {
  slug?: string;                 // required on create; ignored on update (slug = file name, immutable)
  title: string;
  description: string;
  harness: HarnessName;
  model: string | null;
  effort: string | null;
  can_hire: string[];
  limits: { quiet_minutes: number; max_call_minutes: number };
  body: string;
  skills?: string[];
  helper?: boolean;              // absent on PUT = unchanged
  one_shot?: boolean;            // absent on PUT = unchanged
}

// ---------- Settings (GET/PUT /api/settings; the web Settings page)

export type SettingKey =
  | 'max_running' | 'max_depth' | 'max_nudges' | 'max_restarts' | 'close_grace_ms' | 'watchdog_ms' | 'snapshot_ms'
  | 'fresh_fallback_ms' | 'quiet_minutes' | 'max_call_minutes' | 'doctor_timeout_ms' | 'provider_error_threshold'
  | 'provider_error_window_minutes' | 'max_running_per_captain';

export interface SettingField {
  key: SettingKey;
  group: string;                 // section on the Settings page
  label: string;
  help: string;
  unit: string;                  // 'agents', 'levels', 'minutes', 'ms', ...
  min: number;
  max: number;
  default: number;
  value: number;                 // effective value right now
  saved: boolean;                // set in config.json (else the default applies)
  env_override: boolean;         // SPARROW_SETTINGS sets it: read-only here
}

export interface SettingsView {
  fields: SettingField[];
  doctor_models: Partial<Record<'claude' | 'codex' | 'opencode', string>>;
  file: string;                  // the config.json the page writes
}

/** A number sets the value; null resets it to the default (removes it from config.json). */
export interface SettingsWriteReq {
  values?: Partial<Record<SettingKey, number | null>>;
  doctor_models?: Partial<Record<'claude' | 'codex' | 'opencode', string | null>>;
}

export interface CaptainStartReq { cwd: string; model?: string | null; effort?: string | null; name?: string; title?: string }
// attach = exact shell command; agent_id = the captain row Sparrow created before launching (multi-captain)
export interface CaptainStartRes { session: string; window: string; window_id: string; cwd: string; attach: string; agent_id?: string }

// ---------- HTTP API (JSON). Caller identity: header X-Sparrow-Agent: <agent id>.
// Hooks also send X-Sparrow-Call: <call id>; the server ignores hooks for calls that are no longer open.
// Errors: 4xx/5xx with { error: string } — written so an agent can act on it.

// captain_id: SPARROW_CAPTAIN_ID ('ag_…' or a handle) — wins over session_id. adopt: bind this session to an existing
// captain of the project (after /clear, or from a new terminal). name: handle for a NEW row only.
// pid: the captain harness process (CLAUDE_PID). /clear gives Claude a new session id in the same process, so a register
// whose session id is unknown but whose pid matches a recently seen captain row re-attaches to it (auto-adopt).
export interface RegisterCaptainReq { cwd: string; harness?: string; session_id?: string; captain_id?: string; adopt?: string; name?: string; pid?: number }
export interface RegisterCaptainRes { agent: Agent; project: Project; created?: boolean }

export interface HireReq {
  resume: string;
  task: string;
  name?: string;                 // handle; auto-picked when omitted
  cwd?: string;                  // default: caller's cwd
  tmux_session?: string;         // default: '<tmux_prefix><project>'
  tmux_window?: string;          // default: handle
  card_id?: number;              // assigns the card and moves it to in_progress
  model?: string;                // override resume
  effort?: string;               // override resume
}
export interface HireRes extends WithInbox { agent: Agent; message: MessageView }

export interface SendReq { to: string; text: string; card_id?: number } // to: '@handle' (DM only; group chat was removed)
export interface UpdateReq { text: string; card_id?: number }
export interface AskReq { question: string }
export interface DoneReq { summary: string; status?: DoneStatus }
export interface WaitReq { reason?: string }
// Board v2 card fields shared by propose / create / patch. On patch, omitted = unchanged; null clears a nullable field.
export interface CardFields {
  details?: string; category?: string | null;
  context?: string; problem?: string; approach?: string;
  checks?: (CardCheck | string)[];  // a bare string = an unticked check
  tags?: string[];
  urgent?: boolean;
  impact?: CardLevel | null; effort?: CardLevel | null;
  estimate_min?: number | null;
  blocked_on?: string | null;       // non-empty string blocks (sets blocked_at if it was not blocked); null/'' unblocks
  later?: boolean;                  // true shelves (sets later_at), false unshelves
}
export interface ProposeReq extends CardFields { title: string }
export interface CardCreateReq extends CardFields { title: string; state?: CardState; assignee?: string }
export interface CardPatchReq extends CardFields {
  state?: CardState; position?: number;
  assignee?: string | null;         // '@handle' | agent id | 'me' (the caller) | null/'none'
  title?: string;
  note?: string;                    // appends a 'comment'
  check?: { index: number; done: boolean }; // tick/untick one check (0-based); the assignee may do this
}
export interface ReleaseReq { agent: string } // '@handle' or agent id

// Every response to an identified agent carries `inbox`: messages newly delivered to it
// by this response (they are marked delivered). Empty array when none.
export interface WithInbox { inbox: MessageView[] }
export interface MessageRes extends WithInbox { message: MessageView }
// done / ask / wait: ended=false means new messages arrived (in `inbox`) and the agent must keep working.
export interface EndCallRes extends WithInbox { ended: boolean; message: MessageView | null }

// GET /api/inbox: the caller's non-retired children whose state is not idle (the "Still working" digest).
export interface TeamStatus {
  handle: string;
  resume: string;
  harness: HarnessName | 'human';
  state: AgentState;
  call_started_at: number | null;  // the open call's start, else null
  last_update: string | null;
  last_update_at: number | null;
}
export interface InboxRes extends WithInbox { team: TeamStatus[]; superseded?: boolean }

// Hooks (sent by `sparrow hook ...` from inside an agent's session)
export interface TurnEndReq { harness: HarnessName; session_id?: string; last_message?: string; stop_hook_active?: boolean }
export interface TurnEndRes { action: 'allow' | 'block' | 'none'; reason?: string } // block: Claude Stop hook continues with `reason`
export interface ProviderErrorReq { harness?: HarnessName; session_id?: string; message: string } // POST /api/hooks/provider-error (OpenCode session.error)
export interface ExitReq { code: number }
export interface SessionReq { session_id: string }

// SSE GET /api/events (optionally ?project=<id>); each event is `data: <json ServerEvent>`
export type ServerEvent =
  | { type: 'message.created'; project_id: string; message: MessageView }
  | { type: 'agent.updated'; project_id: string; agent: Agent }
  | { type: 'card.updated'; project_id: string; card: Card }
  | { type: 'call.started'; project_id: string; call: Call }
  | { type: 'call.ended'; project_id: string; call: Call }
  // Global events (U1): project_id is '*'; delivered to every SSE subscriber regardless of ?project=
  | { type: 'catalog.updated'; project_id: '*'; catalogs: HarnessCatalog[] }
  | { type: 'doctor.updated'; project_id: '*'; run: DoctorRun }
  | { type: 'provider.updated'; project_id: '*'; providers: ProviderHealth[] }
  | { type: 'resume.updated'; project_id: '*'; resume: ResumeView }
  | { type: 'resume.deleted'; project_id: '*'; slug: string }
  // Skills library changed (any write under /api/skills): pages refetch GET /api/skills
  | { type: 'skills.updated'; project_id: '*' };
