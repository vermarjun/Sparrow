# Multi-captain: many captains per project, each with its own team

Status: design for review · branch `multi-captain` · worktree `../sparrow-captains`
Explainer of the bug: `docs/multi-captain-isolation.html` (open in a browser).
Contract: `src/shared/types.ts` (`Agent.fleet_id`, `Agent.captain`, `CaptainInfo`, `CaptainSummary`, `CaptainDetail`,
`CaptainResume`, `CaptainPatchReq`, `RegisterCaptainReq.{captain_id,adopt,name}`, `CaptainStartReq.{name,title}`,
`CaptainStartRes.agent_id`, setting `max_running_per_captain`). The contract is additive; no existing field changes meaning
except `Agent` gaining two required fields.

## 1. Problem

Today every human session in a project resolves to ONE row (`getAgentByHandle(project, 'captain')`, core.ts:347).
All hires of all sessions get that row as parent, so results, questions and updates from every team land in one
inbox; the first session to run any `sparrow` command takes them; `inbox --wait` from one session supersedes the other's
(core.ts:827). Any agent can DM any handle in the project; the human captain may release anyone.

Goal: the user runs one captain per feature or fix, up to ~100 per project at once, each hiring its own agents and
sub-agents (depth up to `max_depth`), with no crosstalk, and a UI where they can see each captain's feature, team,
status and results, and jump back into any captain.

## 2. Concepts

- **Captain** — a human-run harness session (Claude Code, Codex, OpenCode) that uses the `sparrow` CLI without
  `SPARROW_AGENT_ID`. One row per session: `kind: 'human'`, `depth 0`, `can_hire ['*']`, `parent_id null`.
- **Fleet** — a captain plus everyone hired under it, transitively. `fleet_id` = the captain's id. A hire inherits
  `fleet_id` from its parent; sub-captains are inside their hirer's fleet.
- **Fleet wall** — messages, releases and card assignments never cross fleets. The board stays one per project and
  shared (cards are tracking, the user sees all of them).
