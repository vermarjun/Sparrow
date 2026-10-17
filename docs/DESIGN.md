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
| **Captain** | the user's own session (`kind: human`, depth 0, never spawned) — or an agent whose resume has a non-empty `can_hire` (a sub-captain). |
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
2. `depth = caller.depth + 1`; refuse when `> max_depth` (403, say why).
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
`max_running` counts agents in state `working` across all projects (human captains excluded). `loadSettings()` gives all tunables.

## 4. HTTP API (JSON, 127.0.0.1 only, no auth)

Identity header `x-sparrow-agent`; hooks add `x-sparrow-call`. Every response to an identified agent includes `inbox` (piggyback, 3.3). Types are in `src/shared/types.ts`.

| Method & path | Body / query | Returns |
|---|---|---|
| GET `/api/health` | | `{ok:true, version, pid, started_at}` |
| POST `/api/captains/register` | `RegisterCaptainReq` | `RegisterCaptainRes` |
| GET `/api/whoami` | | `{agent, project, parent: Agent\|null}` + inbox |
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
| GET `/api/inbox` | `?wait=<sec ≤600>` | `{inbox, team: TeamStatus[]}` — long-polls until ≥1 waking pending delivery or timeout; `team` lists the caller's non-retired children whose state is not `idle` |
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

`team` is present only on `GET /api/inbox`; its item type is `TeamStatus` in `src/shared/types.ts`, with fields `{handle, resume, harness, state, call_started_at: number|null, last_update: string|null, last_update_at: number|null}`. No other endpoint adds `team`.

## 5. CLI — plain text output for models; `--json` prints the raw response

