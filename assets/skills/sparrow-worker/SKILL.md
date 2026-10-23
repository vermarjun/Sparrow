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
Your progress updates go to your parent's DM as quiet deliveries. They are delivered together with
your result or another waking message, or shown in the parent's `Still working:` digest when
`sparrow inbox --wait` times out. They never interrupt anyone.

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
- Output `Not sent: …` → your report was NOT delivered, and the refusal consumes nothing. Run `sparrow inbox`, handle the messages, then run `sparrow done` again with your complete report (not just the changes). Same for `ask` / `wait`.

## Blocked? Ask, then STOP
```bash
sparrow ask "Which DB should the migration target: staging or prod?"
```
Ask only when you truly cannot proceed with a safe assumption. The answer resumes this session.

## Helpers: deckhand and advisor (only if `sparrow whoami` lists them under "can hire")
Helpers are cheap leaf agents. Hiring one does not make you a captain; you still own your task and report it yourself.
- **deckhand** (fast, cheap, **one-shot**: released the moment it reports, so put everything into one brief). Give it
  mechanical work with an exact done-check: find where X is used (`path:line`), run the tests/build and report the
  failures verbatim, triage a log, apply one named edit across listed files, convert a file. Never a decision, an
  unknown bug, or anything you would have to re-check line by line. Under ~3 tool calls? Do it yourself.
  ```bash
  sparrow hire deckhand - <<'EOF'
  List every caller of parseResume() in src/ and test/ as path:line + the line. Done when: the list is complete per `rg -n "parseResume\(" src test`.
  EOF
  ```
- **advisor** (senior, read-only). Consult it after you have read the code and before you commit to an approach on
  non-trivial work, when the same error survives two fixes, or before `sparrow done` on a risky change. It has not seen
  your session: ask ONE question with your goal, what you tried (exact errors), the options you weigh, and `path:line`
  pointers. Follow up on the same advisor with `sparrow send @<handle> "…"`; `sparrow release @<handle>` it when your
  task is done.
- After hiring, keep working on what does not depend on the answer (results arrive in your session as `[sparrow]`
  messages), or run `sparrow wait "<what you wait for>"` and stop.
- Weigh advice against evidence; if you don't follow it, say why in your result. A deckhand's output is a lead, not
  proof: if your job is verifying, re-run the check that decides PASS/FAIL yourself.

