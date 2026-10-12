# Acceptance — v0.1.0

Run on a MacBook Air (macOS 15.3) with Claude Code 2.1.296, Codex 0.162.1 and OpenCode 1.18/1.19. Real interactive TUIs in tmux, cheap models (Claude haiku/sonnet low, Codex low effort, OpenCode Go deepseek-v4-flash low). Unit + e2e suite: `bun test test/` → 206 tests, 0 failures (real-CLI tests gated behind `SPARROW_REAL=1`).

| # | Check | Result | Evidence (short) |
|---|---|---|---|
| A1 | `sparrow install`, then `sparrow resumes` lists 6 resumes | PASS | resumes seeded, `~/.local/bin/sparrow` linked, skills in `~/.claude/skills` + `~/.codex/skills`, OpenCode plugin installed |
| A2 | Claude, Codex and OpenCode hired in parallel → 3 windows, update + done, results in the captain's inbox, windows close | PASS | first `done`: claude 8 s, codex 16 s, opencode 28 s; `list-windows` empty afterwards |
| A3 | Message a closed agent → window reopens on the same session and remembers | PASS | session ids unchanged; each harness recalled its word; OpenCode 5/5 resumes, every prompt landed once |
| A4 | Group @mention wakes only that agent; updates wake nobody | PASS | `@MAYA` (case-insensitive) woke only @maya; an update mentioning @leo created no delivery |
| A5 | Kill a window → restarted once on the same session; kill again → crash notice with last screen | PASS | watchdog restart on the same session; notice shows a ~5 s old screen, no blank padding |
| A6 | Agent stops without reporting → nudged → "unreported" notice + window closed | PASS | Claude via Stop-hook block (2 nudges), OpenCode/Codex via typed reminders; Codex reported after nudge 1 |
| A7 | Guards: worker can't hire, depth 3 refused, `max_running` queues | PASS | `may not hire … can_hire = []`; `would create depth 3`; with `max_running: 1` the 2nd hire queued and started when the 1st finished |
| A8 | Sub-captain hires a builder, `wait`s, is woken by the builder's done, reports to the captain | PASS | sub-captain resumed on the same session, digest reached the human captain |
| A9 | Board: propose → Proposed; captain moves show live; a UI drag only changes the card | PASS | drag sent one `PATCH /api/cards/2`; messages, deliveries, calls, agents and windows unchanged |
| A10 | `--cwd`, `--tmux-session`, `--tmux-window` honoured and reused on respawn | PASS | `sparrow-it-custom:zed` in `/tmp/sparrow-it/other`, same session on respawn |
| A11 | UI renders live data; screen peek shows a working agent's TUI | PASS | Board, Chat and Agents screenshots with a live Claude and OpenCode peek |

Also verified: boot re-adopt of a live window after a server restart; `sparrow inbox --wait 320` waits the full time; a Claude agent with a running background shell is not nudged and reports by itself when the task ends; a message sent while an OpenCode agent resumes is posted exactly once.

Known limits: Claude asks to trust each new folder (Sparrow pre-accepts it in `~/.claude.json` for agent folders); OpenCode ignores `--prompt` on resume, so the envelope is typed in after the TUI is ready (~5–10 s); Codex and OpenCode often need one nudge before reporting; resumes are copied onto an agent at hire time, so edits apply to new hires only.
