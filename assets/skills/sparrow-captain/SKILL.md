---
name: sparrow-captain
description: Run a team of AI agents with Sparrow from your own session (you are the captain). Use when the user asks to hire, delegate to, or coordinate agents / builders / verifiers / researchers, or explicitly names Sparrow. Not for sessions where SPARROW_AGENT_ID is set (those are workers: use sparrow-worker).
---

# Sparrow captain

Sparrow is a local server that spawns named agents (Claude Code, Codex, OpenCode) as real TUIs in tmux windows. You hire them from **resumes**, they report back through the `sparrow` CLI, and their results land in your **inbox**. You are the human's captain: plan, delegate, review, integrate. Your own session is never spawned; with no `SPARROW_AGENT_ID` set, the CLI registers you as `@captain` of the project (the git root of your cwd).

## 1. Make sure the server runs
```bash
sparrow status            # "Sparrow server: up …" or "not running"
```
If the server is down, tell the user and stop. Never start it unprompted. The user starts Sparrow explicitly by running `sparrow`.

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
- `--tmux-session <s>` / `--tmux-window <w>` — where its window opens (default `sparrow-<project>` / the handle). Respawns reuse them.
- `--model`, `--effort` — override the resume. `--card N` — assign a board card (moves it to In progress).

Hiring returns at once. Max concurrent agents is limited; extra hires show `queued` and start when a slot frees.

## 4. Wait for results WITHOUT blocking the user
- **In Claude Code:** run `sparrow inbox --wait 600` with the Bash tool and `run_in_background: true`. You get notified when it finishes (a message arrived, or 10 min passed). Read it, act, then **re-arm** the same background command. Keep talking to the user meanwhile.
- **Inside an agent window** (a sub-captain, `SPARROW_AGENT_ID` set): never `inbox --wait`; run `sparrow wait "…"` and stop — results resume you.
- **Elsewhere:** check `sparrow inbox` between other work, or after each user turn.
- Every sparrow command you run also prints new messages (`━━ 📨 …`).

Message kinds you will see: `result: ok|blocked|failed` (an agent ran `done`), `question` (it ran `ask` and is paused), `system` (crash / stopped without reporting / running very long — includes its last screen).

## 5. Respond
```bash
sparrow send @maya "Use Redis, not memory; REDIS_URL is in .env"   # answers a question / gives more work
sparrow log @maya -n 20                                           # what it said and received
sparrow send group "@maya @leo please sync on the token format"   # only @mentioned agents wake
```
Messaging an agent whose window closed respawns it **on the same session** — it remembers everything. Crashed agents restart automatically once; after that you get a crash notice and one message from you resumes it.

Verify before you trust: for important results, hire a `verifier` with the builder's evidence and acceptance checks.

## 6. Board (tracking only — never spawns anything)
```bash
sparrow card list
sparrow card add "Rate limiting on login" --details "5/15min per IP" --state todo
sparrow card move 4 review          # proposed|todo|in_progress|review|done|dropped
sparrow card assign 4 @maya         # or: none
sparrow card note 4 "merged in a1b2c3"
```
Agents `propose` cards (column Proposed); you accept (`move N todo`) or drop them.

## 7. Release when the job is done (permanent by design)
```bash
sparrow release @maya               # closes its window for good; it never wakes again
```
- An agent is hired for one job. Until you release it, it keeps its session id (its "number"): message it any time, even days later, and it resumes with full memory. Use that for follow-ups on the same job.
- Release is permanent on purpose. Once the job is verified and merged, release the agent. New work goes to a fresh hire, so no agent carries stale context from an old job.
- Order: build → verify → merge → release. Never release a builder before its verifier passes; a released agent can't take the fix.

## Watch
- Agent windows: `tmux attach -t sparrow-<project>` (each agent is a window named after its handle). `sparrow status` prints exact attach lines.
- Web UI (board, chat, agents, live screen peek): use the URL printed by `sparrow status`.

## Rules of thumb
- Delegate whole, checkable tasks; keep integration and final judgment yourself.
- Don't hire for things you can do in one minute.
- Don't run the harness CLIs yourself to create agents; always `sparrow hire`.
- Tell the user what you hired, why, and how to watch it.
