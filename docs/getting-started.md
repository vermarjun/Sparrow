# Getting started

This page takes you from nothing to a finished, verified first hire. It takes about ten minutes, plus the time your
first agent spends working.

## Prerequisites

| You need | Why | How to check |
|---|---|---|
| macOS or Linux (arm64 or x64) | Sparrow runs agents in tmux windows. On Windows, use WSL2 and install inside it. | `uname -sm` |
| tmux | Every agent gets its own tmux window. | `tmux -V` |
| One logged-in harness | Agents are the real Claude Code, Codex or OpenCode. Sparrow adds no model access of its own. | see below |

You do not need Bun, Node or a clone of the repo: the install routes below give you one self-contained binary. Bun is
only for running from source.

Sparrow checks that `tmux -V` runs. It enforces no minimum tmux version, and none has been verified, so use a recent
one. macOS is the most used platform. Linux was verified end to end in a Debian container on arm64; file an issue if
your distro misbehaves.

You need at least one of these, logged in. Check each one you plan to use:

```sh
claude auth status       # Claude Code
codex login status       # Codex
opencode auth list       # OpenCode
```

Sparrow never logs in for you. Each agent uses the login its harness already
has, so your plan's usage limits still apply.

## Install

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

The install script downloads the binary for your OS and CPU from the GitHub Release, verifies its SHA-256 checksum,
and puts it in `~/.local/bin/sparrow`. It tells you if that directory is not on your `PATH` and which command
installs tmux if you lack it. Two variables tune it: `SPARROW_VERSION=0.2.0` pins a version (the default is the latest
release) and `SPARROW_INSTALL_DIR=<dir>` changes the target folder. The npm package is a small launcher plus one
platform package, so keep optional dependencies enabled. The Homebrew formula comes from the `vermarjun/tap` tap.

### From source

Do this if you want to hack on Sparrow. You need [Bun](https://bun.sh) and tmux.

```sh
git clone https://github.com/vermarjun/Sparrow.git
cd Sparrow
bun install
(cd web && bun install)
bun bin/sparrow install
```

From source, setup does not run by itself: run `bun bin/sparrow install` once. It is idempotent. It creates
`~/.sparrow`, seeds the default resumes (it never overwrites ones you edited, and never brings back ones you deleted),
links `~/.local/bin/sparrow` to your checkout, copies the `sparrow-captain` and `sparrow-worker` skills into
`~/.claude/skills` and `~/.codex/skills`, installs the harness plugins, builds the UI, and reports which binaries it
found. Make sure `~/.local/bin` is on your `PATH`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the rest of the
developer setup, and [Configuration](configuration.md#what-install-writes) for everything setup writes.

## First run

```sh
sparrow
```

With no arguments, `sparrow` starts the server detached if it is not running, waits for the UI, opens it in your
browser and returns. The server listens on `http://127.0.0.1:4040`. Run it again any time: it just reopens the UI.

**The first run sets itself up.** The installed binary notices it has not been set up yet (and again after an
upgrade), creates `~/.sparrow`, seeds the resumes, links itself into `~/.local/bin` when no other `sparrow` is on your
`PATH`, installs the skills and plugins, and unpacks its UI into `~/.sparrow/app/<version>/`. Then it prints a short
readiness check:

```text
✓ tmux /usr/bin/tmux
✓ claude installed, login found
- codex not installed (npm i -g @openai/codex   (or: brew install codex))
! opencode installed, no login found (opencode auth login)
Hireable now: advisor, builder-codex, builder, deckhand, sub-captain, verifier
Needs another harness/login: presenter (opencode), researcher (opencode)
Seeded on a fallback harness: builder-codex, verifier. They stay there if you install the missing harness later; ...
Next: open the UI, Run doctor (live check), then Start captain.
```

`✓` is good, `!` needs a login or a fix, a dash is a harness that is not installed, `✗` is missing tmux (with the command that installs it).
The login line is a static hint: it looks for credentials on disk or in the environment, it does not test them. The
doctor does the live test.

**A missing harness is not a dead end.** When setup seeds the default resumes, any role whose harness you do not have
is rewritten onto one you do. Only the frontmatter changes. The order is Claude Code, then Codex, then OpenCode. A
Claude target keeps the role's own `opus`, `sonnet` or `haiku` alias, or uses `sonnet`; Codex and OpenCode targets use
the harness default model. Setup prints a line per rewrite, for example
`verifier: codex not installed -> seeded on claude · sonnet`. Those resumes stay where they were seeded even if you
install the missing harness later. To reseed one, delete `~/.sparrow/resumes/<name>.md` and run `sparrow install`.
With no harness installed at all, resumes are left as shipped. With none installed and logged in, the readiness check says
`Hireable now: none`.

```sh
sparrow status     # server health, working agents, tmux attach lines
sparrow stop       # stop the server (live agent windows are adopted back on the next start)
```

On Linux, Sparrow tries `xdg-open`, `gio` or `sensible-browser`, but only when a desktop session is present
(`DISPLAY` or `WAYLAND_DISPLAY`). On a headless box, in a container or over SSH it prints `Open http://127.0.0.1:4040 in
your browser.` instead. Set `SPARROW_NO_OPEN=1` to never open a browser. If the browser does not open, open the URL
yourself. The server log is `~/.sparrow/server.log`.

If the running server is an older version than the binary you just upgraded to, `sparrow` says so. Run `sparrow stop`,
then `sparrow`, to move to the new one.

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
Context: the routes are in src/api/; tests live in test/api/.
Acceptance: `bun test` is green, including a test that the 6th attempt gets a 429.
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

A result looks like this:

```text
── @maya · builder · done ok · call 6m12s ──
## Result    Sliding-window limiter on POST /login, keyed by IP (src/api/limit.ts).
## Evidence  bun test → 41 pass, 0 fail, including "6th attempt returns 429"
## Files     src/api/limit.ts, src/api/login.ts, test/api/limit.test.ts
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
Verify @maya's rate limiter. Run `bun test` and hit POST /login seven times.
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

## Uninstall

Stop the server first, then uninstall:

```sh
sparrow stop
sparrow uninstall            # removes what install wrote: the link, skills, plugins, the app dir
sparrow uninstall --purge    # the same, and deletes ALL of ~/.sparrow: database, resumes, agents
```

`sparrow uninstall` refuses while a server is running and tells you to stop it. Without `--purge` your data stays:
the database, your resumes and your agents' folders. It removes the `~/.local/bin/sparrow` link only when it points
at a sparrow, and keeps it otherwise. It does not remove a binary you installed with npm or Homebrew: use
`npm rm -g sparrow-agents` or `brew uninstall sparrow` for that, and `rm ~/.local/bin/sparrow` for the install script.
It does not touch your harnesses or their logins.

## Next

- [Concepts](concepts.md): the words used above, one short section each.
- [CLI reference](cli.md): every command and flag.
- [Configuration](configuration.md): limits, env vars, resume files.
- [Troubleshooting](troubleshooting.md): when something goes quiet.
- [SECURITY.md](../SECURITY.md): read it before you point a crew at anything you love.
