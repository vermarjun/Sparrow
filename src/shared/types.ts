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
  | 'crashed'        // harness exited non-zero or its window vanished
  | 'released'       // a captain ran `sparrow release`
  | 'server_restart';// window found dead when the server booted

export type MessageKind = 'task' | 'chat' | 'update' | 'question' | 'result' | 'system';
export type CardState = 'proposed' | 'todo' | 'in_progress' | 'review' | 'done' | 'dropped';
export type DoneStatus = 'ok' | 'blocked' | 'failed';

export const CARD_STATES: CardState[] = ['proposed', 'todo', 'in_progress', 'review', 'done', 'dropped'];

export interface Project {
  id: string;        // slug, e.g. 'plutus' (basename of the git root; '-2' suffix on clash)
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
  tmux_session: string;          // e.g. 'sparrow-plutus'
  tmux_window: string;           // window NAME, e.g. 'james'
  tmux_window_id: string | null; // tmux window id like '@17' while a window is open, else null
  session_id: string | null;     // harness session id (the "SIM"); null until known
  state: AgentState;
  call_id: string | null;        // the open call, if any
  last_end_reason: CallEndReason | null;
  last_update: string | null;    // text of the latest `update`
  last_update_at: number | null;
  last_seen_at: number | null;   // latest CLI request or hook from this agent
  resume_hash: string | null;    // ResumeView.hash of the resume copy this agent was hired from (or last applied)
  last_run: RunInfo | null;      // what the latest call actually launched with
  created_at: number;
  updated_at: number;
}

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
  thread: string;                // 'group' | 'dm:<agentIdA>:<agentIdB>' (ids sorted ascending)
  from_id: string;               // agent id, or 'system', or 'user' (web UI, unused in v1)
  kind: MessageKind;
  text: string;
  mentions: string[];            // agent ids that got a delivery (woken) by this message
  card_id: number | null;
  meta: Record<string, unknown>; // result: {status}; system: {about: agentId, exit_code?, screen?}
  created_at: number;
}

// Message as returned by the API (adds display fields).
export interface MessageView extends Message {
  from_handle: string;           // 'system' for system messages
  thread_label: string;          // 'group' or 'dm @a ↔ @b'
  to_handles: string[];          // handles of mentions (DM target included)
}

export type DeliveryState = 'pending' | 'delivered' | 'dropped';
export interface Delivery {
  message_id: string;
  to_id: string;
  state: DeliveryState;
  call_id: string | null;        // the call that consumed it
  delivered_at: number | null;
}

export interface CardNote { at: number; by: string; text: string }

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
  created_at: number;
  updated_at: number;
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

export type ResumeStatus = 'ok' | 'harness_missing' | 'harness_logged_out' | 'harness_broken' | 'model_gone' | 'effort_invalid' | 'unchecked';

export interface ResumeView extends Resume {
  hash: string;                  // sha256 (first 12 hex) of the file content; changes on every edit
  builtin: boolean;              // served from assets/resumes (not yet copied to ~/.sparrow/resumes)
  status: ResumeStatus;
  status_detail: string | null;  // human text, e.g. "model gpt-6-nova no longer offered by codex"
  resolved_model: string | null; // claude alias resolved through the catalog
  stale_agents: string[];        // ids of non-retired agents hired from an older copy (agent.resume_hash !== hash)
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
}

export interface CaptainStartReq { cwd: string; model?: string | null; effort?: string | null }
export interface CaptainStartRes { session: string; window: string; window_id: string; cwd: string; attach: string } // attach = exact shell command

// ---------- HTTP API (JSON). Caller identity: header X-Sparrow-Agent: <agent id>.
// Hooks also send X-Sparrow-Call: <call id>; the server ignores hooks for calls that are no longer open.
// Errors: 4xx/5xx with { error: string } — written so an agent can act on it.

export interface RegisterCaptainReq { cwd: string; harness?: string; session_id?: string }
export interface RegisterCaptainRes { agent: Agent; project: Project }

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

export interface SendReq { to: string; text: string; card_id?: number } // to: '@handle' (DM) | 'group' (mentions in text wake)
export interface UpdateReq { text: string; card_id?: number }
export interface AskReq { question: string }
export interface DoneReq { summary: string; status?: DoneStatus }
export interface WaitReq { reason?: string }
export interface ProposeReq { title: string; details?: string; category?: string }
export interface CardCreateReq { title: string; details?: string; category?: string; state?: CardState; assignee?: string }
export interface CardPatchReq { state?: CardState; position?: number; assignee?: string | null; title?: string; details?: string; note?: string }
export interface ReleaseReq { agent: string } // '@handle' or agent id

// Every response to an identified agent carries `inbox`: messages newly delivered to it
// by this response (they are marked delivered). Empty array when none.
export interface WithInbox { inbox: MessageView[] }
export interface MessageRes extends WithInbox { message: MessageView }
// done / ask / wait: ended=false means new messages arrived (in `inbox`) and the agent must keep working.
export interface EndCallRes extends WithInbox { ended: boolean; message: MessageView | null }

// Hooks (sent by `sparrow hook ...` from inside an agent's session)
export interface TurnEndReq { harness: HarnessName; session_id?: string; last_message?: string; stop_hook_active?: boolean }
export interface TurnEndRes { action: 'allow' | 'block' | 'none'; reason?: string } // block: Claude Stop hook continues with `reason`
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
  | { type: 'resume.updated'; project_id: '*'; resume: ResumeView }
  | { type: 'resume.deleted'; project_id: '*'; slug: string };
