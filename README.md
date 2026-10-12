# Sparrow

A local agent factory. Your own Claude Code session is the **captain**: it hires named agents from role cards ("resumes"), and a small server (`sparrow up`) opens each one as a real interactive Claude Code, Codex or OpenCode TUI in its own tmux window. Agents report back through the `sparrow` CLI; results land in the captain's inbox.

## Install

```bash
bun install
bun run sparrow install      # seeds ~/.sparrow/resumes, links ~/.local/bin/sparrow, installs skills + harness assets
sparrow up --tmux            # server in tmux session 'sparrow', window 'server' → http://127.0.0.1:4040
```

`sparrow install` is idempotent; `--force` overwrites resumes you edited and rebuilds the UI. The web UI (`web/dist`, git-ignored) is built by `sparrow install` when missing (`bun install` + `bun run build` in `web/`); `sparrow up` warns if it is not built. Skills go to `~/.claude/skills` (Claude Code; OpenCode reads it too) and `~/.codex/skills` (Codex).

## Captain flow

In your own Claude Code session (the `sparrow-captain` skill teaches this):

```bash
sparrow status                                   # is the server up? who is working?
sparrow resumes                                  # who can I hire
sparrow hire builder - --card 4 <<'EOF'          # brief: goal, context, acceptance, constraints
Goal: … Acceptance: `bun test` green …
EOF
sparrow inbox --wait 600                         # in Claude Code: run as a background Bash command, re-arm after each wake
sparrow send @maya "use Redis"                   # answer a question / more work (respawns a closed agent on the same session)
sparrow release @maya                            # done for good
```

Watch agents: `tmux attach -t sparrow-<project>` (one window per agent) or the web UI at http://127.0.0.1:4040 (board, chat, agents with live screen peek).

Agents (the `sparrow-worker` skill + the protocol in their system prompt) post `sparrow update`, finish with `sparrow done - <<'EOF' … EOF` (Result / Evidence / Files / Next), `sparrow ask` when blocked, `sparrow wait` after delegating. After `done` the window closes; the next message resumes the same harness session with full memory.

## CLI

```
sparrow up [--port N] [--max-running N] [--tmux]
sparrow install [--force]
sparrow status
sparrow whoami
sparrow resumes
sparrow roster [--all]
sparrow hire <resume> "<task>" [--name h] [--cwd d] [--tmux-session s] [--tmux-window w] [--card N] [--model m] [--effort e]
sparrow send <@handle|group> "<text>" [--card N]
sparrow update "<text>" [--card N]
sparrow ask "<question>"
sparrow done "<summary>" [--status ok|blocked|failed]
sparrow wait ["<reason>"]
sparrow inbox [--wait SEC]
sparrow log [@handle|group] [-n 30]
sparrow propose "<title>" [--details d] [--category c]
sparrow card list | add "<title>" [--details d] [--state s] [--assignee @h] [--category c] | move <N> <state> | assign <N> <@h|none> | note <N> "<text>"
sparrow release <@handle>
```

Any text argument may be `-` to read stdin (use a quoted heredoc). `--json` prints the raw server response. Exit codes: 0 ok, 1 server error (message printed), 2 bad usage. Every command prints new messages for you in a `━━ 📨 … ━━` block.

Identity: inside agent windows `SPARROW_AGENT_ID` is set. Without it the CLI registers you as the human `@captain` of the project (the git root of your cwd).

Resumes shipped: `builder` (Claude, opus), `builder-codex` (Codex, gpt-6.1-sol), `verifier` (Codex, read-only PASS/FAIL), `researcher` (OpenCode, kimi-k3), `presenter` (OpenCode, glm-5.3), `sub-captain` (Claude, may hire the others). Edit them in `~/.sparrow/resumes/`.

## Failure handling

- **Crash** (harness exits non-zero or its window vanishes): restarted once on the same session; a second crash sends the parent a notice with the last screen. Messaging the agent resumes it.
- **Stopped without reporting**: nudged (Claude via its Stop hook, Codex/OpenCode via a typed reminder) up to 2 times, then the parent gets an "unreported" notice with the agent's last message and the window closes.
- **Quiet** for the resume's `quiet_minutes`: one reminder to post an update. Over `max_call_minutes`: the parent is told. Agents are never killed for time.
- **Concurrency**: at most `max_running` agents work at once (default 3); extra hires are `queued` and start when a slot frees.
- **Server restart**: live windows are re-adopted; dead ones are marked crashed and the parent is told.

## Where state lives

- `~/.sparrow/sparrow.db` — SQLite: projects, agents, calls, messages, deliveries, cards.
- `~/.sparrow/resumes/*.md` — role cards. `~/.sparrow/config.json` — tunables (`max_running`, `max_depth`, `max_nudges`, …).
- `~/.sparrow/agents/<id>/` — per-agent system prompt and per-call launch scripts/prompts.
- Env overrides (tests): `SPARROW_HOME`, `SPARROW_PORT`, `SPARROW_URL`, `SPARROW_TMUX_SOCKET`, `SPARROW_TMUX_PREFIX`, `SPARROW_SETTINGS`.

Tests: `bun test test/`.
