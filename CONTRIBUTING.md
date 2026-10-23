# Contributing to Sparrow

Bug reports, fixes, harness drivers and resumes are all welcome. This page gets you from a fresh clone to a green
test run. Coding agents should read [AGENTS.md](AGENTS.md) too: it is the short version of this page.

## Set up from source

You need [Bun](https://bun.sh), tmux and git. Real harnesses (Claude Code, Codex, OpenCode) are optional: the tests
use a fake harness.

```sh
git clone https://github.com/vermarjun/Sparrow.git
cd Sparrow
bun install
(cd web && bun install)
bun run web:build          # build the UI once
bun bin/sparrow            # start the server and open the UI
```

`bun bin/sparrow install` links `~/.local/bin/sparrow` to your checkout and copies skills and plugins into your real
home. Run it only when you want that. To check install behaviour safely, run it with a temporary `HOME`:
`HOME=$(mktemp -d) SPARROW_HOME=$PWD/.sandbox/inst/home bun bin/sparrow install`.

For a server that cannot touch your real one, use a sandbox:

```sh
bun bin/sparrow sandbox up --dir .sandbox/dev      # own home, free port (never 4040), own tmux socket
bun bin/sparrow sandbox down --dir .sandbox/dev
```

## Run the tests

Never run the suite against your real `~/.sparrow`, port 4040, harness skill folders or your tmux sessions. Set all
five isolation variables first:

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

| Variable | Isolates |
|---|---|
| `SPARROW_HOME` | database and server state |
| `SPARROW_PORT` | HTTP (pick a free one, never 4040) |
| `SPARROW_TMUX_SOCKET`, `SPARROW_TMUX_PREFIX` | tmux windows and sessions |
| `SPARROW_SKILLS_HOME` | skill-library and harness-folder writes |

`bunfig.toml` preloads `test/preload.ts`. It deletes inherited agent identity variables (`SPARROW_AGENT_ID` and
friends) and refuses to run, with exit code 1, when `SPARROW_HOME` is unset or is `~/.sparrow`, or when `SPARROW_PORT`
is unset or 4040. If you see that refusal, you forgot the variables above.

Rules that keep the suite safe:

- Install tests also override `HOME` with a temporary directory.
- Never write a test whose failure mode is `sparrow stop` or `up` against a port you did not pick. Use `freePort()`
  from `test/cli/helpers.ts`, and test lifecycle guards through pure functions.
- Real-harness tests are opt-in (`SPARROW_REAL=1`), need logged-in harnesses, and need the isolated environment.
  Normal tests use the fake harness.
- A date-sensitive CLI fixture can fail on its own. If one test fails with an age off by a day or two, check it before
  you blame your change.

## Web UI development

The UI is Vite and React in `web/`. You do not need a running Sparrow server for it. A mock server serves a seeded demo
world (a pirate crew on a project called tortuga):

```sh
cd web
bun run mock           # mock API with seeded data and live events on :4140
bun run dev:mock       # Vite on :5173, /api proxied to the mock
```

To develop against a real server instead, run `bun run dev` with `VITE_API` pointing at it. Browser verification
scripts live in `web/scripts/` (`bun scripts/shots.ts` takes screenshots against the mock). They need a Chromium:
set `CHROME_BIN` if it is not on your `PATH`. Include screenshots in the PR for any UI change.

## The shape of the code

| Path | What is there |
|---|---|
| `src/cli/` | Command parsing, output, the HTTP client, install, server lifecycle. |
| `src/server/` | HTTP routes, SQLite, scheduling, agent lifecycle, doctor, settings. |
| `src/harness/` | The seam to the harnesses: launch scripts, tmux, hooks, and `drivers/`. |
| `src/shared/` | Types, config, ticket helpers. |
| `src/skills/` | Skill discovery, grants, import, library git. |
| `assets/` | Shipped resumes, the worker protocol, the two Sparrow skills, the OpenCode plugin. |
| `web/` | The UI and its mock API. |
| `test/` | Backend and CLI tests, the guarded preload, fixtures. |

Design decisions, lifecycle rules, API contracts and launch protocols live in [docs/DESIGN.md](docs/DESIGN.md). Read
it before changing how calls, messages or the scheduler behave.

### Frozen seams

These files are contracts. Change them only with a maintainer's agreement, and update every caller in the same PR:

- `src/shared/*`
- `src/cli/client.ts`
- `src/harness/index.ts`

## Add a harness driver

A driver teaches Sparrow to launch one harness's TUI, resume its sessions and type into it.

1. Implement the `Driver` interface in `src/harness/drivers/<name>.ts` (see `drivers/types.ts` and the Claude, Codex
   and OpenCode drivers for working examples): `prepare` builds the command for a new or resumed session, `deliver`
   types text into the TUI, `discoverSession` finds a session id when hooks never reported one, and `afterStart` is
   optional.
2. Register it in `DRIVERS` in `src/harness/spawner.ts`, add the name to `HarnessName` in `src/shared/types.ts` (a
   frozen seam, so ask first) and to `HARNESSES` in `src/server/resumes.ts`.
3. Give it a way to report turn ends (a hook, a notify command or a plugin) that calls `sparrow hook <kind>`, and a
   binary override variable next to the others in `src/harness/env.ts`.
4. Add it to the doctor (`src/server/doctor.ts`) and the model catalog (`src/harness/catalog.ts`).
5. Test it with a stub first (`test/harness/` has helpers and a fake agent), then do one real run by hand with
   `SPARROW_REAL=1` in an isolated environment, and paste the evidence in your PR.

## Add or change a resume

Default resumes are Markdown files in `assets/resumes/`. Copy one, change the frontmatter and the prompt, and keep the
format in [docs/configuration.md](docs/configuration.md#resume-files). Rules of thumb:

- One role, one job. A good resume says what the agent owns, how it proves it, and how it reports.
- Keep the prompt free of machine-specific paths, names and model promises. Use `{{runtime}}` in descriptions.
- Seeding never overwrites a user's edited copy, and never brings back one they deleted, so a changed default only
  reaches installs that do not already have that slug. Say so in the PR if that matters.
- `test/server/resume-lint.test.ts` checks the shipped set. Run it.

## Commits and pull requests

- Small, logical commits with an imperative subject line (`cli: reject unknown flags in card edit`).
- Do not add AI co-author trailers to commits.
- Keep generated output, local settings, credentials and scratch data out of git (`.sandbox/` is already ignored).
- Add tests for behaviour changes, including the failure path, and run the type checker.
- Open the PR against `main`. The template asks what changed and why, which tests you ran with the isolation
  variables, whether the type checker passed, and screenshots for UI changes.

Before you open a bigger change, file an issue and say what you plan. It saves you a rewrite.

By contributing you agree that your work is released under the [MIT license](LICENSE). Everyone taking part follows
the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not a public
issue.