```
sparrow up [--port N] [--max-running N] [--tmux]   start the server (foreground; --tmux: in tmux session 'sparrow', window 'server')
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
sparrow inbox [--wait SEC]
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
- In captain mode, `inbox --wait` uses messages piggybacked during registration. It skips the long-poll only when that inbox contains a waking message; this immediate path prints no `Still working:` digest. Quiet messages alone do not skip the wait.
- `done/ask/wait` with `ended:false` print (amended): `Not sent: new messages arrived (above). Handle them, then run sparrow done again with your complete report.` With `ended:true`: `Reported. This session will now close — stop here; you will be resumed with full memory when someone messages you.`
- Exit code 0 on success, 1 on API error (print the server's error text), 2 on bad usage (print usage for that command).

## 6. Harness launch

Installed: Claude Code 2.1.296 (`claude`), Codex 0.162.1 (call `/opt/homebrew/bin/codex` — the zsh `codex` function auto-updates), OpenCode 1.18.33 (`/Users/vermarjun/.opencode/bin/opencode`).

`start()` writes `~/.sparrow/agents/<agentId>/system.md`, `calls/<callId>.prompt.md`, `calls/<callId>.sh`, then `tmux new-window -d -P -F '#{window_id}' -t <session>: -n <window> -c <cwd> "bash <script>"` (creating the session with `new-session -d -s <session> -c <cwd>` if missing; honour `TMUX_SOCKET` with `-L`). The script: `cd <cwd>`; export/unset env (3.1); run the harness; then `sparrow hook exit --code $?`. Pass big texts as `"$(cat <file>)"`, never inline.

Starting points (verify; adjust; document deviations):
- **claude** new: `claude --dangerously-skip-permissions --session-id <uuid> -n <handle> [--model M] [--effort E] --append-system-prompt "$(cat system.md)" --settings <settings.json with Stop hook → "sparrow hook claude-stop"> "$(cat prompt.md)"`; resume: same but `--resume <uuid>` instead of `--session-id`. Pre-accept the folder trust dialog if it appears (e.g. `~/.claude.json` `projects[<cwd>].hasTrustDialogAccepted`).
- **codex** new: `codex --yolo -C <cwd> [-m M] [-c model_reasoning_effort=E] <system prompt via developer_instructions — choose the robust way: -c, a generated profile, or a file key> -c 'notify=["<bin>","hook","codex-notify"]' -c 'projects."<cwd>".trust_level="trusted"' "$(cat prompt.md)"`; resume: `codex resume <thread_id> [same options] "$(cat prompt.md)"` (check where options go). Session id: notify payload `thread-id`, and/or env inside tool calls, and/or newest rollout in `~/.codex/sessions` with matching cwd (`discoverSession`).
- **opencode** new: `opencode <cwd> --auto [-m provider/model] --prompt "$(cat prompt.md)"` with the system prompt added via `OPENCODE_CONFIG_CONTENT` (`instructions: [<abs path to system.md>]`) or a generated agent; effort via variant if possible; resume: `-s <ses_id>`. Session id + idle signal from a global plugin (`installHarnessAssets` puts it in the OpenCode plugin dir) that is inert unless `SPARROW_AGENT_ID` is set and calls `sparrow hook opencode-idle …` / the HTTP API.
- **fake** (tests, no model): a Bun script run in the window that reads the prompt file and follows directives in it: `FAKE:update <t>`, `FAKE:done <t>`, `FAKE:ask <t>`, `FAKE:wait`, `FAKE:sleep <sec>`, `FAKE:crash <code>`, `FAKE:exit0`, `FAKE:idle` (simulate a turn end via `sparrow hook turn-end`), `FAKE:remember <word>` / `FAKE:recall` (persists per session id under the agent dir, so resume is testable). Default when no directive: update + done.
- `deliver(agent, text)`: tmux `load-buffer` + `paste-buffer -p` (bracketed) + Enter, with whatever delay/keys each TUI needs. Verify on each TUI that a pasted multi-line message is submitted as ONE message.
- `stop`: kill the window by id (idempotent). `isAlive`: window exists and `pane_dead == 0`. `capture`: `capture-pane -p -J -S -<lines>`.
- `runHook` kinds: `claude-stop` (stdin JSON → POST turn-end → print `{"decision":"block","reason":…}` when told to block), `codex-notify <json>`, `opencode-idle`/`opencode-session` (if the plugin shells out), `exit --code N`, `turn-end` (generic, used by fake). All are no-ops (exit 0, print nothing) when `SPARROW_AGENT_ID` is unset, so global installs never touch the user's own sessions.

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
can_hire: []             # non-empty ⇒ captain
limits: { quiet_minutes: 15, max_call_minutes: 90 }
---
<role prompt>
```
Six resumes: `sub-captain` (claude, can_hire: [builder, builder-codex, verifier, researcher, presenter]), `builder` (claude), `builder-codex` (codex), `verifier` (codex), `researcher` (opencode), `presenter` (opencode). Tests may add a `fake` resume in a temp `SPARROW_HOME`.

## 9. Web

React + Vite + TypeScript + Tailwind + shadcn/ui (+ dnd-kit for the board). Light theme, dense, calm. Three pages, project switcher in the header, live via `/api/events`:
- **Board**: columns Proposed · To do · In progress · Review · Done (Dropped collapsed). Card: #id, title, category chip, assignee @handle with state dot, notes count. Drag between/within columns → `PATCH /api/cards/:id {state, position}`. Only that. Card click → side sheet with details + notes.
- **Chat**: WhatsApp-like, with direct message threads only (for example, "@captain ↔ @james"), last message + time. Right: bubbles; kind styling — task (blue tag), update (small, muted, no bubble), question (amber), result (green with status), system (grey centered). @mentions highlighted. Read-only.
- **Agents**: hierarchy (captain → hires → their hires). Row: @handle, resume title, harness icon/label, model/effort, state badge (working pulses), cwd, tmux target with copy button (`tmux attach -t <session> \; select-window -t <window>`), session id (copy), last update + age, quiet warning. Click → sheet with live screen peek (poll `/screen` every 2 s while working) and recent calls (start, duration, end reason).
Dev: `bun run dev` with proxy `/api` → `http://127.0.0.1:4040`. Build to `web/dist`.

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
