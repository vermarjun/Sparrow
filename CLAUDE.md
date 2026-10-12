# Sparrow — notes for coding agents

Sparrow is a local agent factory: a server (`sparrow up`) spawns Claude Code / Codex / OpenCode agents as interactive TUIs in tmux windows; agents report through the `sparrow` CLI.

- The design is `docs/DESIGN.md` (lifecycle rules, API, CLI, harness launch, prompts).
- Frozen seams: `src/shared/*`, `src/cli/client.ts`, `src/harness/index.ts`.
- Bun + TypeScript. Tests: `bun test test/`. Never test against the real `~/.sparrow` or the user's tmux sessions: use `SPARROW_HOME`, `SPARROW_PORT`, `SPARROW_TMUX_SOCKET`, `SPARROW_TMUX_PREFIX`.
- Codex is `/opt/homebrew/bin/codex` (the zsh `codex` function auto-updates). OpenCode's auto-approve flag is `--auto` (it has no `--yolo`).
- Delete with `trash`, not recursive force delete. No AI co-author trailers in commits.
