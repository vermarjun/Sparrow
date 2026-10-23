---
name: sparrow-captain
description: "Run a team of AI agents with Sparrow from your own session (you are the captain). Use when the user asks to hire, delegate to, or coordinate agents / builders / verifiers / researchers, or explicitly names Sparrow. Not for sessions where SPARROW_AGENT_ID is set (those are workers: use sparrow-worker)."
---

# Sparrow captain

Sparrow is a local server that spawns named agents (Claude Code, Codex, OpenCode) as real TUIs in tmux windows. You hire them from **resumes**, they report back through the `sparrow` CLI, and their results land in your **inbox**. You are the human's captain: plan, delegate, review, integrate. Your own session is never spawned; with no `SPARROW_AGENT_ID` set, the CLI registers this session as a captain of the project (the git root of your cwd).

**One captain per session.** Many captains can work in one project at once (one per feature or fix); each has its own team. Your first captain in a project is `@captain`, later ones are `@cap-orion`, `@cap-vega`, … The first `sparrow` command of a new session prints `You are @cap-… , a new captain in <project>`.

## 1. Make sure the server runs
```bash
sparrow status            # "Sparrow server: up …" or "not running"
```
If the server is down, tell the user and stop. Never start it unprompted. The user starts Sparrow explicitly by running `sparrow`.

## 1b. Name your work, find your way back
- **Start every job with `sparrow title "<what you work on>"`** (one line: "Rate limiting for login"). The user sees it in the UI and in `sparrow captains`, so it is how they tell your feature from the others.
- **Your team is private.** `sparrow roster` lists only you and your hires; you cannot message, release or assign cards to another captain's agents (403). Results, questions and updates from your hires reach only you. The board is shared by every captain of the project.
- `sparrow captains [--all]` lists this project's captains: handle (you), title, status, team working/total, last activity, and the exact line to reopen each.
- `sparrow whoami` shows your handle, title, fleet and resume line.
- **Getting back in:** the user reopens a captain with its resume line (`cd <dir> && claude --resume <session>`), or `sparrow captain resume @cap-orion` (opens it in tmux).
- **After `/clear`** Claude Code gives the same process a new session id. Sparrow re-attaches by the process id (`CLAUDE_PID`), so you normally stay the same captain with your team. If a command instead prints `You are @cap-…, a new captain`, run `sparrow captain adopt @<your handle>` to take your old identity back. Captains launched by `sparrow captain` keep their identity through `/clear` too.
- Codex and OpenCode terminal sessions: Codex has a session id; an OpenCode terminal captain has none, so it is "the project's only captain" while it is alone and gets a 409 naming the captains once there are several (set `SPARROW_CAPTAIN_ID=<id|handle>`).
- `sparrow captains` hides untitled, team-less terminal sessions (background or nested `claude -p` runs); `--all` shows them and archived captains.
- The user (not you) launches captains: `sparrow captain [--cwd d] [--name n] [--title "…"]`.

## 2. Pick the right resume
```bash
sparrow resumes           # slug, title, harness/model/effort, status, can_hire, description
sparrow roster            # who is already on the team, their state and last update
```
Never hire a resume marked UNUSABLE. Fix the reported problem and run doctor again. Default picks: `builder` (Claude) or `builder-codex` (Codex) to implement; `verifier` to check work adversarially; `researcher` for web + code research; `presenter` for an HTML explainer/deck; `sub-captain` to own a whole slice and hire its own builders.

## 3. Hire with a real brief
```bash
sparrow hire builder - --name maya --card 4 <<'EOF'
Goal: add rate limiting to POST /api/login (5 tries / 15 min per IP).
Context: server is src/server/api.ts (Hono); tests in test/server/.
Acceptance: `bun test test/server/` green incl. a new test for the 6th attempt → 429.
Constraints: no new dependencies; don't touch src/shared/.
Report: sparrow update at milestones; sparrow done with Result/Evidence/Files/Next.
EOF
```
A good brief = goal, files/context, acceptance checks (commands that prove it), constraints, how to report. One task per hire. `--name` is optional (friendly names are auto-picked).

