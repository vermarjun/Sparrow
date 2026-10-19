# Sparrow — design

Sparrow is a personal, harness-agnostic agent factory that runs on one Mac. Your own Claude Code session is the captain. It hires named agents from resumes; a local server opens each one in its own tmux window as a real interactive Claude Code, Codex or OpenCode session; agents report through the `sparrow` CLI; finished agents are closed to free RAM and resumed on the same session when messaged again.

Code layout: `src/shared` (types, config), `src/server` (state, API, lifecycle), `src/harness` (tmux + one driver per harness), `src/cli` (the `sparrow` command and hooks), `assets` (protocol, skills, resumes, OpenCode plugin), `web` (observer UI).

## 0. Requirements

- A captain (the user's own Claude Code session) hires named agents from **resumes** (role cards). The **server spawns each agent in its own tmux window** as a real interactive session the user can watch:
  `claude --dangerously-skip-permissions …`, `codex --yolo …`, `opencode --auto …` (OpenCode has no `--yolo`; `--auto` is its auto-approve flag).
- The server passes the correct **system prompt** (protocol + resume) and the **message** as the first prompt.
- **Agents push their own updates** to the server through the `sparrow` CLI, as taught by a skill + the system prompt. The server never scrapes the TUI for updates. The server's jobs: spawn, route messages, enforce limits, notice failures.
- When an agent finishes (`sparrow done`) the server **closes its window to free RAM**. Messaging that agent later **respawns it on the same harness session** (resume) with the new message, so it remembers.
- Failure cases are handled: the agent crashes / dies / forgets to report.
- Captain flags on hire: `--cwd`, `--tmux-session`, `--tmux-window` (defaults: captain's cwd, `sparrow-<project>`, the handle).
- Kanban is tracking only. Dragging a card in the UI never spawns or messages anything. Agents propose cards; captains move them.
- Everything runs on one Mac. No auth, no sandbox, no worktree management (a captain may pass `--cwd` to a worktree it made).

## 1. Vocabulary

| Word | Meaning |
|---|---|
| **Server** | `sparrow up` — Hono on `127.0.0.1:4040`, SQLite at `~/.sparrow/sparrow.db`. Routes messages, spawns windows, watchdog. Never runs a model. |
| **CLI** | `sparrow <cmd>` — how every agent (and the captain) talks to the server. Identity from env `SPARROW_AGENT_ID`. |
| **Resume** | role card `~/.sparrow/resumes/<slug>.md` (seeded from `assets/resumes/`). |
| **Agent** | one hire of a resume in a project. Has a permanent id (`ag_…`, the "phone number"), a handle (`@james`), a harness session id (the "SIM"). |
| **Captain** | the user's own session (`kind: human`, depth 0, never spawned) — or an agent whose `can_hire` names at least one non-helper resume (a sub-captain). |
| **Helper** | a leaf resume (`helper: true`: `deckhand`, `advisor`) other agents may be allowed to hire. It never hires (its `can_hire` is ignored), and being able to hire only helpers does not make an agent a captain (no captain card rights). |
| **Call** | one window lifetime: spawn → `done`/`ask`/`wait`/crash/… The agent is "on a call" only while its window is open. |
| **Delivery** | a message addressed to an agent that has not reached it yet (`pending`) or has (`delivered`). |
| **Envelope** | the text the server passes as the first prompt of a call (or types into a TUI): the pending messages, formatted. |
| **Nudge** | a reminder the server sends into a session that stopped without reporting. |

## 3. Lifecycle (server rules)

### 3.1 Identity
- Agent windows get env: `SPARROW_AGENT_ID`, `SPARROW_CALL_ID`, `SPARROW_URL`, `SPARROW_HARNESS`, and `PATH` prefixed with `<repo>/bin`. `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` and any `CODEX_*`/`OPENCODE_*` session vars inherited from the parent are unset.
- CLI without `SPARROW_AGENT_ID` = **captain mode**: it calls `POST /api/captains/register {cwd}` and uses the returned agent id. Project = basename of `git rev-parse --show-toplevel` of cwd (or cwd). One human captain per project (handle `captain`), idempotent.

### 3.2 Hire (`POST /api/hire`)
1. Caller must be a captain: human captain may hire any resume; an agent may hire only slugs in its resume `can_hire`. Else 403 `"@<handle> (<resume>) may not hire <slug>: can_hire = [..]"`.
2. `depth = caller.depth + 1`; refuse when `> max_depth` (403, say why). Default `max_depth` 3: you (0) → sub-captain (1) → builder (2) → helper (3).
3. Resume must exist (404 lists available slugs). Handle: `name` if given (lowercased, validated, must be unused in the project → 409), else the first unused name from a fixed friendly list (`james, maya, leo, iris, omar, nina, theo, zara, ravi, lena, ivan, mira, kai, ada, ben, cleo`) then `<resume>-<n>`.
4. `cwd` default = caller's cwd (the CLI always sends `--cwd` resolved to an absolute path, else `process.cwd()`). `tmux_session` default `TMUX_PREFIX + project_id`; `tmux_window` default = handle.
5. Use the resume's configured model and effort by default. The captain can set those choices in the UI; explicit `model` or `effort` request values override them. When an override differs from the resume, include it in the task message's `meta.override` and the server hire log. Insert the agent (state `idle`) and a DM message kind `task` from caller to new agent (text = task) with a pending delivery, assign card if `card_id` (→ `in_progress`, note "assigned to @x"). Then **wake** (3.4). Return immediately (`HireRes`).

### 3.3 Messages and wake rules
- `send {to:'@h', text}` → DM thread between caller and target; waking delivery to target. Unknown handle → 404 listing the roster. Retired target → 409.
- The `group` handle remains reserved. `POST /api/send` requests to it return 400 with `Group chat was removed. DM a teammate: sparrow send @<handle> "…"`. Existing `thread = 'group'` rows remain in the database but are hidden: `/api/threads` omits them and `/api/messages` filters them out; requesting `?thread=group` returns `[]`.
- `update {text}` → DM thread between caller and parent, kind `update`, quiet delivery (`wake = 0`). It sets `last_update(_at)` and, when `card_id` is given, appends a card note. Updates never wake or interrupt the parent; they are handed over with a result or other waking delivery, or appear in the parent's timeout digest. A human captain has no parent, so `update` returns 400: `@captain has no parent; updates go to a parent. Use sparrow card note to annotate a card.`
- `ask {question}` → DM to parent, kind `question`, delivery to parent. Ends the call (3.6) with reason `ask` → state `waiting`.
- `done {summary, status}` → DM to parent, kind `result`, `meta.status`, and `meta.call_ms` (the call duration in milliseconds), waking delivery to parent. Ends the call with `done` → state `idle`.
- `wait {reason}` → DM to parent, kind `update`, text `waiting: <reason>`, quiet delivery. Ends the call with `wait` → state `waiting`. A human captain's `wait` records no message, sets `last_update`, and ends normally.
- The human captain is never spawned; its deliveries stay pending until it calls any endpoint (piggyback) or `GET /api/inbox`.
- FYI system notices (`fyiParent`: restarting, restart queued, quiet nudge) go to the parent as quiet DM deliveries. Terminal notices (`notifyParent`) remain waking deliveries. System messages use a DM thread between parent and agent with `meta.about = agentId`. No quiet delivery is created when its recipient parent is retired.
- **Piggyback:** every response to an identified caller includes all its pending deliveries, quiet and waking, now marked `delivered` (with the caller's open `call_id`) and ordered by seq. Quiet deliveries are never added to `Message.mentions`.

### 3.4 Wake (a pending delivery for a non-human agent)
- A quiet delivery is pending like any other, but never triggers wake/spawn/dequeue, never resolves `inbox --wait` early, and never blocks `done`/`ask`/`wait`.
- A recipient's response piggyback, `GET /api/inbox`, and new-call envelope include quiet and waking pending messages in seq order. Turn-end hands off all pending messages only when at least one waking delivery is pending; a quiet-only set follows the nudge path (§3.7). Starting a call still requires at least one pending waking delivery.
- state `working` → the agent gets new messages via piggyback, at `done/ask/wait` (3.6), or via turn-end (3.7); only waking deliveries initiate a call.
- state `idle | waiting | crashed` → if at least one waking delivery is pending and working count `< max_running`: **start a call** (below). Else state `queued` only when a waking delivery is pending.
- state `queued` → nothing (dequeued FIFO when a slot frees: any call end or release).
- state `retired` → delivery `dropped`.
- **Start a call:** new `call_id`; envelope = all pending deliveries for the agent, quiet and waking (mark delivered with this call); `resume = agent.session_id != null`; render system prompt; `spawner.start(...)`; store `tmux_window_id`, `session_id` (if returned), state `working`, `call_id`, insert `calls` row; emit events. If `spawner.start` throws → state `crashed`, system message to parent with the error.

### 3.5 Calls in progress
- Any CLI request or hook from the agent sets `last_seen_at`.
- Watchdog every `watchdog_ms`: for each `working` agent, `spawner.isAlive`. Dead on two consecutive checks with the call still open → treat as exit with code `-1` (3.8).
- Snapshot every `snapshot_ms` (`spawner.capture`) kept in memory for the UI (`GET /api/agents/:id/screen` captures live when the window is open, else returns the last snapshot) and for crash reports.
- Quiet: no `last_seen_at` for the resume's `quiet_minutes` → one nudge (via `spawner.deliver`) "post a progress update with `sparrow update`" (counts toward `nudges`). At `max_call_minutes` → one system message to the parent ("@x has been working N min; last update …"). Never auto-kill a working agent for time.

### 3.6 Ending a call (`done` / `ask` / `wait`)
- If the agent has pending waking deliveries → do NOT end and do NOT record the result/question: return `{ended:false, message:null, inbox:[…]}` (all pending deliveries, including quiet ones, are marked delivered). The CLI tells the agent its report was not sent; handle the messages, then send the full report again. Quiet deliveries alone do not block ending, so they can be delivered with the report.
- Else record the message (result/question/update as above).
- Else: close the call (`end_reason`), set state, `tmux_window_id` stays until closed, then after `close_grace_ms` call `spawner.stop(agent)` and null `tmux_window_id` — unless a new call started meanwhile. Return `{ended:true}`.
- Free slot → dequeue the oldest `queued` agent.
- **One-shot** (resume `one_shot: true`, e.g. `deckhand`): a recorded `done` (any status) ends the call with state `retired` instead of `idle`, drops pending deliveries, and marks the result `meta.released: true` (headers show `released (one-shot)`). The window still closes after `close_grace_ms`. A "Not sent" `done` releases nothing. The flag is read from the live resume when `done` runs. A retired agent's later reports (any `done`/`ask`/`wait`) record nothing.

### 3.7 Turn ended without reporting (`POST /api/hooks/turn-end`)
Harness signals: Claude `Stop` hook, Codex `notify` (agent-turn-complete), OpenCode plugin `session.idle`.
1. Store `session_id` if given and the agent has none (or it differs and the call is not a resume — then update).
2. Call already ended (done/ask/wait) → `{action:'allow'}`.
3. At least one waking delivery pending → deliver all pending messages, quiet and waking: Claude → `{action:'block', reason: <envelope>}` (Claude continues with them); Codex/OpenCode/fake → `{action:'none'}` and `spawner.deliver(agent, envelope)` ~1 s later. Mark delivered. Quiet-only pending deliveries count as nothing pending here and continue through the nudge path below.
4. Else if `nudges < max_nudges` → nudges++; Claude → `{action:'block', reason: NUDGE_REPORT}`; others → `{action:'none'}` + `spawner.deliver(agent, NUDGE_REPORT)` ~1 s later.
5. Else → end the call `unreported` (state `idle`), system message to parent: "@x stopped without reporting. Its last message: «…»" (last_message from the hook, else tail of the last snapshot), close the window after grace. Claude → `{action:'allow'}`.

### 3.8 Exit / crash (`POST /api/hooks/exit {code}` or watchdog)
- Hook from a call that is not the open one → ignore.
- Call already ended → ignore (it was closed on purpose).
- `code == 0` (user typed /exit, or the harness quit cleanly) without done → end `unreported` as in 3.7 step 5 (no restart).
- Otherwise → end `crashed` with `exit_code`. If `restarts < max_restarts` → start a new call with `restarts+1`, envelope = CRASH_RESUME notice + any pending deliveries; `resume = true` — **unless** the dying call was itself a resume that died within `fresh_fallback_ms` (a broken session) → start FRESH (session_id = null) with an envelope that replays the agent's task + its last 10 messages (thread with parent) + its last update. Post a system message to the parent either way ("@x crashed (exit N); restarting").
- Restarts used up → state `crashed`, system message to parent with exit code + last 20 lines of the snapshot; "send @x a message to resume it".
- `restarts` resets to 0 when a call ends with done/ask/wait.

### 3.9 Server boot recovery
For agents in `working`: window alive → keep (re-adopt, restart watchdog). Dead → end the call `server_restart`, state `crashed`, system message to parent ("interrupted by a server restart; message @x to resume"). No auto-restart on boot. `queued` agents are re-evaluated.

### 3.10 Release (`POST /api/release {agent}`)
Caller must be the agent's parent or the human captain. Stop the window, end any call `released`, state `retired`, drop pending deliveries (quiet and waking).
Permanent by design (owner decision, 17 Oct 2026): an agent is hired for one job. Before release it stays callable by its session id indefinitely, with full memory. After its job is verified and integrated, the captain releases it; new work goes to a fresh hire so no agent carries stale context. Do not add un-retire, rehire or number expiry unless the owner asks.

### 3.11 Limits
`max_running` counts agents in state `working` across all projects (human captains excluded). `loadSettings()` gives all tunables: defaults, then `<SPARROW_HOME>/config.json`, then `SPARROW_SETTINGS` (env). The web **Settings** page edits them live (`src/server/settings.ts`): `PUT /api/settings` validates every value (whole numbers within each field's range; all-or-nothing), writes `config.json` atomically keeping other keys (`skills_dir`, unknown ones), and mutates the shared settings object, so every reader sees the new value at once. Raising `max_running` dequeues at once; `watchdog_ms` / `snapshot_ms` re-arm their timers. `null` resets a key (removes it from the file). Keys set by `SPARROW_SETTINGS` are read-only (409). A caller identified as an agent (`x-sparrow-agent`) gets 403; like the rest of the local API this is a guard against mistakes, not authentication.

## 4. HTTP API (JSON, 127.0.0.1 only, no auth)

Identity header `x-sparrow-agent`; hooks add `x-sparrow-call`. Every response to an identified agent includes `inbox` (piggyback, 3.3). Types are in `src/shared/types.ts`.

| Method & path | Body / query | Returns |
|---|---|---|
| GET `/api/health` | | `{ok:true, version, pid, started_at}` |
| POST `/api/captains/register` | `RegisterCaptainReq` | `RegisterCaptainRes` |
| GET `/api/whoami` | | `{agent, project, parent: Agent\|null}` + inbox |
| GET `/api/settings` | | `SettingsView` (fields with value, default, range, unit, help, saved, env_override; doctor_models; file) |
| PUT `/api/settings` | `SettingsWriteReq` `{values?: {key: number\|null}, doctor_models?: {harness: model\|null}}` | `SettingsView`; 400 bad value, 403 agent caller, 409 env-owned key |
| GET `/api/resumes` | | `Resume[]` (body included) |
| GET `/api/projects` | | `(Project & {agents:number, working:number, cards:number})[]` |
| GET `/api/agents` | `?project=` | `Agent[]` (all states, newest first) |
| GET `/api/agents/:id` | | `{agent, calls: Call[] (last 20), children: Agent[]}` |
| GET `/api/agents/:id/screen` | `?lines=200` | `{text, live: boolean, at}` |
| POST `/api/hire` | `HireReq` | `HireRes` |
| POST `/api/send` | `SendReq` | `MessageRes` |
| POST `/api/update` | `UpdateReq` | `MessageRes` |
| POST `/api/ask` | `AskReq` | `EndCallRes` |
| POST `/api/done` | `DoneReq` | `EndCallRes` |
| POST `/api/wait` | `WaitReq` | `EndCallRes` |
| GET `/api/inbox` | `?wait=<sec ≤600>` or `?last[=<N, 1..50>]` (default 10 when `last` is present) | `{inbox, team: TeamStatus[]}` — waits for ≥1 waking pending delivery or timeout; one long-poll per agent, with a newer wait superseding the older one and returning `{inbox:[], superseded:true}` without taking deliveries. `last` reads the newest already-delivered messages in seq order without changing delivery state. |
| GET `/api/messages` | `?project=&thread=&after=<seq>&limit=100` | `MessageView[]` ascending |
| GET `/api/threads` | `?project=` | `{thread, label, members: string[], last: MessageView, count}[]` |
| POST `/api/propose` | `ProposeReq` | `{card}` + inbox (state `proposed`) |
| GET `/api/cards` | `?project=` | `Card[]` |
| POST `/api/cards` | `CardCreateReq` (+`project` when no caller) | `{card}` — captains only (or UI with no caller) |
| PATCH `/api/cards/:id` | `CardPatchReq` | `{card}` — captains, the assignee (notes / `review`), or UI. NEVER spawns or messages. |
| POST `/api/release` | `ReleaseReq` | `{agent}` |
| POST `/api/hooks/turn-end` | `TurnEndReq` | `TurnEndRes` |
| POST `/api/hooks/exit` | `ExitReq` | `{ok:true}` |
| POST `/api/hooks/session` | `SessionReq` | `{ok:true}` |
| GET `/api/events` | `?project=` | SSE stream of `ServerEvent` (+ `: ping` every 15 s) |
| GET `/*` | | static `web/dist` with SPA fallback (if built) |

UI requests have no identity header: allowed to read everything, create/patch cards (`created_by:'user'`). Nothing else.

Every state-changing `/api/*` request (D13) is refused (403) when `Sec-Fetch-Site` is `cross-site`/`same-site` or `Origin` is present and not `http://127.0.0.1|localhost|[::1]:<this server's port>`, and (415) when it has a body that is not `application/json` (`+json` allowed) — the one exception is the multipart `POST /api/skills/upload`. The CLI and hooks send no Origin and pass. Skills routes (`/api/skills*`) are listed in §12.9 and add stricter content-type rules (§12.2).

`team` is present only on `GET /api/inbox`; its item type is `TeamStatus` in `src/shared/types.ts`, with fields `{handle, resume, harness, state, call_started_at: number|null, last_update: string|null, last_update_at: number|null}`. No other endpoint adds `team`.

## 5. CLI — plain text output for models; `--json` prints the raw response

```
sparrow up [--port N] [--home DIR] [--max-running N] [--tmux] [--sandbox]   start the server (foreground; --tmux: in tmux session 'sparrow', window 'server'; --home must equal SPARROW_HOME and shows in `ps`; an agent window may only run up/stop with --sandbox and a non-default SPARROW_HOME)
sparrow sandbox up [--dir path] | down [--dir path]   throwaway server (D19) owning <dir>: `home` (SPARROW_HOME), `skills-home` (SPARROW_SKILLS_HOME, created; a value the caller already set wins), a free port (never 4040), its own tmux socket/prefix, and a `sbx` wrapper that pins them. The server env carries SPARROW_SKILLS_HOME, so the library, harness skill roots, staging and backups of the sandbox and of every agent it launches stay inside it: a sandbox can never touch the real ~/Skills or harness folders
sparrow install [--force]                          seed resumes, link ~/.local/bin/sparrow, install skills + harness assets
sparrow status                                     server health + working agents and their windows
sparrow whoami
sparrow resumes                                    the directory: slug, title, harness/model, can_hire, description
sparrow roster [--all]                             agents in my project: @handle, resume, harness, state, last update + age
sparrow hire <resume> "<task>" [--name h] [--cwd d] [--tmux-session s] [--tmux-window w] [--card N] [--model m] [--effort e]
sparrow send @<handle> "<text>" [--card N]
sparrow update "<text>" [--card N]
sparrow ask "<question>"
sparrow done "<summary>" [--status ok|blocked|failed]
sparrow wait ["<reason>"]
sparrow inbox [--wait SEC] [--last [N]]
sparrow log [@handle] [-n 30]
sparrow propose "<title>" [--details d] [--category c]
sparrow card list | add "<title>" [--details d] [--state s] [--assignee @h] | move <N> <state> | assign <N> <@h|none> | note <N> "<text>"
sparrow release <@handle>
sparrow hook <kind> [...]                          internal (harness hooks)
```
- Long text: any text argument may be `-` to read stdin, so agents can use a quoted heredoc: `sparrow done - <<'EOF' … EOF`.
- `sparrow hire` uses the resume's configured model and effort. Pass `--model` or `--effort` only for an explicit user request; a value that differs from the resume is shown as an `Override:` line in the CLI output, recorded in the task message's `meta.override`, and included in the server hire log.
- Every command prints its result, then, if `inbox` is non-empty, a block grouped by the agent the messages are about (sender, or `meta.about` for system notices), with messages in seq order and `hh:mm:ss` times. A group containing a result gets `── @handle · resume · done <status> · call <duration> ──` (duration comes from result `meta.call_ms`); a group containing only DMs, tasks, or questions gets `── @handle (DM) ──`; other groups get `── @handle · resume ──`:
  ```
  ━━ 📨 4 new messages for @james ━━
  ── @maya · builder · done ok · call 5m02s ──
    14:02:10  update  schema done; next API
    14:04:55  update  API done; tests next
    14:07:12  result (ok)
      ## Result
      API implementation and tests are complete.
  ── @iris (DM) ──
    14:06:00  question  Which port should the service use?
  ━━ Act on these before you finish. ━━
  ```
- Message lines are `  hh:mm:ss  <kind>  text`; chat messages display as `DM`. Results always print their text on lines indented by four spaces, and multi-line message text is indented by four spaces. Single-line updates, questions, tasks and DMs print inline. After the message block, `sparrow inbox` prints a team digest when it has entries (the caller's non-retired children whose state is not `idle`):
  ```
  Still working:
    @leo · builder-codex · working 12m · last update 8m ago: wiring the API
    @iris · verifier · working 3m · no update yet
  ```
  On timeout with no messages, it prints `No new messages (waited 600s).` followed by the digest; with no messages and no working children it prints only that first line. Calling `send` or `log` with the reserved `group` handle produces a usage error stating it was removed.
- In captain mode, `inbox --wait` uses messages piggybacked during registration. It skips the long-poll only when that inbox contains a waking message; this immediate path prints no `Still working:` digest. Quiet messages alone do not skip the wait. A newer `inbox --wait` stops an older pending wait without taking its messages. `inbox --last [N]` (N 1–50, default 10) prints previously delivered messages for recovery; it does not take pending deliveries.
- `done/ask/wait` with `ended:false` print (amended): `Not sent: new messages arrived (above). Handle them, then run sparrow done again with your complete report.` With `ended:true`: `Reported. This session will now close — stop here; you will be resumed with full memory when someone messages you.`
- Exit code 0 on success, 1 on API error (print the server's error text), 2 on bad usage (print usage for that command).

## 6. Harness launch

Installed: Claude Code 2.1.296 (`claude`), Codex 0.162.1 (call `/opt/homebrew/bin/codex` — the zsh `codex` function auto-updates), OpenCode 1.18.33 (`/Users/vermarjun/.opencode/bin/opencode`).

`start()` writes `~/.sparrow/agents/<agentId>/system.md`, `calls/<callId>.prompt.md`, `calls/<callId>.sh`, then `tmux new-window -d -P -F '#{window_id}' -t <session>: -n <window> -c <cwd> "bash <script>"` (creating the session with `new-session -d -s <session> -c <cwd>` if missing; honour `TMUX_SOCKET` with `-L`). The script: `cd <cwd>`; export/unset env (3.1); run the harness; then `sparrow hook exit --code $?`. Pass big texts as `"$(cat <file>)"`, never inline.

Starting points (verify; adjust; document deviations):
- **claude** new: `claude --dangerously-skip-permissions --session-id <uuid> -n <handle> [--model M] [--effort E] --append-system-prompt-file <system.md> --settings <settings.json with Stop hook → "sparrow hook claude-stop"> "$(cat prompt.md)"`; resume: same but `--resume <uuid>` instead of `--session-id`. Pre-accept the folder trust dialog if it appears (e.g. `~/.claude.json` `projects[<cwd>].hasTrustDialogAccepted`).
- **codex** new: `codex --yolo -C <cwd> [-m M] [-c model_reasoning_effort=E] <system prompt via developer_instructions — choose the robust way: -c, a generated profile, or a file key> -c 'notify=["<bin>","hook","codex-notify"]' -c 'projects."<cwd>".trust_level="trusted"' "$(cat prompt.md)"`; resume: `codex resume <thread_id> [same options] "$(cat prompt.md)"` (check where options go). Session id: notify payload `thread-id`, and/or env inside tool calls, and/or newest rollout in `~/.codex/sessions` with matching cwd (`discoverSession`).
- **opencode** new: `opencode <cwd> --auto [-m provider/model] --prompt "$(cat prompt.md)"` with the system prompt added via `OPENCODE_CONFIG_CONTENT` (`instructions: [<abs path to system.md>]`) or a generated agent; effort via variant if possible; resume: `-s <ses_id>`. Session id + idle signal from a global plugin (`installHarnessAssets` puts it in the OpenCode plugin dir) that is inert unless `SPARROW_AGENT_ID` is set and calls `sparrow hook opencode-idle …` / the HTTP API.
- **fake** (tests, no model): a Bun script run in the window that reads the prompt file and follows directives in it: `FAKE:update <t>`, `FAKE:done <t>`, `FAKE:ask <t>`, `FAKE:wait`, `FAKE:sleep <sec>`, `FAKE:crash <code>`, `FAKE:exit0`, `FAKE:idle` (simulate a turn end via `sparrow hook turn-end`), `FAKE:remember <word>` / `FAKE:recall` (persists per session id under the agent dir, so resume is testable). Default when no directive: update + done.
- `deliver(agent, text)`: tmux `load-buffer` + `paste-buffer -p` (bracketed) + Enter, with whatever delay/keys each TUI needs. Verify on each TUI that a pasted multi-line message is submitted as ONE message.
- `stop`: kill the window by id (idempotent). `isAlive`: window exists and `pane_dead == 0`. `capture`: `capture-pane -p -J -S -<lines>`.
- `runHook` kinds: `claude-stop` (stdin JSON → POST turn-end → print `{"decision":"block","reason":…}` when told to block), `codex-notify <json>`, `opencode-idle`/`opencode-session` (if the plugin shells out), `exit --code N`, `turn-end` (generic, used by fake). All are no-ops (exit 0, print nothing) when `SPARROW_AGENT_ID` is unset, so global installs never touch the user's own sessions.

Per-agent skills: each driver links exactly the agent's granted skills into a per-agent folder at every call start (Claude `--plugin-dir`, OpenCode `skills.paths` + `permission.skill`, Codex per-agent `CODEX_HOME`); see §12.5.

## 7. Prompts (`src/server/prompts.ts`, `assets/protocol.md`)

- System prompt = `assets/protocol.md` rendered + `\n\n# Your role\n\n` + resume body.
- A fresh hire receives its task in this envelope:
  ```
  [sparrow] 1 new message for @james (project plutus):

  ── task from @captain · 14:02 · card #3 ──
  <task text>

  Report with the sparrow CLI: `sparrow update` as you go, then `sparrow done` (or `sparrow ask` if blocked).
  ```
- An existing agent's envelope groups messages by the agent they are about (sender, or `meta.about` for system notices), preserving seq order inside each group. Each run of updates gets one `── updates from @handle ──` header followed by `hh:mm:ss  text` lines. Results, questions, tasks and notices each keep their own per-message header and full text:
  ```
  [sparrow] 4 new messages for @james (project plutus):

  ── updates from @maya ──
  14:02:10  schema done; next API
  14:04:55  API done; tests next
  ── result from @maya (ok) · 14:07 ──
  API implementation and tests are complete.
  ── question from @iris · 14:06 ──
  Which port should the service use?
  ```
  Quiet-only pending sets never start a call, so every envelope has at least one waking message. Kinds render with per-message headers as task / DM / question / result / system; updates use their run header.
- `NUDGE_REPORT`: "[sparrow] You stopped without reporting. Nobody reads this window. If you are finished run `sparrow done - <<'EOF' …` now; if you need something run `sparrow ask \"…\"`; if you are waiting on others run `sparrow wait \"…\"`."
- `NUDGE_QUIET`: "[sparrow] No progress update for N minutes. Post one line with `sparrow update \"did X; next Y\"`, then continue."
- `CRASH_RESUME`: "[sparrow] Your previous session ended unexpectedly (exit N). Continue your task from where you left off. Your last update was: «…»."

## 8. Resume format (`assets/resumes/<slug>.md`)

```markdown
---
name: builder
title: Builder
description: Implements one task end to end in the given folder, runs it, reports evidence.
harness: claude          # claude | codex | opencode | fake
model: opus              # optional (harness default when omitted)
effort: high             # optional
can_hire: []             # a non-helper slug in here ⇒ captain
skills: [write-like-a-human]  # optional; library skills this role gets (§12.5). Sparrow's two are always on
helper: true             # optional; a leaf assistant (never hires; hiring only helpers keeps you a worker)
one_shot: true           # optional; retired by the server as soon as it reports (§3.6)
limits: { quiet_minutes: 15, max_call_minutes: 90 }
---
<role prompt>
```
**Template variables.** `description` and the body may contain `{{harness}}` (claude|codex|opencode|fake, same as `{{harness}}` in the protocol), `{{model}}` (configured model, else `harness default`), `{{effort}}` (configured effort, else `default`) and `{{runtime}}` (`<harness> · <model> · effort <effort>`, the wording of the bracket in `sparrow resumes`). They are filled in whenever a resume is shown or used, never on disk: `renderResumeText` in `src/server/resumes.ts` (mirrored for the web in `web/src/lib/resumeVars.ts`). The agent's system prompt and the apply note render the body with the AGENT's actual harness/model/effort (so a `hire --model` override shows); `sparrow resumes` and the web Resumes list render the description with the resume's current settings; the web editor keeps the raw text. Unknown `{{x}}` is left as is. Seeded resumes use the variables instead of naming a model. The protocol header line also carries `model` and `effort`.

Eight resumes: `sub-captain` (claude, can_hire: [builder, builder-codex, verifier, researcher, presenter, deckhand, advisor]), `builder` (claude), `builder-codex` (codex), `verifier` (codex) — those three may hire [deckhand, advisor] — `researcher` (opencode, may hire [deckhand]), `presenter` (opencode), and two helpers: `deckhand` (claude · haiku · medium, `helper` + `one_shot`: mechanical lookups, test runs, exact-spec edits, conversion; bounces judgment calls as `NEEDS-JUDGMENT`) and `advisor` (claude · opus · medium, `helper`: read-only, answers ONE question with VERDICT GO/ADJUST/STOP + `path:line` evidence; follow-ups via `sparrow send`). Each user picks per resume in the web editor whether it may hire them. The `sparrow-worker` skill's **Helpers** section teaches when to hire which. Tests may add a `fake` resume in a temp `SPARROW_HOME`.

## 9. Web

React + Vite + TypeScript + Tailwind + shadcn/ui (+ dnd-kit for the board). Light theme, dense, calm. Three pages, project switcher in the header, live via `/api/events`:
- **Board**: columns Proposed · To do · In progress · Review · Done (Dropped collapsed). Card: #id, title, category chip, assignee @handle with state dot, notes count. Drag between/within columns → `PATCH /api/cards/:id {state, position}`. Only that. Card click → side sheet with details + notes.
- **Chat**: WhatsApp-like, with direct message threads only (for example, "@captain ↔ @james"), last message + time. Right: bubbles; kind styling — task (blue tag), update (small, muted, no bubble), question (amber), result (green with status), system (grey centered). @mentions highlighted. Read-only.
- **Agents**: hierarchy (captain → hires → their hires). Row: @handle, resume title, harness icon/label, model/effort, state badge (working pulses), cwd, tmux target with copy button (`tmux attach -t <session> \; select-window -t <window>`), session id (copy), last update + age, quiet warning. Click → sheet with live screen peek (poll `/screen` every 2 s while working) and recent calls (start, duration, end reason).
- **Settings** (global page, `#/settings`): every tunable grouped (Capacity, Call limits, Provider health, Timing) plus doctor models; number inputs with unit, default, `custom`/`env` chips, per-field reset, client-side range check, sticky Save/Discard bar. Saves apply live.
- **Resumes** editor: **Role type** switches (Helper, One-shot) and **Can hire** split into Helpers and Team chips; the list shows `helper` / `one-shot` badges.
- **Skills** (global page, `#/skills`, `#/skills/<name>`): Library (per-harness toggles, status chips, Sync, update chips), Agent matrix, Unmanaged / External (Adopt), Conflicts (diff, resolve), skill detail (rendered `SKILL.md`, files, git log), git bar (Pull, Commit & push), Add skill (Create / Upload / From link) and Migrate existing skills. See §12.
Dev: `bun run dev` with proxy `/api` → `http://127.0.0.1:4040`. Build to `web/dist`. The dev proxy rewrites `Origin` to the target so writes pass the same-origin check (D13).

## 10. Acceptance (verified with real Claude Code, Codex and OpenCode agents)

A1 `sparrow install` then `sparrow resumes` lists the 6 resumes.
A2 Captain hires a Claude builder, a Codex verifier and an OpenCode researcher with tiny tasks → 3 tmux windows running the real TUIs; each posts an update and `done`; results reach `sparrow inbox`; each window closes after done.
A3 Captain messages a closed agent → window reopens on the same session (resume) and the agent recalls a fact from its first call.
A4 An `update` wakes nobody and arrives bundled with the agent's result; `inbox --wait` timing out shows each working child's latest update.
A5 Kill an agent's window mid-work → auto-restarted once on the same session; kill again → the parent gets a crash notice with the last screen.
A6 An agent that ends its turn without reporting gets nudged (Claude: Stop hook block; Codex/OpenCode: typed reminder); still silent → parent gets an "unreported" notice with its last message and the window closes.
A7 Guards: a builder cannot hire; depth 3 is refused; with max_running=1 a second hire is `queued` and starts when the first finishes.
A8 A sub-captain hires a builder, runs `wait`, gets woken by the builder's `done`, then reports `done` to the human captain.
A9 Board: `propose` → Proposed; captain `card move` shows live in the UI; a UI drag changes only the card (no spawn, no message).
A10 `--cwd`, `--tmux-session`, `--tmux-window` are honoured, and the respawn reuses them.
A11 UI: Board, Chat and Agents render live data; the screen peek shows a working agent's TUI.


## 11. Amendments
- A1: `done/ask/wait` with pending waking deliveries record nothing (§3.6). CLI wording "Not sent: …" (§5).
- A2: `{{can_hire}}` renders as a full sentence: empty → "You may NOT hire anyone; never run `sparrow hire`." else → "You may hire these resumes, only via `sparrow hire`: a, b."
- A3: @mentions and handles are matched case-insensitively.
- A4: FYI system notices (restarting, quiet nudge) get quiet deliveries (`wake = 0`) and never wake the parent; only terminal notices wake it.
- A5: Quiet deliveries (`wake = 0`) remain pending but do not wake, spawn, resolve `inbox --wait` early, or block `done`/`ask`/`wait`. When any pending deliveries are handed over, quiet updates accompany waking messages in seq order. `GET /api/inbox` returns the caller's active-child digest so timeout output can show each child's latest update.

## 12. Skills

One git library of skills (default `~/Skills`, setting `skills_dir` in `<SPARROW_HOME>/config.json`), linked into
each harness's own skills folder, and a per-agent choice of skills at spawn. Managed only through the web UI
(**Skills** page), the HTTP API (§12.9) and a Doctor check; there is no skills CLI. Code: `src/skills/*`,
`src/server/skills-api.ts`, `src/server/skills-add-routes.ts`, `src/server/skills-migration.ts`,
`web/src/pages/Skills.tsx` + `web/src/components/skills/*`. Build evidence: branch `evidence/skills`.

### 12.1 Decisions
1. The library is a git repo with its own remote; Sparrow pushes only to that repo's `origin`.
2. A resume without `skills:` gets only Sparrow's two skills (`sparrow-worker`, `sparrow-captain`), which are always on
   and locked for every agent.
3. Everything the user installed that is not a harness default or Sparrow's own moves into the library on migration:
   `~/.claude/skills`, `~/.codex/skills`, the OpenCode folder, `~/.agents/skills` (`npx skills`, the AWS set),
   `~/Desktop/Skills`, and links to outside HOME (brew's `agent-browser`) or into other folders (the library keeps one
   copy; the link's content is copied and the link replaced). Harness defaults stay untouched: Claude's built-ins,
   Codex's `.system` and enabled plugins, OpenCode's `customize-opencode`; so do Sparrow's two skills and claude.ai's
   `~/.claude/skills/synced` (rewritten by claude.ai: it stays a read-only **External** entry with **Adopt**). Claude
   plugins are out of scope. After migration, **External** only holds what appears later (a new `npx skills` install, claude.ai).
4. Imports are built in (shallow `git clone`, `SKILL.md` discovery) and accept Vercel's `skills` source formats; lock
   fields use Vercel's names. Sparrow never reads or writes `~/.agents/.skill-lock.json`.

### 12.2 Paths and safety
- **Environment overrides.** `SPARROW_HOME` selects Sparrow's state directory; `SPARROW_PORT` its listener; `SPARROW_URL` the CLI server URL; `SPARROW_TMUX_SOCKET` and `SPARROW_TMUX_PREFIX` isolate tmux servers and session names; `SPARROW_SETTINGS` supplies settings JSON; `SPARROW_WEB_DIR` selects the UI build directory. For skills, `SPARROW_SKILLS_HOME` replaces HOME for skill paths and `SPARROW_SKILLS_DIR` selects the library. Without `SPARROW_SKILLS_HOME`, path resolution also honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME`.
- **One resolver.** `skillPaths()` (`src/skills/paths.ts`) computes every harness skills folder, the library, the External
  roots and the backup dir; no other module builds those paths. `SPARROW_SKILLS_HOME` replaces HOME for all of them (and
  then `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` are ignored); otherwise those three are honoured like the
  harnesses do. One exception by necessity: a spawned Codex reads the REAL `$HOME/.agents/skills` whatever the sandbox
  says, so `codexAgentsRoots()` adds it to the disable list (read only). Library: `SPARROW_SKILLS_DIR`, else `skills_dir`, else `<home>/Skills`. `sparrow install` uses it too.
- **Write fence.** Every write, link, move or delete of the library, the harness skill roots and `~/Desktop/Skills`
  (migration only) goes through `assertWritable(path)`, which allows only those, the backup dir and `SPARROW_HOME`
  (with `SPARROW_SKILLS_HOME` set, only inside it). Uploads and import previews are staged in `<SPARROW_HOME>/skills-staging`;
  a sandbox whose `SPARROW_HOME` lies outside `SPARROW_SKILLS_HOME` (every `sparrow sandbox` server; `sandbox up` sets `SPARROW_SKILLS_HOME=<dir>/skills-home` unless the caller already set one, and launch scripts pass it on to agent windows) keeps that folder and
  `skills-backup` in `<SPARROW_SKILLS_HOME>/.sparrow` instead, so upload and import work there. Per-agent launch folders under `<SPARROW_HOME>/agents/<id>/`
  (grant links, Codex home links) are written by the drivers directly; they never leave the agent dir.
- **Never destroy.** Link sync never deletes or overwrites a real folder or a link it doesn't own (a link into the
  library); it reports a conflict with a diff. Adopt and migration replace a real folder only after hash-checking the
  library copy and **move** the original to `<SPARROW_HOME>/skills-backup/<timestamp>-<id>/…`.
- **Imports are untrusted.** Nothing imported is ever executed (no hooks, filters, submodules, LFS; no scripts). Modes are
  preserved like Vercel's tool (Git 100755, ZIP Unix attributes, local folders); browser folder uploads carry no modes
  and stay non-executable. The preview lists every executable file, every `scripts/` file and every shebang file in an
  amber warning before import. Zip-slip, absolute paths, symlinks, device files, control characters and oversize uploads
  are rejected.
- Every skills write (`POST|PUT|PATCH|DELETE /api/skills*`) is covered by the global write guard (§4: cross-site,
  same-site and foreign `Origin`s → 403). On top, a skills write that sends a body (or a `Content-Type`) must be exactly
  `application/json`, and the upload must be `multipart/form-data` (415 otherwise).

### 12.3 Roots, readers and classification
| Root | Path | Read by |
|---|---|---|
| `library` | `<library>/<name>` | (through links) |
| `claude` | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills` | Claude, OpenCode |
| `codex` | `${CODEX_HOME:-~/.codex}/skills` (`.system/` = Codex built-ins, skipped) | Codex |
| `opencode` | `${XDG_CONFIG_HOME:-~/.config}/opencode/skills` | OpenCode |
| `agents` | `~/.agents/skills` | Codex, OpenCode (External until migrated) |
| `claude-synced` | `~/.claude/skills/synced` | Claude (External) |
| `sparrow` | `<repo>/assets/skills` | every agent (locked) |

Each entry found by the scan gets one status: `managed` (a library folder, or a link to `<library>/<name>`), `sparrow` (Sparrow's own
skills, incl. the copies `sparrow install` puts in harness roots), `external`, `unmanaged` (a real folder or a link
elsewhere in HOME with no library entry → Adopt), `conflict` (a library skill of that name exists and this entry isn't a
link to it; `identical` or with a diff) or `broken` (dangling link). Apart from dangling links, only folders holding a
`SKILL.md` are listed and hashed.

**Aliased harness folders.** When one harness folder is a symlink to another (e.g. `~/.codex/skills -> ~/.claude/skills`;
compared by real path, `harnessRootGroups()`), the two are one root: the first harness of the group (claude, codex, opencode)
owns the links, a link stays while ANY harness of the group wants the skill (turning one harness off never removes the other's
link), removal happens once, migration scans the folder once and folds the toggles of both, and Doctor and `GET /api/skills`
carry a warning (`rootAliasWarnings()`). `~/.agents/skills` aliasing a harness folder warns too.

### 12.4 Library manifest, lock fields, hashes
`<library>/skills.json`: `{version: 1, skills: {<name>: {harnesses: Harness[], source?: {...}}}}`. `source` uses Vercel's lock
entry names (`source`, `sourceType`, `sourceUrl`, `skillPath`, `skillFolderHash`, `installedAt`, `updatedAt`) plus Sparrow's
`installedHash` and `ref`. `skillFolderHash` keeps Vercel's meaning: the upstream Git tree SHA for Git sources (update
checks compare it), the content digest for local/upload sources. `installedHash` = `folderHash` of the library copy at
import. `folderHash` (Vercel's `computeSkillFolderHash`: sha256 over relative path + bytes, `localeCompare` order; skips
`.git`, `node_modules`, symlinks; file modes are NOT included) is the content check for adopt, conflicts, migration
plans and imports. The listings (`GET /api/skills`, which hashes every skill of every root) use a cached variant that walks
and lstats each folder every time but re-reads the bytes only when the folder's (path, size, inode, mtime, ctime in
nanoseconds) signature changed; every writer that verifies a copy hashes uncached; migration backups additionally carry a tar sha256, which rollback checks before restoring (the
per-file hash / kind / link-target comparisons are done by the dry-run driver and the tests, not at rollback time). Skill names follow the Agent Skills spec (`[a-z0-9]+(-[a-z0-9]+)*`, ≤ 64, = folder name for library skills; an import names the folder after the frontmatter `name`, §12.6); YAML writers quote names
that could parse as numbers or keywords.

### 12.5 Per-agent skills
- **Resume field:** `skills: [name, …]` in the frontmatter (§8). An absent field in a resume PUT means unchanged; `[]`
  clears. The Agent matrix toggle edits only the `skills:` line (comments and other bytes kept) through
  `POST /api/skills/matrix`, atomically.
- **Grant snapshot:** at hire and on "apply resume" the server resolves the names to `<library>/<name>` folders (real path
  must stay inside the real library) and stores them, with the requested names, in `<agentDir>/skills.json`. Each call
  start passes `StartSpec.skills` = that snapshot, re-checking the library boundary and `SKILL.md`; a requested skill
  that was missing at hire is granted once it is in the library. Resume edits wait for the next hire or Apply. Missing
  or invalid names never fail a hire; `sparrow hire` prints them as `Skills: …`.
- **Launch:** each driver links the grants (Sparrow's two included) into a per-agent folder rebuilt every call; stale
  links are removed and a real entry already in that folder is never touched: it stays visible to the harness and a
  grant of the same name is not linked (Codex keeps its own `.system` built-ins there by design; only Sparrow writes
  the Claude and OpenCode folders). OpenCode also leaves such a shadowed grant out of its allowlist:
  - Claude: `--plugin-dir <agentDir>/claude-plugin` (plugin `sparrow`; granted skills appear as `sparrow:<name>`), with
    `--setting-sources project,local`. That keeps bundled skills and cwd `.claude/skills`, while excluding user-scoped
    skills and synced account skills.
  - OpenCode keeps the inherited `XDG_CONFIG_HOME` so the user's `~/.config/opencode/opencode.json` and MCP servers
    remain available. `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` excludes global `.claude/skills` and `.agents/skills`;
    global `.config/opencode/skills` can still be discovered. Since that flag also hides project compatibility skills,
    `skills.paths` includes the per-agent grant folder and each project `.claude/skills` and `.agents/skills` directory
    from cwd through the Git root (or through filesystem root when cwd is outside a Git worktree, matching OpenCode's
    native walk). User home `.claude/skills` and `.agents/skills` remain excluded. OpenCode discovers project
    `.opencode/skills` in its normal cwd-to-root scan.
    `permission.skill = {"*": "deny", <frontmatter names>: "allow"}` filters the model-visible list, including
    ungranted XDG skills ("*" first; for all-digit names the deny moves to top-level rules). The same rules are
    also set top-level so subagents the `task` tool spawns (general, explore) get them too. The built-in
    `customize-opencode` remains allowed.
  - Codex: `CODEX_HOME=<agentDir>/codex-home` with `auth.json`, `config.toml`, `plugins/`, `AGENTS.md`,
    `AGENTS.override.md`, `.credentials.json`, `rules/`, `prompts/` symlinked to the real home when present (never
    copied; a real file Codex wrote there is kept), `skills/` holding the grants, and
    `-c skills.config=[{path=…, enabled=false}, …]` for every global `~/.agents/skills` entry. The linked `plugins/`
    cache plus live `config.toml` gives the agent exactly the plugin skills enabled by the user's config. Codex 0.163.0
    wrote its `tui.screen_reader_detection_done` setting through the `config.toml` symlink and kept it a symlink; the
    sandbox `codex mcp add` config writer also edited the target and kept the symlink. The user's latest config thus
    remains live on the next spawn. Its `.system` skills stay in the agent's own `skills/`,
    and project `.agents/skills` remains natively discoverable. Session discovery and resume use the agent's own
    `CODEX_HOME`. Codex agents hired before this feature can't resume their old session there; the fresh fallback
    (§3.8) applies once.
- A resume with no `skills:` list sees the same harness defaults and cwd project skills plus Sparrow's two; it gets no
  library skills. Expected view = harness defaults + Sparrow's two + granted skills (when listed) + cwd project skills.

### 12.6 Library operations
Toggle a skill per harness (manifest + links), Sync (recreate links from `skills.json`, e.g. after a fresh clone),
Adopt (Unmanaged: copy, hash-check, back up the original, link back; External: copy only), resolve conflicts (keep
library / keep this copy / identical → replace with link), and library git: status, log per skill, Pull (fast-forward
only), Commit & push (only the library repo's `origin`; first push sets the upstream). Network git runs async with a
60 s timeout and no prompts. Add flows: Create (starter `SKILL.md`), Upload (folder or one .zip, staged and validated),
From link (`owner/repo`, `owner/repo/sub/path`, Git URLs, `…/tree/<ref>/<path>`, `@skill` filter; `file://`, `ext::` and
`fd::` refused), with a preview of each skill's files and warnings before import, and an update check per Git source
(`POST /api/skills/updates`: it shallow-clones every source, so it is a guarded write, not a GET). **Import naming follows
Vercel's `skills` tool** (`sanitizeName` of the frontmatter `name`; the folder a skill sits in is irrelevant): the library
folder is the frontmatter name lowercased with runs of other characters turned into `-` (Sparrow's name rule is a bit
stricter than Vercel's: no `.`/`_`, ≤ 64). A skill whose folder differs from that name (5 of the 9 in
`vercel-labs/agent-skills`) imports fine and the preview shows a warning; `SKILL.md` is copied unchanged, and the library
listing does not flag the difference on imported skills. A name that cleans to nothing or to a reserved Sparrow name is
still refused. Two skills in one source that clean to the same name are both listed; the second carries a `name-collision` problem (not importable, so the user imports one or renames it); a byte-identical mirror of a skill (the same folder under `skills/` and `.claude/skills/`) is listed once with a notice. `@skill` matches the library name, the frontmatter name or the folder. Commit & push also pushes when
there is nothing to commit: a branch with no upstream counts the commits no remote branch has as unpushed (the push then
sets the upstream).

### 12.7 Migration (existing harness folders → library)
Run from Skills → **Migrate existing skills** (wizard) or the API; refused (409) while the library location is unsafe (§12.2).
**Scope: everything that is not a harness default or Sparrow's own moves into the library; the library is the single copy.**
- *Candidates* (a real folder or a link, with a `SKILL.md`): entries in the `claude`, `codex`, `opencode` roots, in
  `~/.agents/skills` (the `npx skills` AWS set, `terminal-browser`) and in `~/Desktop/Skills`. A link to anywhere (outside
  HOME such as brew's `agent-browser`, another folder, a tool's folder, `~/.agents/skills`) is a candidate: the target's content is
  copied into the library, the link is moved to the backup and replaced by a library link, and the original link target is noted in
  the backup manifest (`moved[].linkTarget`). The target itself is never touched.
- *Skipped and reported* (`skipped[].code`): Sparrow's skills (`sparrow`), Codex `.system` and claude.ai `synced/` (`container`),
  a link into `synced/` (`synced`) or `.system` (`builtin`), a link already pointing into the library (`in-library`: this is what
  makes a second run a no-op), a folder that is the same folder as an earlier source (`alias`), invalid names, and dangling links
  (`dangling`, reported, never touched). Protected variants (`synced/`, `.system/`) are listed read-only.
- *One library copy per name.* Copies with the same bytes (a Claude AWS folder and its `~/.agents/skills` twin) become one library
  skill: Claude no longer links to `~/.agents/skills`. **Differing copies are never resolved for the user:** the plan marks them
  `needsChoice`, the wizard shows them side by side with a diff, and the choice is copy A / copy B / keep as conflict, default keep
  as conflict (nothing copied, no copy touched). A library skill of that name with other bytes stops the apply before anything moves.
- *Toggles keep today's visibility* in `skills.json`: an entry in `~/.claude/skills` → claude + opencode (OpenCode reads that folder);
  in `~/.codex/skills` → codex; in the OpenCode folder → opencode; in `~/.agents/skills` → codex + opencode (both read it);
  `~/Desktop/Skills` → none. A skill found in several places gets the union of the copies that were actually moved, plus any toggles it
  already had. A harness folder that aliases another earns the toggles of both. Day one, the user's own sessions see the same
  skills as before; they trim in the UI.
- *Apply* requires `plan_id` (the server re-plans and refuses if any candidate's content hash or the planned decisions changed; mode-only or
  symlink-only changes are not detected because `folderHash` ignores them) and the typed word `migrate`. It writes a tar backup with
  sha256 first, re-hashes each source just before touching it (a folder whose content changed is skipped), copies and hash-checks the
  library copies, then per entry: records the intent (`inFlight`) in the backup manifest, moves the original to
  `<backup>/<root>/<name>`, records it (`moved`), and puts a library link where a harness-folder or Desktop/Skills original was
  (`~/.agents/skills` originals only move out: that folder is another tool's, written by migration alone). The toggles are then written
  to `skills.json` and linked through the normal link planner; links that could not be made are returned (`link_conflicts`). Harness
  folders that did not exist are recorded (`createdDirs`).
- *Rollback* (`rollback` typed; once per backup; the archive is checked against its sha256) restores **every** migrated entry from the
  archive: one that is gone now (its link was removed later) or whose move was interrupted (the rename happened, the record did not:
  `inFlight`) is restored too, one still present is moved aside first. Library links the migration did not create (toggled on later)
  are moved aside so nothing dangles, the current library goes aside inside the backup folder and the previous one is restored, and
  folders apply created are removed again when empty. The result is `restored` (each entry verified afterwards: kind, link target or
  folder hash) and `notRestored` (path + reason: not in the archive, outside HOME, its move never happened, verification failed),
  plus `libraryRestored`/`libraryNote`, `removedLinks`, `removedDirs`. Nothing is reported restored that was skipped.
- *Dry run:* `bun scripts/skills-migration-dryrun.ts` copies the user's real folders into `.sandbox/migration-home` (`SPARROW_SKILLS_HOME`),
  prints the plan summary, applies and rolls back on the copy, and proves with checksums that the real folders stayed untouched and
  the copy is byte-identical afterwards.

### 12.8 Doctor
The `skills` check fails first on a refused library location (§12.2), warns on aliased harness folders, and reports Sparrow's skills current in the harness roots, every managed skill linked where `skills.json`
says, conflicts and broken links (fail), library folders missing from `skills.json`, and the library repo state
(missing, dirty, unpushed; "no remote" is informational). Fix text points at the Skills page. The `sparrow on PATH` check
never recommends `sparrow install` on a sandbox server (it writes the real `~/.local/bin` and harness folders): it points
at this checkout's binary or the sandbox's `sbx` wrapper.

### 12.9 HTTP API
UI requests carry no identity (like the Resumes API). Errors are `{error}` with 400, 403 (cross-site), 404, 409, 415, or
500 for unexpected failures.
| Method & path | Body / query | Returns |
|---|---|---|
| GET `/api/skills` | | `SkillsState`: library (incl. locked Sparrow skills), unmanaged, external, conflicts, broken, git, paths, warnings, `library_missing`, `library_problem` |
| POST `/api/skills/library/init` | | `SkillsState` after creating the library (git init + `skills.json`); never done by a GET |
| GET `/api/skills/:name` | | skill, `SKILL.md`, file tree, git log, entries, problems |
| PUT `/api/skills/:name/harnesses` | `{harnesses}` | `{skill, actions, conflicts}`; 409 for locked skills |
| POST `/api/skills/sync` | | link actions + conflicts for every skill |
| POST `/api/skills/adopt` | `{path}` (must be a scanned entry) | `{skill, backup}` |
| POST `/api/skills/conflicts/resolve` | `{path, keep: 'library'\|'entry'}` | `{skill, backup}` |
| GET `/api/skills/:name/diff` | `?path=` | `{diff, truncated?}` (cut at 1 MiB) |
| GET `/api/skills/git` | | `GitState` |
| POST `/api/skills/git/pull` | | `GitState` + `output` (fast-forward only) |
| POST `/api/skills/git/commit` | `{message, push}` | `GitState` |
| POST `/api/skills` | `{name, description, harnesses}` | `{skill}` (Create) |
| POST `/api/skills/upload` | multipart: files with relative paths, or one `.zip` | `{staged: StagedImport}` |
| POST `/api/skills/import/preview` | `{source}` | `{staged: StagedImport}` (skills, files, executables/scripts) |
| POST `/api/skills/import` | `{staged_id, skills, harnesses}` | `{skills, actions, conflicts}` |
| POST `/api/skills/updates` | | `{name, current, latest, available, error?}[]` (POST behind the write guard: it shallow-clones every Git source; no body) |
| GET `/api/skills/matrix` | | `{resumes: [{slug, title, harness, skills, hired, stale}], skills, locked}` |
| POST `/api/skills/matrix` | `{slug, skill, on}` | `{resume}` (atomic `skills:` line edit) |
| POST `/api/skills/migration/plan` | | plan (`decisions`, `candidates`, `skipped[].code`, `warnings`) + `plan_id` + `backup_root` + `summary` (writes nothing; 409 for an unsafe library) |
| GET `/api/skills/migration/diff` | `?name=&a=&b=` | `{diff, truncated?}` of two planned copies |
| POST `/api/skills/migration/apply` | `{plan_id, choices: {name: path}, confirm: "migrate"}` | backup, applied, selected, skipped, kept_as_conflict, conflicts_left, link_conflicts |
| POST `/api/skills/migration/rollback` | `{backup_id, confirm: "rollback"}` | `{restored, notRestored: {path, reason}[], libraryRestored, libraryNote, addedSkills, preservedAt, removedLinks, removedDirs, backup_id}` |
| GET `/api/skills/migration/backups` | | `{id, path, created, size, sha256, members, moved, library_existed, rolled_back_at}[]` |

Every change to the library, the links, the manifest or a resume's `skills` emits the SSE event
`{type: 'skills.updated', project_id: '*'}` so open pages refresh. Staging (upload, import preview) and the migration
plan change nothing visible and emit nothing.

### 12.10 Seam changes (approved: additive, optional)
- `src/shared/types.ts`: `Resume.skills?: string[]`; `ResumeWriteReq.skills?: string[]`; `ServerEvent` gains
  `{ type: 'skills.updated'; project_id: '*' }`.
- `src/harness/index.ts`: `SkillGrant = { name: string; path: string }`; `StartSpec.skills?: SkillGrant[]`: the absolute
  folders a spawn may see, Sparrow's two included. `undefined` means Sparrow's skills only.
- Nothing else in the frozen files changed. Skills API types live in `src/skills/types.ts` (mirrored in `web/src/lib/skills.ts`).

### 12.11 Known gaps
- Source formats not supported: Vercel's well-known skill URLs, Azure Repos, self-hosted GitLab `/-/tree/`, GitHub archive
  ZIP URLs (cloned instead). Local-source lock entries keep `skillPath`; SSH sources are normalised to a repo path.
- For the user's own OpenCode sessions a skill toggled "Claude only" is still visible (OpenCode reads `~/.claude/skills`;
  shown as "via Claude"). Agents are isolated.
- After a keep-as-conflict migration the untouched copies are listed as Unmanaged until one is adopted.
- Codex plugins enabled in `config.toml` and Claude plugins are harness defaults/out of scope: Sparrow neither lists nor migrates them.
