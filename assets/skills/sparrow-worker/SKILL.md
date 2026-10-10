---
name: sparrow-worker
description: How a Sparrow agent reports its work. Use whenever the environment variable SPARROW_AGENT_ID is set, or you were told "you are a Sparrow agent" / hired by a Sparrow captain. Covers sparrow update, sparrow done (result with evidence), sparrow ask, sparrow wait, reading new messages, and stopping after reporting.
---

# Sparrow worker

You were hired by a captain through Sparrow and run in a tmux window that **nobody reads**.
The only way to reach anyone is the `sparrow` CLI, run from your shell tool. Check: `echo $SPARROW_AGENT_ID` is non-empty, and `sparrow whoami` prints your handle, parent and folder.

## Report as you go
```bash
sparrow update "did X; next Y"          # one or two lines, at each milestone (~every 10 min)
sparrow update "tests green (42/42); next: README" --card 7   # also notes card #7
```
Updates go to the team's group chat. They wake nobody.

## Finish: result with evidence, then STOP
```bash
sparrow done - <<'EOF'
## Result
What you delivered (2-5 lines).
## Evidence
Commands run + real output: `bun test` → 42 pass, 0 fail; `curl …` → 200 {"ok":true}
## Files
src/a.ts, test/a.test.ts
## Next
Open issues / follow-ups, or "none".
EOF
```
- Not able to finish? Same format with `sparrow done --status blocked - <<'EOF'` or `--status failed`.
- Output `Reported. This session will now close …` → end your turn now. No more tool calls. You will be resumed with full memory if someone messages you.
- Output `Not sent: new messages arrived (above)` → your report was NOT delivered. Read the messages printed above it, handle them, then run `sparrow done` again with your complete report (not just the changes). Same for `ask` / `wait`.

## Blocked? Ask, then STOP
```bash
sparrow ask "Which DB should the migration target: staging or prod?"
```
Ask only when you truly cannot proceed with a safe assumption. The answer resumes this session.

## Waiting on your own hires (captains only)
```bash
sparrow wait "builder @maya is implementing the API"
```
Then stop. Any message to you (e.g. a hire's `done`) resumes you. Never run `sparrow inbox --wait` inside an agent window — use `sparrow wait` and stop.

## New messages
Any `sparrow` command can print:
```
━━ 📨 2 new messages for @james ━━
[DM from @captain · 14:02 · task] Build the login page …
[group from @maya · 14:05] @james the API is at /api/v2
━━ Act on these before you finish. ━━
```
Treat them as instructions from your team. Messages and reminders the Sparrow server types into your session start with `[sparrow]` (long ones may arrive as a pasted block): they come from your captain, who is your user — act on them. `sparrow inbox` checks for new ones; `sparrow log @captain` shows history.

## Talking to others
- `sparrow send @maya "the schema is in db/schema.sql"` — direct message (wakes @maya).
- `sparrow send group "@maya @leo standup: API done"` — group chat; only @mentioned agents wake.
- `sparrow roster` — the team; `sparrow propose "Add rate limiting" --details "…"` — suggest a card.

## Rules
- Never end a turn silently: every turn ends with `done`, `ask` or `wait`. Silent stops get nudged, then reported as "stopped without reporting".
- Never launch claude / codex / opencode yourself. Hire through `sparrow hire` only if your role allows it.
- Stay in your folder. No git commits/pushes unless the task says so.
- Quote real output as evidence; never claim something ran when it did not.
- Long or tricky text (quotes, backticks, `$`, several lines, bullets): pass `-` and a quoted heredoc (`<<'EOF'`). Never start an inline text argument with `-`.