Flags:
- `--cwd <dir>` — where the agent works (default: your cwd). Need isolation? Only when the user asks, create a git worktree yourself (`git worktree add ../proj-maya -b maya/rate-limit`) and pass `--cwd ../proj-maya`.
  - **Worktrees belong to their repo's project.** The project is the repo's main checkout, found from the directory you run `sparrow` in: a linked git worktree, anywhere on disk, resolves to the same project, shares its board, and gets its own tmux session. Run **one captain per worktree** (one per feature); each has its own team and inbox. `--cwd` only sets where a hired agent works; it never changes the project. A directory outside any git repo is a project of its own.
- `--tmux-session <s>` / `--tmux-window <w>` — where its window opens (default `sparrow-<project>` / the handle). Respawns reuse them.
- `--model`, `--effort` — don't. Hire the resume as is; its model and effort are the user's choice (set in the UI). Pass them only when the user explicitly asks for a specific model or effort.
- `--card N` — assign a board card (moves it to In progress).

Hiring returns at once. Max concurrent agents is limited; extra hires show `queued` and start when a slot frees.

## 4. Wait for results WITHOUT blocking the user
- **In Claude Code:** run `sparrow inbox --wait 600` with the Bash tool and `run_in_background: true`. You get notified when it finishes (a message arrived, or 10 min passed). Read it, act, then **re-arm** the same background command. Keep talking to the user meanwhile.
- Run only one `inbox --wait` at a time; a newer one stops the older. Think you missed a result? `sparrow inbox --last`.
- **Inside an agent window** (a sub-captain, `SPARROW_AGENT_ID` set): never `inbox --wait`; run `sparrow wait "…"` and stop — results resume you.
- **Elsewhere:** check `sparrow inbox` between other work, or after each user turn.
- Every sparrow command you run also prints new messages (`━━ 📨 …`).

Agent progress updates are quiet DMs to that agent's parent. The parent receives them bundled with
the agent's result or another waking message; they never wake or interrupt the parent on their own.
If `sparrow inbox --wait` times out, its `Still working:` digest lists each active child and its
latest update (or says `no update yet`).