- **Captain identity** — found by, in order: `SPARROW_CAPTAIN_ID` (set by Sparrow when it launches a captain),
  the harness session id (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`/`CODEX_SESSION_ID`, `OPENCODE_SESSION_ID`),
  and finally "the only captain of this project".
- **Handle** — still unique per project (board, tmux window names, `@mentions` stay unambiguous). The first captain of
  a project is `@captain` (back compat); later ones get `cap-<star>` (`cap-orion`, `cap-vega`, … then `cap-<n>`) or the
  name the user picks (`--name`, UI). Captains can be renamed; agents keep their parent by id.
- **Title** — one line saying what the captain works on. Set by `sparrow title "…"`, `sparrow captain --title`, or the UI.
  Fallback shown in UI: the git branch, then the handle.

## 3. Flows

### 3.1 Captain in a terminal (bare `claude` in a worktree)
1. User: `cd ../plutus-feat1 && claude`. Claude Code sets `CLAUDE_CODE_SESSION_ID`.
2. The captain's first `sparrow …` → `POST /api/captains/register {cwd, harness:'claude', session_id}`.
3. Server: no human row with that session id in the project → create `@cap-orion` (or `@captain` if the project has
   none), `fleet_id = id`, `captain = {title:null, branch:<git branch>, harness:'claude', origin:'terminal'}`.
   `created: true` in the response; the CLI prints once: `You are @cap-orion (new captain). Name your work: sparrow title "…"`.
4. Every later command from the same session → same row (cwd, branch, last_seen refreshed; session id unchanged).
5. `sparrow title "Rate limiting for login"` → `PATCH /api/captains/<me> {title}`.

### 3.2 Captain launched by Sparrow (`sparrow captain` or the UI's New captain)
1. `POST /api/captain/start {cwd, name?, title?, model?, effort?}`.
2. Server creates the captain row FIRST (handle, title, `origin:'sparrow'`, `harness:'claude'`) with a fresh uuid as
   `session_id`, then launches the tmux window running `claude --session-id <uuid> --append-system-prompt-file captain.md`
   with `SPARROW_CAPTAIN_ID=<agent id>` exported. Records the window on the row (`tmux_session`, `tmux_window`,
   `tmux_window_id`). Returns `CaptainStartRes` + `agent_id`.
3. Because `SPARROW_CAPTAIN_ID` wins, this captain keeps its identity through `/clear` or anything that changes the
   session id.

### 3.3 Going back to a captain
- UI and `sparrow captains` show `CaptainResume`: `cwd`, `session_id`, `command` (exact line, per harness:
  claude `cd <cwd> && claude --resume <sid>`, codex `cd <cwd> && codex resume <sid>`, opencode `cd <cwd> && opencode -s <sid>`)
  and `attach` while a Sparrow-launched window is open.
- `POST /api/captains/:id/resume` (UI "Resume" button, `sparrow captain resume @cap-orion`): when its window is open →
  409 with the attach line in the error; else launch a tmux window in the captain's cwd running the resume command with
  `SPARROW_CAPTAIN_ID` exported; record the window; return `CaptainStartRes`. Claude only in v1 (codex/opencode → 400 with
  the manual command). If the captain was seen < 2 min ago and is `origin:'terminal'`, the UI warns "it may still be open
  in a terminal" before resuming (two processes on one session).

### 3.4 Re-attaching (the session id changed, e.g. `/clear` in a terminal captain)
- `sparrow captain adopt @cap-orion` → register with `adopt:'cap-orion'`: sets that row's `session_id` to the current
  session. If the current session already owns another row with no hires, that row's session id is cleared and it is
  archived; if it has hires → 409 (never merge fleets silently).

### 3.5 No session id (plain shell, scripts)
- 0 captains in the project → create `@captain`; exactly 1 non-archived → use it (today's behaviour); more than one →
  409 `N captains in <project>: @captain, @cap-orion… Run from the captain's own session, or set SPARROW_CAPTAIN_ID=<id|handle>.`

### 3.6 Hiring and messaging inside a fleet (unchanged rules, plus the wall)
- `hire`: `fleet_id = caller.fleet_id`. Default tmux session: `<prefix><project>` for the fleet whose root handle is
  `captain`, else `<prefix><project>-<root handle>`, so each fleet's windows group in their own tmux session.
- `send`: 403 when `target.fleet_id !== caller.fleet_id`:
  `@james is on @captain's team; @cap-orion can only message its own team (sparrow roster).`
- `release`: allowed for the parent, or the human captain whose fleet it is (was: any human captain).
- Cards: an identified caller may only assign cards to its own fleet (`assignee` outside → 403). UI (no caller) unchanged.
  Everything else on cards unchanged (the board is shared).
- `roster`, `whoami`, `team` digest, `rosterText` in errors: own fleet only.
- The UI and other unidentified callers (no `x-sparrow-agent`) still read everything.

### 3.7 Fair scheduling (100 captains on one Mac)
- New setting `max_running_per_captain` (0 = off, default 0; range 0–64). When > 0, a fleet with that many working
  agents queues further wakes even when `max_running` has room.
- `dequeue()` round-robins across fleets: repeatedly pick the fleet whose oldest queued agent is oldest among fleets
  that are under their cap, start that agent. Probes unaffected.

## 4. Data and migration (`src/server/db.ts`, SCHEMA_VERSION 5)

New `agents` columns: `fleet_id TEXT`, `title TEXT`, `branch TEXT`, `captain_harness TEXT`, `origin TEXT`,
`archived_at INTEGER`. `Agent.captain` is built from them for `kind='human'` rows (null otherwise).
Migration: human rows → `fleet_id = id`, `origin 'terminal'`, `captain_harness` 'claude' when `session_id` is a uuid else
'unknown'; other rows → `fleet_id` = root ancestor's id (walk `parent_id`; orphans → own id). Then
`CREATE UNIQUE INDEX agents_captain_session ON agents (project_id, session_id) WHERE kind='human' AND session_id IS NOT NULL`.
`UNIQUE(project_id, handle)` stays. Existing single `@captain` rows keep their (last written) session id; the session
that owns it continues; any other session becomes a new captain. Doctor project untouched.

## 5. API (all JSON; `src/server/captains.ts` + routes)

| Route | Body / query | Returns |
|---|---|---|
| POST `/api/captains/register` | `RegisterCaptainReq` | `RegisterCaptainRes` (+piggyback inbox) |
| GET `/api/captains` | `?project=` (required for UI; caller's project otherwise) `&archived=1` includes archived | `CaptainSummary[]`, newest `last_activity_at` first |
| GET `/api/captains/:id` | id or handle (+`?project=`) | `CaptainDetail` |
| PATCH `/api/captains/:id` | `CaptainPatchReq` | `{agent}`; caller-less (UI) or the captain itself; `name` validated like hire names; emits `agent.updated` |
| POST `/api/captains/:id/resume` | – | `CaptainStartRes` |
| POST `/api/captain/start` | `CaptainStartReq` (+`name`,`title`) | `CaptainStartRes` (+`agent_id`) |
| GET `/api/messages` | existing + `&fleet=<captain id>` | messages whose thread has a fleet member on either side |

Events: no new types. `agent.updated` carries `fleet_id`/`captain`; the UI refetches `/api/captains` (debounced ~400 ms)
on `agent.updated`, `message.created`, `call.*` for the current project.

## 6. CLI (`src/cli/main.ts`, `format.ts`)

```
sparrow captain [--cwd d] [--name n] [--title "…"] [--model m] [--effort e]   launch a new captain in tmux (via the server)
sparrow captain resume <@handle|id>        reopen a captain on its session (tmux)
sparrow captain adopt <@handle>            bind THIS session to an existing captain (after /clear)
sparrow captains [--all]                   this project's captains: handle, title, status, team counts, resume line; "(you)"
sparrow title "<what you work on>"         set your captain title (human captains)
sparrow whoami                             + captain handle, title, fleet, resume line
```
`identify()` sends `captain_id` from `SPARROW_CAPTAIN_ID`. On `created: true` print the one-time hint. Skill
(`assets/skills/sparrow-captain/SKILL.md`), `assets/captain.md` and `docs/DESIGN.md` updated: one captain per session,
start by `sparrow title`, your team is private, worktree guidance (captain may now live in the main checkout OR a worktree
inside it; both work and share the board).

## 7. UI — "Captains" (the main thing the user sees)

North star: open Sparrow, see every feature in flight as one calm list, click one, and understand in five seconds what
that captain is doing, who it hired, what came back, and how to get back into it. Inspired by ChatGPT's sidebar +
conversation and shadcn's quiet surfaces. Minimal, fast, beautiful; no box-in-box clutter.

### 7.1 Shell
- **Left sidebar** (260 px, collapsible `⌘B`, remembers state): Sparrow mark + project switcher (popover with search;
  each project shows captains/working counts). Primary button **New captain**. Search (`/`). Captain list grouped
  **Needs you** · **Working** · **Idle**, each row: captain avatar (letter on its own hue), title (fallback branch/handle),
  muted second line `@cap-orion · feat1`, right side a status glyph (pulsing green dot = working, amber dot = attention,
  unread count pill) and relative time. Selected row: soft bg + 2 px left bar in the captain hue. **Archived (n)**
  collapsed at the bottom. Footer: Board · Resumes · Skills · Doctor · Settings (icon + label, small), theme toggle,
  live/offline dot.
- **Routes** (hash): `#/captains` (project home, default), `#/captain/<id>[?tab=activity|team|cards][&agent=<id>]`,
  existing `#/board`, `#/resumes`, `#/skills`, `#/doctor`, `#/settings`; `?p=<project>` kept. Old `#/chat` and `#/agents`
  redirect to `#/captains`.
- **⌘K command palette**: jump to any captain or agent in the project, switch project, New captain, Resume / Archive
  the current captain, open Board.
- Captain hue: deterministic from the captain id, 10 tasteful OKLCH hues that work in light and dark.

### 7.2 Project home (`#/captains`)
- Heading: project name; one muted line `12 captains · 31 agents working · 4 need you`.
- Segmented filter: All · Working · Needs you · Idle · Archived (counts).
- One row per captain (no cards grid): avatar · title + `@handle · branch · ~/path` · **fleet strip** (one small
  rounded segment per hire coloured by state, working segments shimmer; >24 → `+n`) · status label · relative time.
  Second line: the last non-update message as a one-liner (`✓ @james  Rate limiting done, 14 tests green`).
  Hover: subtle bg + quick actions (Resume, Copy resume command, Archive). `j/k` move, `Enter` opens.
- Empty state: one sentence, **New captain** button, and the CLI line.

### 7.3 Captain page (`#/captain/<id>`)
- **Header**: avatar, title (click to edit inline, Enter saves, Esc cancels), `@handle` chip (rename in ⋯ menu),
  status pill. Right: **Resume** split button (primary: "Open in tmux" copies attach when the window is open, else
  "Resume" calls the API; menu: Copy resume command, Copy session id, Copy folder, Rename, Archive/Unarchive).
- **Meta line** (muted, icons): folder (`~/Desktop/plutus-feat1`), branch, harness, session `7f3a…` (click copies),
  `seen 2m ago` / `online`, origin.
- **Stats**: Agents · Working · Done · Failed · Unread (Unread > 0 shows "the captain hasn't read these yet").
- **Tabs**: Activity · Team · Cards (underline tabs).
- **Activity** (default): a centered conversation column (max-w ~ 760 px) of every message in the fleet, oldest →
  newest, grouped by day, auto-scroll to latest with a "Jump to latest" pill. Each message: sender avatar + `@james →
  @captain` + time; body as markdown. Kinds: **task** (a quiet card labelled Task, long briefs collapsed to 6 lines with
  Show more), **result** (left rail green/amber/red by status, status chip, call duration), **question** (amber rail,
  "waiting for @captain"), **update** (one muted line; hidden behind a "Show updates" toggle, on by default for the
  last 20), **system** (small, centered, grey). Filter row: Everyone + a chip per fleet agent (filters threads with that
  agent). Live via SSE.
- **Team**: the fleet as a tree with thin connector lines (captain → hires → their hires): avatar, `@handle`, resume
  title, harness icon, state badge (working pulse, queued, waiting, crashed, idle, retired faded), one-line last update,
  elapsed time on the open call, result chip. Click → **Agent sheet** (right side): header + state, attach/resume
  copy, live screen peek (poll `/screen` every 2 s while working), latest result (markdown), recent calls, its thread.
- **Cards**: compact rows of the fleet's cards (key, title, state, assignee); click opens the existing ticket sheet.
- Wide screens (≥ 1280 px): Activity gets a right rail with the compact Team list (working first) and the Session box
  (folder, branch, resume command, copy).

### 7.4 New captain dialog
Folder (combobox of recent roots + free text), "What is it working on?" (title, required), Name (optional, placeholder
the next `cap-<star>`), Advanced (model, effort; collapsed). Submit → `POST /api/captain/start` → navigate to the new
captain's page; toast with "Copy tmux attach".

### 7.5 Board
Board stays as built; add a **Captain** filter (cards whose assignee is in that captain's fleet) in its toolbar.

### 7.6 Visual language
shadcn zinc neutrals; Geist Sans / Geist Mono; 14 px UI text, 13 px secondary, page titles 20 px/600 tight. Hairline
borders, generous whitespace, almost no shadows (popovers only). Colour is information: state colours (green working,
amber attention, red failed/crashed, zinc idle) and captain hues only. Motion 120–180 ms ease-out, pulse for working,
respect `prefers-reduced-motion`. Light and dark are both first-class. Loading = skeletons, never spinners in content.
Every list keyboard navigable; every icon button has a tooltip and aria-label.

### 7.7 Out of scope (v1)
Sending messages to agents from the UI as the captain; captain↔captain links; cross-project captain views.

## 8. Tests (acceptance)

Server (`test/server/captains.test.ts`, sandboxed):
1. Two registers with different session ids → two rows, handles `captain` and `cap-…`, distinct `fleet_id`.
2. Same session id again → same row; cwd/branch refresh; session id unchanged.
3. A's hire `done` → only A's `takeInbox`; B's inbox empty; B's `inbox --wait` does not supersede A's.
4. B and B's hire `send @A-hire` → 403; B `release @A-hire` → 403; A releases its grandchild → ok.
5. Sub-captain hired by A: its hires have A's `fleet_id`; its results go to the sub-captain.
6. No session id: 1 captain → reused; 2 captains → 409 naming both; `captain_id` handle and id both work.
7. `adopt`: moves the session; empty previous row archived; previous row with hires → 409.
8. Migration from a v4 db fixture: fleets backfilled, unique index present.
9. `/api/captains` summary: status working/attention/idle/archived, counts, unread, last_message, resume command per harness.
10. PATCH title/name/archived; name validation; emits agent.updated.
11. `/api/captain/start` creates the row before launch and the launch script exports `SPARROW_CAPTAIN_ID` and uses
    `--session-id`; `/resume` builds `claude --resume <sid>`; 409 when the window is open (injected launcher).
12. `max_running_per_captain`: fleet A capped, fleet B still starts; round-robin dequeue order.
13. Scale: 100 captains × 3 fake hires each finish; every result reaches exactly its own captain.
CLI (`test/cli/captains.test.ts`): `captains`, `title`, `captain adopt`, `whoami`, `SPARROW_CAPTAIN_ID` passthrough,
created hint. Web: pure-logic tests (status/sort/group, fleet tree, activity grouping/filter), `tsc -b`, `vite build`,
mock-server screenshots light + dark at 1440 and 390 px.

## 9. Amendments after advisor review (@ivan, VERDICT ADJUST) — these override earlier sections

A1. **Contract** (commit f54c38b): `Settings.max_running_per_captain` (default 0) in `src/shared/config.ts`;
    `RegisterCaptainReq.pid`; `Agent.call_started_at` (read paths: `/api/agents`, `CaptainDetail.agents`).
    `/api/projects` rows gain `captains` (non-archived, non-phantom count; the web's `ProjectRow` type adds it).
    `/api/messages` gains `before=<seq>` (newest-first paging for the Activity feed: `before` + `limit` returns the
    `limit` messages just older than `before`, in seq order).
A2. **Worktrees belong to their repo's project.** `gitRoot` (core.ts:64) maps a linked worktree to
    `dirname(git rev-parse --path-format=absolute --git-common-dir)` (the main checkout), so `cd ../plutus-feat1 && claude`
    is a captain of project `plutus` and shares its board. Registered project roots still win (`projectRootFor`), so the
    existing `sparrow-board` project does not move. Skill/docs say: run each captain in its own worktree, anywhere.
A3. **`/clear` changes `CLAUDE_CODE_SESSION_ID`** (verified in claude 2.1.304) but not `CLAUDE_PID`. New column
    `captain_pid`. Register: session id unknown + `pid` equals a human row's `captain_pid` in this project seen in the
    last 24 h → re-attach: update that row's `session_id` (auto-adopt). When `captain_id` matches, also refresh the row's
    `session_id` to the sent one, so Resume reopens the current conversation. CLI sends `pid` from `CLAUDE_PID`.
A4. **Project-only commands never create or require a captain.** `sparrow captains`, `sparrow captain resume`, and
    `sparrow card …`, when register answers 409 (ambiguous plain shell), fall back to an unidentified call with the project
    from `GET /api/projects/resolve?cwd=<dir>` → `Project` (no row created). Other commands keep the 409.
A5. **Wall gaps closed.** For an identified caller: `hire --card` and card `assignee` must not take a card assigned to
    another fleet; `PATCH /api/cards/:id` state/assignee changes on a card whose assignee is in another fleet → 403 (notes
    stay allowed); release per §3.6; `RESERVED` also rejects any hire name starting `cap-`; `wake()` checks the per-fleet
    cap, not only `dequeue()`.
A6. **Phantom captains.** Background sessions and nested `claude -p` get their own session id. `GET /api/captains` and
    `sparrow captains` hide captains with no hires, no title and `origin 'terminal'` unless `?all=1` / `--all`.
A7. **Concurrency + shared DB.** `registerCaptain` stays fully synchronous (branch via spawnSync); catch the unique-index
    error and re-read. The fleet backfill is idempotent (`WHERE fleet_id IS NULL`) and runs on every open, because the
    :4040 server from `main` may insert rows with NULL `fleet_id` into the same DB; read paths treat NULL as "compute
    from the parent chain". Back up `~/.sparrow` DB before the first v5 open.
A8. **Ownership additions.** Server builder also owns `src/harness/launch.ts` (add `SPARROW_CAPTAIN_ID` to UNSET_VARS),
    `test/preload-guard.ts` (IDENTITY_VARS), `test/harness/real*.test.ts`, `test/cli/claude-isolation.real.test.ts`
    compile fixes. The CLI switches `sparrow captain` to `POST /api/captain/start` (main.ts:288 stops importing
    `launchCaptain`). OpenCode terminal captains have no session id → §3.5 rules (documented).
A9. **Cost at 100 captains.** `/api/captains` computes summaries in a few grouped queries (no per-captain N+1); the UI
    debounces refetches (≥ 400 ms) and patches rows from `agent.updated` between fetches.