## Waiting on your own hires (captains only)
```bash
sparrow wait "builder @maya is implementing the API"
```
Then stop. Any message to you (e.g. a hire's `done`) resumes you. Never run `sparrow inbox --wait` inside an agent window — use `sparrow wait` and stop.

## New messages
Only `sparrow inbox` (and `sparrow inbox --wait`) prints messages, as a block like this. The start of a call and the turn-end handoff also deliver them. No other command takes them:
```
━━ 📨 2 new messages for @james ━━
[DM from @captain · 14:02 · task] Build the login page …
[DM from @maya · 14:05] Can you check the API contract?
━━ Act on these before you finish. ━━
```
Other `sparrow` commands end with one stderr line `📨 N unread ... Read: sparrow inbox` when messages are waiting. If you see it, run `sparrow inbox` now.
Treat them as instructions from your team. Messages and reminders the Sparrow server types into your session start with `[sparrow]` (long ones may arrive as a pasted block): they come from your captain, who is your user — act on them. `sparrow log @captain` shows history.

## Talking to others
- `sparrow send @maya "the schema is in db/schema.sql"` — direct message (wakes @maya).
- `sparrow roster` — the team; `sparrow propose …` — suggest a board ticket (next section).

## Board tickets
Cards have a key (`TOR-12`); every command takes `12`, `#12` or `TOR-12`. Read one with `sparrow card show TOR-12`
(context, problem, approach, "Done when" checks, comments, timing). Your task may reference a ticket: follow its Approach and satisfy every check.
```bash
sparrow card note TOR-12 "found the cause: stale cache"   # comment on a card assigned to you
sparrow card check TOR-12 2          # tick "Done when" item 2 as you verify it (--undo to untick)
sparrow card block TOR-12 "IT: NetSuite access"   # you are waiting on a person; sparrow card unblock TOR-12
sparrow card move TOR-12 review      # build finished; `sparrow done` (ok) does this for you
```
Only the user moves a card to Done, after reviewing it; you get a 403 if you try. `sparrow done --status blocked|failed` never moves the card.

On the board a card shows only: title (2 lines max), category dot, a payoff word from impact × effort (Quick win,
Worth it, Big bet, Heavy lift, Money pit; other combinations show nothing), a red rail if urgent, an orange striped
rail if blocked, age and assignee. Everything else (context, problem, approach, checks, tags, details, blocker text)
is in the hover peek and the ticket sheet, so the title and impact/effort carry the triage.

**Propose** work you found but were not asked to do. A ticket must let a human triage it in 5 seconds and an agent start it
without questions. Run `sparrow card list` first and never duplicate. One ticket is one shippable job (over 7 checks: split).
- **Title**: outcome first, verb first, at most 70 chars: what changes for whom.
- `--context`: why it exists, who asked, where it came from ("Shubhankar, Monday's meet"), what it unblocks. 2 lines.
- `--problem`: `Observed: … Expected: …`. 3 lines. Never "it is bad".
- `--approach`: plain English, **no code**, 5 lines at most, name the main risk or alternative.
- `--check` (repeat, 2 to 7): "Done when". Each is one binary sentence someone else can verify. Never "tests pass".
- Always set `--impact` and `--effort` (`low|medium|high`, honest) and `--estimate` (honest guess, then **double it**: `90m`, `2h`, `1d`, a day is 8h).
- `--urgent` only when it blocks someone right now. `--blocked "<who/what>"` only when you wait on a person. Also `--category`, `--tag`.
```bash
sparrow propose "Show estimate vs actual on done cards" \
  --context "Shubhankar asked in Monday's meet: he cannot tell whether our estimates are any good." \
  --problem "Observed: a Done card shows no timing. Expected: it shows the estimate next to the time it was really worked." \
  --approach "Add a Timing panel to the card sheet from the stored state history; show the ratio to the estimate. Risk: old cards have no history, so hide the panel for them." \
  --check "A done card shows its estimate and build time" --check "A card without an estimate says no estimate" \
  --category board --tag ui --impact high --effort low --estimate 4h
```

## Servers and processes: never touch one you did not create
- **Never start, stop, restart or kill a Sparrow server you did not create.** The one on :4040 belongs to the user: `sparrow up`, `sparrow stop`, bare `sparrow` and `sparrow up --tmux` are refused from an agent window.
- If `sparrow` says the server is unreachable: do not try to start it. Say so in your final message (`sparrow done --status blocked`) and stop.
- Need a throwaway Sparrow server for a test? **`sparrow sandbox up` is the way** (do not hand-roll homes and ports):
  ```bash
  sparrow sandbox up --dir ./.sandbox/mytest   # own home, a free port (never 4040), own tmux socket; prints the env lines
  ./.sandbox/mytest/sbx hire fake "FAKE:done ok"   # runs sparrow against THAT sandbox only
  sparrow sandbox down --dir ./.sandbox/mytest     # stops only that home's server and kills its tmux socket
  ```
  Without `--dir` it uses `./.sandbox/sparrow-<n>`. Your own `sparrow update/done/ask/wait` always keep reporting to the server your window started with (`SPARROW_AGENT_URL`), so changing `SPARROW_PORT`/`SPARROW_HOME` in your shell cannot redirect them. Never point your own reporting at a sandbox.
- **Never** `pkill -f`, `pgrep -f`, `killall` or `kill $(ps … | grep …)` against `sparrow`, `bun`, `claude`, `codex` or `opencode`: the pattern also matches the user's server and other agents. Stop only a process you started, by its own pid or with `sparrow sandbox down`.
- Never `unset SPARROW_AGENT_ID` in your own shell: the CLI then refuses (it knows this is an agent window). Unset identity variables only in a subshell: `(unset SPARROW_AGENT_ID SPARROW_URL SPARROW_CALL_ID; bun test)`.

## Rules
- Never end a turn silently: every turn ends with `done`, `ask` or `wait`. Silent stops get nudged, then reported as "stopped without reporting".
- Never launch claude / codex / opencode yourself. Hire through `sparrow hire` only if your role allows it.
- Stay in your folder. No git commits/pushes unless the task says so.
- Quote real output as evidence; never claim something ran when it did not.
- Long or tricky text (quotes, backticks, `$`, several lines, bullets): pass `-` and a quoted heredoc (`<<'EOF'`). Never start an inline text argument with `-`.
