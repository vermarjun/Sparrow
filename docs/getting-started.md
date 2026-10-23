# Getting started

This page takes you from nothing to a finished, verified first hire. It takes about ten minutes, plus the time your
first agent spends working.

## Prerequisites

| You need | Why | How to check |
|---|---|---|
| macOS or Linux | Sparrow runs agents in tmux windows. Windows works only through WSL2, untested. | `uname -s` |
| tmux | Every agent gets its own tmux window. | `tmux -V` |
| One logged-in harness | Agents are the real Claude Code, Codex or OpenCode. Sparrow adds no model access of its own. | see below |

Sparrow checks that `tmux -V` runs. It enforces no minimum tmux version, and none has been verified, so use a recent
one. Most testing so far was on macOS. Linux is supported, with less mileage behind it; file an issue if something
breaks.

You need at least one of these, logged in. Check each one you plan to use:

```sh
claude auth status       # Claude Code
codex login status       # Codex
opencode auth list       # OpenCode
```

Sparrow never logs in for you. Each agent uses the login its harness already
has, so your plan's usage limits still apply.

## Install

<!-- install: finalize after oss/dist merge -->
```sh
# 1. install script
curl -fsSL https://raw.githubusercontent.com/vermarjun/Sparrow/main/install.sh | sh

# 2. npm (or npx sparrow-agents, bunx sparrow-agents)
npm i -g sparrow-agents

# 3. Homebrew
brew install vermarjun/tap/sparrow
```

All three give you the same `sparrow` command. Check it:

```sh
sparrow --version
```

### From source