Message kinds you will see: `update` (arrives bundled before that agent's result, or in the timeout digest), `result: ok|blocked|failed` (an agent ran `done`), `question` (it ran `ask` and is paused), `system` (crash / stopped without reporting / running very long — includes its last screen).

## 5. Respond
```bash
sparrow send @maya "Use Redis, not memory; REDIS_URL is in .env"   # answers a question / gives more work
sparrow log @maya -n 20                                           # what it said and received
```
Messaging an agent whose window closed respawns it **on the same session** — it remembers everything. Crashed agents restart automatically once; after that you get a crash notice and one message from you resumes it.
Communication uses direct messages; `group` is a reserved handle and cannot be used with `send` or `log`. You can only message your own team; other captains' agents answer 403.

Verify before you trust: for important results, hire a `verifier` with the builder's evidence and acceptance checks.

## 6. Board (tracking only, never spawns anything)
Every card has a key (`TOR-12`); all commands also take `12` or `#12`. Agents `propose` tickets (column Proposed, written per the worker skill); you accept (`move N todo`) or drop them.
```bash
sparrow card list [--state s] [--sort roi|urgent|estimate|newest|…] [--urgent] [--blocked] [--all]   # --all adds dropped
sparrow card show TOR-12                  # full ticket: context, problem, approach, checks, comments, timing
sparrow card pick TOR-12                  # you take it: assigns you, moves to In progress, prints the brief
sparrow card add "Rate limiting on login" --context "…" --problem "Observed … Expected …" --approach "…" \
    --check "6th attempt returns 429" --impact high --effort low --estimate 2h --state todo
sparrow card edit TOR-12 --urgent on --impact high --effort low --estimate 2h --category auth   # markers; "none"/off clears
sparrow card move TOR-12 review           # proposed|todo|in_progress|review|done|dropped
sparrow card assign TOR-12 @maya          # or me, or none
sparrow card block TOR-12 "IT: NetSuite access"   # waiting on a person; sparrow card unblock TOR-12
sparrow card later TOR-12 [--undo]        # shelve under Later (icebox); urgent TOR-12 [--undo]; check TOR-12 2 [--undo]
sparrow card note TOR-12 "merged in a1b2c3"        # a comment (alias: comment)
```
- User says "pick TOR-12": run `sparrow card pick TOR-12`, read the brief it prints, do the work, and satisfy every "Done when" check (`card check`).
- Build finished: `sparrow card move TOR-12 review`. **Never move a card to done** unless the user told you they reviewed and accepted it; the user approves from the board.
- `hire … --card TOR-12` assigns the card, moves it to In progress and appends the whole ticket to the agent's first prompt. When that agent reports `done` (ok) its card moves to Review by itself; `blocked` or `failed` leaves it where it is and adds a timeline event.
- Every move is timestamped (the user can drag cards back and forth), so the card keeps its history and a timing summary: estimate against time actually worked. Be honest with `--estimate`.
- Cards you write follow the same ticket rules as agents' (outcome title, plain-English approach with no code, 2-7 binary checks, always impact, effort and estimate).

**What the board shows for each field** (write for this; the card face is deliberately sparse):
| Field (flag) | Where the user sees it |
|---|---|
| title | The card's only big line, clamped to 2 lines: <= 70 chars, outcome first. |
| `--category` | Coloured dot + word on the card. One primary bucket, lowercase. |
| `--impact` × `--effort` | One payoff word on the card: **Quick win** (effort low, impact medium/high), **Worth it** (high/medium), **Big bet** (high/high), **Heavy lift** (medium/high), **Money pit** (low/high). Medium/medium, low/low, low/medium and unset show nothing. Drives sorting and triage, so always set both. |
| `--urgent` | Solid red rail on the card's left edge; an "urgent" filter in the title line. Only if it blocks someone now. |
| `--blocked "<who/what>"` | Orange striped rail; the text shows only in the hover peek, the tooltip and the sheet's banner, so keep it short ("IT: NetSuite access"). |
| `card later` | Card moves under the column's dashed "Later" line, muted. |
| `--context` `--problem` `--approach` `--check` | Ticket sheet sections in that order; the hover peek previews `--problem` (else context). Checks are tickable boxes. |
| `--estimate` | Peek and sheet; at Review/Done the sheet compares it with build time (In progress), review shown beside it. |
| `--tag`, `--details` | Sheet only (never on the card). Details = "More details", for anything that fits no section. |
| comments (`card note`) | Sheet activity; also handed to any agent hired with `--card`. |
| proposer, date, moves | Automatic: age on the card, full date in the peek, timing and history in the sheet. |
The user triages Proposed newest-first with the keyboard (`t` = Triage mode: accept, later, drop, urgent, return/effort), so a ticket with no impact/effort or an unclear problem is the one that gets dropped.

## 7. Release when the job is done (permanent by design)
```bash
sparrow release @maya               # closes its window for good; it never wakes again
```
- An agent is hired for one job. Until you release it, it keeps its session id (its "number"): message it any time, even days later, and it resumes with full memory. Use that for follow-ups on the same job.
- Release is permanent on purpose. Once the job is verified and merged, release the agent. New work goes to a fresh hire, so no agent carries stale context from an old job.
- Order: build → verify → merge → release. Never release a builder before its verifier passes; a released agent can't take the fix.

## Watch
- Agent windows: `tmux attach -t sparrow-<project>` for `@captain`'s team, `sparrow-<project>-<captain handle>` for any other captain's (each agent is a window named after its handle). `sparrow status` prints exact attach lines.
- Web UI (captains, board, live screen peek): use the URL printed by `sparrow status`.

## Rules of thumb
- Delegate whole, checkable tasks; keep integration and final judgment yourself.
- Don't hire for things you can do in one minute.
- Don't run the harness CLIs yourself to create agents; always `sparrow hire`.
- Tell the user what you hired, why, and how to watch it.
