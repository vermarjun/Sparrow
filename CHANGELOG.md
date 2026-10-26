# Changelog

## 0.2.0 (2026-10-27): first public release

- **Standalone binary and install routes.** Sparrow ships as one self-contained binary for macOS and Linux (arm64 and x64). Install with `curl ... install.sh | sh` (checksum-verified), `npm i -g sparrow-agents` or `brew install vermarjun/tap/sparrow`. No Bun, clone or build step. The first plain `sparrow` sets itself up, unpacks its UI into `~/.sparrow/app/<version>/`, and prints a readiness check (tmux, each harness installed and logged in, which roles are hireable). Releases are built and published by CI.
- **Explicit-read delivery.** Every message is stored with one delivery row per recipient and is consumed only by an explicit read: `sparrow inbox`, `inbox --wait`, the envelope at the start of a call, or the turn-end handoff. Other commands print an `📨 N unread` notice on stderr, so piping or discarding output can no longer swallow a message. `done`, `ask` and `wait` refuse while waking messages are unread. `--json` objects carry an `unread` list.
- **Nested worktree project fix.** A linked worktree now resolves to its own repository's project even when a registered project sits above it (for example a dotfiles repo in `$HOME`).
- **Portable resumes and harness fallback.** Shipped resumes name no provider-specific model (Claude roles use the `opus`, `sonnet` and `haiku` aliases; Codex and OpenCode roles use the harness default). When first-run seeding finds a role's harness missing, it rewrites that role onto an installed one and says so. Resumes you edited are never overwritten.
- **Portable harness discovery.** `claude`, `codex` and `opencode` are found through `SPARROW_*_BIN`, a widened `PATH` and well-known install folders, instead of fixed Homebrew paths. A bad override is reported, not silently used.
- **Linux.** Browser opening uses `xdg-open`, `gio` or `sensible-browser` when a desktop session exists and prints the URL otherwise (set `SPARROW_NO_OPEN=1` to never open one). Process and port handling no longer assume macOS. Verified end to end in a Debian container on arm64.
- **Uninstall.** `sparrow uninstall` removes the link, skills, plugins and app folder; `--purge` also deletes `$SPARROW_HOME`. It refuses while the server runs.
- **Docs and community files.** Getting started, concepts, CLI reference, configuration, troubleshooting and releasing guides; SECURITY, CONTRIBUTING, CODE_OF_CONDUCT and LICENSE (MIT); issue and pull request templates; `AGENTS.md` for coding agents.

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
