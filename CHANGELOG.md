# Changelog

## v0.1.0

First working version, single Mac.

- Captain (your own Claude Code session) hires named agents from resumes with `sparrow hire`; flags for `--cwd`, `--tmux-session`, `--tmux-window`, `--model`, `--effort`, `--card`.
- The server opens each agent as a real interactive TUI in its own tmux window: `claude --dangerously-skip-permissions`, `codex --yolo`, `opencode --auto`, with the protocol + resume as the system prompt and the task as the first message.
- Agents report through the `sparrow` CLI (`update`, `send`, `ask`, `done`, `wait`, `propose`, `card`), taught by the `sparrow-worker` skill and the protocol; new messages piggyback on every command.
- Windows close after `done` to free RAM; the next message resumes the same harness session.
- Safety nets: turn-end hooks (Claude Stop hook, Codex notify, OpenCode plugin) nudge agents that stop without reporting; crashes restart once on the same session; dead windows found by a watchdog; boot recovery; `max_running` queue; `can_hire` and depth guards.
- Web UI: tracking-only Kanban, WhatsApp-style chat log, agents tree with a live screen peek.
