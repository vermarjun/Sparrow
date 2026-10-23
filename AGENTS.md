# Working on Sparrow

Sparrow runs coding agents in tmux windows on your machine.
A local server coordinates captains, hires, messages, and a shared task board.
The CLI and browser UI expose the same server API; harness adapters support Claude Code, Codex, OpenCode, and a fake harness for tests.

## Repository map

- `assets/`: bundled resumes, worker skills, and harness plugins.
- `bin/`: CLI entry point.
- `docs/`: design specification and contributor documentation.
- `scripts/`: sandbox skill fixtures and migration verification tools.
- `src/`: application TypeScript.
- `src/cli/`: command parsing, output, HTTP client, installation, and server lifecycle.
- `src/harness/`: common harness contract, launch environment, and dispatcher.
- `src/harness/drivers/`: individual harness implementations and fake test harness.
- `src/server/`: HTTP routes, SQLite persistence, scheduling, agent lifecycle, and tmux integration.
- `src/shared/`: shared types, configuration, card helpers, and pure utilities.
- `src/skills/`: skill discovery, manifests, migration, import, and library operations.
- `test/`: backend and CLI tests, guarded preload, helpers, and synthetic fixtures.
- `web/`: Vite/React UI, in-memory mock API, browser verification scripts, and UI unit tests.

## Run from source

Install Bun and tmux, and put any real harnesses you want to use on PATH.
Run `bun install`, then `(cd web && bun install)`.
Build the UI with `bun run web:build`; run the application with `bun bin/sparrow`.
For UI development use `bun run web:dev` and configure `VITE_API` for your server.
`bun bin/sparrow install` installs integration assets into your home; use a temporary HOME when verifying installation.
Read `docs/DESIGN.md` for lifecycle rules, API contracts, launch protocols, and skills safety rules.

## Test in isolation

Never run tests against your live `~/.sparrow`, port 4040, harness skill folders, or existing tmux sessions.
Choose an unused local port (for example using `freePort()` in `test/cli/helpers.ts`) and set all five variables:

```sh
export SPARROW_HOME="$PWD/.sandbox/t/home"
export SPARROW_PORT="$(bun -e 'const s = Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}}); console.log(s.port); s.stop(true)')"
export SPARROW_TMUX_SOCKET=sparrow-test
export SPARROW_TMUX_PREFIX=sparrow-test-
export SPARROW_SKILLS_HOME="$PWD/.sandbox/t/skills"
bun run typecheck
bun test test/
(cd web && bun test test/ && bun run typecheck && bun run lint)
```

The home isolates database and server state; the port isolates HTTP; the socket and prefix isolate tmux; the skills home fences skill-library and harness-folder writes.
`test/preload.ts` removes inherited worker identity and refuses an unset/live home or port.
Installation tests must additionally override `HOME` to a temporary directory, because harness plugins and configuration use it.
Real harness tests require explicit opt-in (`SPARROW_REAL=1`), authenticated harnesses, and an isolated environment; normal tests use the fake harness.
Browser scripts in `web/scripts/` accept a target URL and project; use an isolated mock or sandbox server. Set `CHROME_BIN` to your Chromium executable when it is not on PATH.

## Contracts and style

Frozen seams are `src/shared/*`, `src/cli/client.ts`, and `src/harness/index.ts`: coordinate interface changes with maintainers and update callers together.
Follow nearby code: backend TypeScript uses semicolons, UI TypeScript generally omits them; keep imports and naming consistent within each file.
Prefer existing helpers, explicit types at API boundaries, and small pure functions for shared logic.
Keep comments that explain lifecycle and safety invariants. Avoid unrelated formatting or dependency changes.
Add meaningful behavior and error-case tests for functional changes; run the relevant suite and type checker before reporting completion.
Never stop a server or tmux session you did not create. Use `sparrow sandbox up --dir .sandbox/<name>` and the matching `sandbox down` for disposable servers.

## Changes and commits

Keep patches focused and preserve unrelated work. Use small logical commits with an imperative description; never add AI co-author trailers.
Follow the task's branch and commit permissions; do not push or rewrite history without explicit authorization.
Use `trash` for removing working files. Keep generated output, local settings, credentials, and scratch data untracked.
Report exact checks and results, and distinguish verified behavior from outstanding work.