Do this if you want to hack on Sparrow. You need [Bun](https://bun.sh) and tmux.

```sh
git clone https://github.com/vermarjun/Sparrow.git
cd Sparrow
bun install
(cd web && bun install)
bun bin/sparrow install
```

`sparrow install` is idempotent. It creates `~/.sparrow`, seeds the default resumes (it never overwrites ones you
edited, and never brings back ones you deleted), links `~/.local/bin/sparrow` to your checkout, copies the
`sparrow-captain` and `sparrow-worker` skills into `~/.claude/skills` and `~/.codex/skills`, installs the harness
plugins, builds the UI, and reports which binaries it found. Make sure `~/.local/bin` is on your `PATH`. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the rest of the developer setup.

## First run

```sh
sparrow
```

With no arguments, `sparrow` starts the server detached if it is not running, waits for the UI, opens it in your
browser and returns. The server listens on `http://127.0.0.1:4040`. Run it again any time: it just reopens the UI.

```sh
sparrow status     # server health, working agents, tmux attach lines
sparrow stop       # stop the server (live agent windows are adopted back on the next start)
```

If the browser does not open, open `http://127.0.0.1:4040` yourself. The server log is `~/.sparrow/server.log`.

## Run the doctor

Open the UI, go to **Doctor** (`#/doctor`) and press **Run doctor**. It checks:

- tmux is installed
- agents can reach the server
- `sparrow` is on `PATH`
- the skills library and links are sane
- hook paths exist
- each harness is installed and logged in, its model catalog loads, and a live round trip works

The doctor never runs on its own. The live round trip hires a real agent on each harness you have, so it can spend a
little real usage (it picks the cheapest model it can find; Settings lets you pin one). Every failed check has a fix
line. Fix those before your first real hire, and do not hire a resume the UI marks **UNUSABLE**.

## Become a captain

A captain is the coding session you talk to. It hires and manages the crew. There are three ways to get one.

**Ask your existing session (the easy way).** Open Claude Code in your repo and ask for a crew in plain English:

> Use Sparrow. Hire a builder to add rate limiting to POST /login, then a verifier to check it.

The installed `sparrow-captain` skill tells the session how to run `sparrow`. The first `sparrow` command it runs
registers that session as a captain of the project (the git root of the working directory) and prints
`You are @captain, a new captain in <project>`. Your first captain in a project is `@captain`. Later ones get names
like `@cap-orion`.

**Launch one from a terminal.**

```sh
sparrow captain --cwd ~/code/myrepo --title "Rate limiting for login"
```

This opens a new Claude Code captain in a tmux window and prints how to attach. You can also press **New captain** on
the Captains page of the UI. `sparrow captain` launches Claude Code only.

**Codex or OpenCode as the captain.** Run the harness yourself in a terminal and ask it to use Sparrow. The skill is
installed for both (OpenCode reads `~/.claude/skills`). Codex has a session id, so Sparrow can tell its sessions
apart. An OpenCode terminal session has none: it counts as the project's only captain while it is alone, and once
the project has several captains Sparrow answers with a 409 that names them. Set `SPARROW_CAPTAIN_ID=<id or handle>`
in that shell to pick one. Launching and resuming a captain in tmux (`sparrow captain`, `sparrow captain resume`)
works for Claude Code only.

Name the work so you can find it later:

```sh
sparrow title "Rate limiting for login"
sparrow captains        # every captain in this project, with its team and resume line
```

## Hire an agent

Pick a role, then give it a real brief.

```sh
sparrow resumes         # slug, harness, model, effort, status, who it may hire
```

```sh
sparrow hire builder - --name maya <<'EOF'
Goal: rate-limit POST /login, 5 tries per 15 minutes per IP.
Context: the server is src/server/api.ts; tests live in test/server/.
Acceptance: `bun test test/server/` is green, including a test that the 6th attempt gets a 429.
Constraints: no new dependencies; do not touch src/shared/.
Report: sparrow update at milestones; sparrow done with Result, Evidence, Files, Next.
EOF
```

A good brief has a goal, the files that matter, acceptance checks written as commands, constraints, and how to
report. One task per hire. `--name` is optional. Leave `--model` and `--effort` off: the resume already holds your
choice.

The hire returns at once and prints the agent's handle, harness, and a `tmux attach` line. If every running slot is
taken (default 3), the agent shows `queued` and starts when one frees up.

## Wait for results

<!-- messaging: verify against oss/protocol -->
Results land in your inbox. Read it, or wait for it:

```sh
sparrow inbox              # read what is waiting
sparrow inbox --wait 600   # block up to 10 minutes for something new
```

In Claude Code, run `sparrow inbox --wait 600` with the Bash tool in the background (`run_in_background: true`). You
are notified when it returns, you read the result, then you start the same command again. Meanwhile your session is
free to talk to you. Run only one `inbox --wait` at a time: a newer one stops the older one. In Codex or OpenCode,
check `sparrow inbox` between other work.

A message is only marked read when you read it with `sparrow inbox`, with `sparrow inbox --wait`, or in the envelope
Sparrow hands you at the start of a call. Every other command prints a one-line notice on stderr, last, when you have
unread mail: `📨 2 unread for @captain: @maya result(ok), @leo question. Read: sparrow inbox`.
<!-- /messaging -->

A result looks like this:

```text
── @maya · builder · done ok · call 6m12s ──
## Result    Sliding-window limiter on POST /login, keyed by IP (src/auth/limit.ts).
## Evidence  bun test test/server/ → 48 pass, 0 fail, including "6th attempt returns 429"
## Files     src/auth/limit.ts, src/routes/login.ts, test/auth/limit.test.ts
## Next      Counts live in memory. Move them to Redis before you run two instances.
```

## Answer a question

An agent that is stuck runs `sparrow ask`. Its window closes and the question reaches you as a `question` message.
Answer with a DM and it wakes up on the same session:

```sh
sparrow send @maya "Use Redis, not memory. REDIS_URL is in .env."
```

## Follow up with a finished agent

A `done` ends the call, not the agent. Message a finished agent days later and Sparrow reopens its saved harness
session, so you skip re-explaining the codebase.

```sh
sparrow send @maya "The 429 body should be JSON: {\"error\":\"rate_limited\"}."
```

What the agent remembers depends on its harness. Sparrow reopens the session; compaction and context limits stay the
harness's business.

## Verify with a verifier

Do not trust a result because it sounds sure. Hire a read-only verifier and hand it the builder's evidence and the
acceptance checks.

```sh
sparrow hire verifier - <<'EOF'
Verify @maya's rate limiter. Run `bun test test/server/` and hit POST /login seven times.
Report a PASS/FAIL table, one row per acceptance check, with the command and real output.
Acceptance: 5 attempts succeed, the 6th returns 429, a different IP is not limited.
EOF
```

Send each failure back to the builder with `sparrow send @maya "..."`. Repeat until the table is all PASS.

## Release

When the work is verified and merged, release the agents:

```sh
sparrow release @maya
sparrow release @leo
```

Release is permanent on purpose. A released agent closes its window, drops its unread mail and never wakes again.
New work goes to a fresh hire, so old context cannot leak into a new job. Order matters: build, verify, merge,
release. A released builder cannot take a fix.

## Watch

Two ways to see what the crew is doing:

- **tmux.** Each agent is a window named after its handle. For the first captain in a project:
  `tmux attach -t sparrow-<project>`. For any other captain: `tmux attach -t sparrow-<project>-<captain handle>`.
  `sparrow status` prints the exact lines. If you set `SPARROW_TMUX_SOCKET`, add `-L <socket>`.
- **The UI.** Captains, each captain's activity feed and team tree (with a live peek at every agent's screen), the
  board, the resume editor, skills, settings and the doctor.

## Next

- [Concepts](concepts.md): the words used above, one short section each.
- [CLI reference](cli.md): every command and flag.
- [Configuration](configuration.md): limits, env vars, resume files.
- [Troubleshooting](troubleshooting.md): when something goes quiet.
- [SECURITY.md](../SECURITY.md): read it before you point a crew at anything you love.
