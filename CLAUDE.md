# Sparrow — notes for coding agents

Sparrow is a local agent factory: a server (`sparrow up`) spawns Claude Code / Codex / OpenCode agents as interactive TUIs in tmux windows; agents report through the `sparrow` CLI.

- The design is `docs/DESIGN.md` (lifecycle rules, API, CLI, harness launch, prompts).
- Frozen seams: `src/shared/*`, `src/cli/client.ts`, `src/harness/index.ts`.
- Bun + TypeScript. Tests: `bun test test/`, always with the four isolation vars set, e.g. `SPARROW_HOME=$PWD/.sandbox/t/home SPARROW_PORT=<free port, never 4040> SPARROW_TMUX_SOCKET=t SPARROW_TMUX_PREFIX=t- bun test test/`. Never test against the real `~/.sparrow`, the live server on :4040, or the user's tmux sessions. `bunfig.toml` preloads `test/preload.ts`, which deletes `SPARROW_AGENT_ID`/`CALL_ID`/`URL`/`WINDOW` and REFUSES to run (exit 1) when `SPARROW_HOME` is unset or `~/.sparrow`, or `SPARROW_PORT` is unset or 4040. Never write a test whose failure mode is `sparrow stop`/`up` against a port you did not pick (use `freePort()` from `test/cli/helpers.ts`; test lifecycle guards through pure functions).
- Codex is `/opt/homebrew/bin/codex` (the zsh `codex` function auto-updates). OpenCode's auto-approve flag is `--auto` (it has no `--yolo`).
- Delete with `trash`, not recursive force delete. No AI co-author trailers in commits.
