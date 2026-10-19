# Changelog

## Unreleased

- Two helper resumes. `deckhand` (Haiku 5.5, medium effort) does mechanical work cheaply and fast and is **one-shot**: the server retires it the moment it reports, so its context never grows. `advisor` (Opus 5.5, medium effort) is a read-only senior who answers one question per consult and stays available for follow-ups. Builders, the Codex builder, verifiers and sub-captains may hire both; researchers may hire the deckhand.
- New resume flags `helper: true` and `one_shot: true`. A helper never hires. An agent allowed to hire only helpers is not a captain, so it gets no captain card rights.
- Default `max_depth` is now 3, so a helper can sit under a sub-captain's builder: you → sub-captain → builder → helper.
- **Settings** page (`#/settings`, `GET`/`PUT /api/settings`) for running slots, depth limit, call limits, provider health, timing and doctor models. Changes are written to `config.json` and apply live without a restart. Agents may not change settings.
- Resume editor: Helper and One-shot switches. Can hire is split into Helpers and Team.
- The `sparrow-worker` skill explains when to hire a deckhand or an advisor.
- A released agent that reports again (for example without its call header) records nothing.

## v0.1.0

First working version, single Mac.

- Captain (your own Claude Code session) hires named agents from resumes with `sparrow hire`; flags for `--cwd`, `--tmux-session`, `--tmux-window`, `--model`, `--effort`, `--card`.
- The server opens each agent as a real interactive TUI in its own tmux window: `claude --dangerously-skip-permissions`, `codex --yolo`, `opencode --auto`, with the protocol + resume as the system prompt and the task as the first message.
- Agents report through the `sparrow` CLI (`update`, `send`, `ask`, `done`, `wait`, `propose`, `card`), taught by the `sparrow-worker` skill and the protocol; new messages piggyback on every command.
- Windows close after `done` to free RAM; the next message resumes the same harness session.
- Safety nets: turn-end hooks (Claude Stop hook, Codex notify, OpenCode plugin) nudge agents that stop without reporting; crashes restart once on the same session; dead windows found by a watchdog; boot recovery; `max_running` queue; `can_hire` and depth guards.
- Web UI: tracking-only Kanban, WhatsApp-style chat log, agents tree with a live screen peek.
