# CLI reference

Every command, grouped. Run `sparrow help` for the list and `sparrow help <command>` (or `sparrow <command> --help`)
for one usage line.

## Conventions

**Text arguments and `-`.** Any text argument can be `-`, which reads stdin. Use a quoted heredoc so quotes, `$` and
backticks pass through untouched:

```sh
sparrow done - <<'EOF'
## Result
Fixed the login redirect.
EOF
```

Text that starts with `-` ("- fixed the bug", "-5 tests failing") is accepted as text. Something shaped exactly like
an unknown flag (`--bogus`) is a usage error; put it after `--` or pass it with `-`.

**`--json`.** Global, allowed anywhere before a literal `--`. Prints the raw server response instead of text. List
responses (`captains`, `roster`, `resumes`, `card list`, `log`) are bare arrays.
<!-- messaging: verify against oss/protocol -->
Object responses carry an `unread` list.
<!-- /messaging -->

**Exit codes.**

| Code | Meaning |
|---|---|
| 0 | Success. `help` and `--version` always exit 0. |
| 1 | The command failed: server error, refused action, server unreachable. `sparrow status` also exits 1 when no server answers. |
| 2 | Usage error (bad flag, missing argument) or unknown command. |

**Identity.** Inside an agent window, `SPARROW_AGENT_ID` is set and every command acts as that agent. Anywhere else,
the first identity-needing command registers the shell's session as a captain of the project. Read-only project
commands (`captains`, `captain resume`, `card list`, `card show`) never register one, so looking around does not
make you a captain.

**Server.** Commands talk to `http://127.0.0.1:4040` unless `SPARROW_PORT` or `SPARROW_URL` say otherwise. See
[Configuration](configuration.md#environment-variables).

<!-- messaging: verify against oss/protocol -->
**Unread mail.** Commands other than `inbox` do not consume your messages. When you have waking or quiet mail
waiting they print a last line on stderr, so `>/dev/null` or `| tail` cannot swallow it:

```text
📨 2 unread for @captain: @ada result(ok), @leo question. Read: sparrow inbox
```

`done`, `ask` and `wait` refuse while waking messages are unread, naming the senders.
<!-- /messaging -->

## Server

| Command | What it does |
|---|---|
| `sparrow` | Start the server detached if needed, wait for the UI, open it, return. |
| `sparrow up` | Run the server in the foreground. |
| `sparrow stop` | Stop the server of this `SPARROW_HOME` and port. |
| `sparrow install` | Seed resumes, link the CLI, install skills and harness assets, build the UI. |
| `sparrow status` | Server health, working agents, tmux attach lines. |
| `sparrow help [command]` | Usage. |
| `sparrow --version` | Print `sparrow <version>`. |

**`sparrow up [--port N] [--home DIR] [--max-running N] [--tmux] [--sandbox]`**

| Flag | Meaning |
|---|---|
| `--port N` | Port to listen on (1 to 65535). Default 4040 or `SPARROW_PORT`. |
| `--home DIR` | Must equal `SPARROW_HOME`. It exists so the home shows in `ps`. |
| `--max-running N` | Override the running-slots setting for this server (1 to 64). |
| `--tmux` | Run the server in tmux session `sparrow`, window `server`, and print the attach line. |
| `--sandbox` | Required for an agent that starts a throwaway server. Needs a non-default `SPARROW_HOME` and never port 4040. |

```sh
sparrow up --port 4041 --max-running 5
```

**`sparrow stop [--sandbox]`** stops only the server that owns this `SPARROW_HOME` and port, and refuses when the
listener's command line does not confirm both. Agents may run it only with `--sandbox` against a non-default home.

**`sparrow install [--force]`** is idempotent. `--force` rebuilds the UI and replaces the `~/.local/bin/sparrow` link
even if it points elsewhere. It never overwrites a resume you edited.

```sh
sparrow install
```

**`sparrow sandbox up [--dir path]` and `sparrow sandbox down [--dir path]`** create and tear down a throwaway
server with its own home, a free port (never 4040), its own tmux socket and its own skills home. Allowed for agents
and humans. Use it to try things without touching your real Sparrow.

```sh
sparrow sandbox up --dir .sandbox/try1
sparrow sandbox down --dir .sandbox/try1
```

## Captains

| Command | What it does |
|---|---|
| `sparrow captain` | Launch a new Claude Code captain in tmux. |
| `sparrow captain resume <@handle\|id>` | Reopen an existing captain on its saved session. |
| `sparrow captain adopt <@handle>` | Bind the current harness session to an existing captain. |
| `sparrow captains [--all]` | This project's captains. |
| `sparrow title <text>` | Name the current captain's work. |
| `sparrow whoami` | Who you are: handle, project, title, fleet, resume line. |

**`sparrow captain [--cwd dir] [--name n] [--title "<what it works on>"] [--model m] [--effort e]`** launches Claude
Code only, and only for you: agents cannot start captains.

```sh
sparrow captain --cwd ~/code/myrepo --name orion --title "Rate limiting for login"
```

**`sparrow captain resume @cap-orion`** reopens a captain in tmux. The handle is looked up in the project of your
current directory, so run it from the captain's repo, or pass the id (`ag_...`) from anywhere.

**`sparrow captain adopt @cap-orion`** takes an old identity back after Claude Code gave the same process a new
session (for example after `/clear`, when the first command prints `a new captain`). Run it inside the session you
want to bind.

**`sparrow captains [--all]`** shows handle, title, status, team (working/total), last activity and the line that
reopens each captain. `--all` adds archived captains and untitled, team-less sessions.

```sh
sparrow title "Rate limiting for login"
```

## Hiring

| Command | What it does |
|---|---|
| `sparrow resumes` | The role directory. |
| `sparrow roster [--all]` | Agents in your crew; `--all` includes retired ones. |
| `sparrow hire <resume> <task>` | Hire an agent. |
| `sparrow release <@handle>` | Retire an agent permanently. |

**`sparrow hire <resume> "<task>" [--name h] [--cwd d] [--tmux-session s] [--tmux-window w] [--card N] [--model m] [--effort e]`**

| Flag | Meaning |
|---|---|
| `--name h` | Handle for the agent. Optional; friendly names are picked for you. |
| `--cwd d` | Where the agent works. Default: your current directory. Must exist. |
| `--tmux-session s` | tmux session for its window. Default `sparrow-<project>` (or `sparrow-<project>-<captain handle>`). |
| `--tmux-window w` | Window name. Default: the handle. |
| `--card N` | Assign ticket `N` (`12`, `#12` or `KEY-12`), move it to In progress, give the agent the whole ticket. |
| `--model m`, `--effort e` | Override the resume. Only when you mean to: the resume holds your own choice. |

```sh
sparrow hire builder - --name maya --card 12 <<'EOF'
Goal: ...
EOF
```

A hire the running-slot limit cannot start yet shows `queued`.

**`sparrow release @maya`** closes the agent's window and retires it for good. The parent or the root captain of the
same crew may release.

## Messaging

| Command | What it does |
|---|---|
| `sparrow send <@handle> <text> [--card N]` | DM someone in your own crew. |
| `sparrow update <text> [--card N]` | Quiet progress note to your parent. |
| `sparrow ask <question>` | Ask your parent and end the call as waiting. |
| `sparrow done <summary> [--status ok\|blocked\|failed]` | Report to your parent and end the call. |
| `sparrow wait [reason]` | Park the call until a waking message arrives. |
| `sparrow inbox [--wait SEC] [--last [N]]` | Read your messages. |
| `sparrow log [@handle] [-n 30]` | Message history for the project. |

```sh
sparrow send @maya "Use Redis, not memory."
sparrow update "limiter done; writing tests next"
sparrow ask "Should the limit be per IP or per account?"
sparrow done --status blocked - <<'EOF'
## Result
Blocked: REDIS_URL is not set.
EOF
sparrow wait "waiting on @maya and @leo"
```

`group` is a reserved handle: `send` and `log` reject it. `--card N` on `send` and `update` links the message to that ticket.

<!-- messaging: verify against oss/protocol -->
**`sparrow inbox`** reads and consumes your pending messages.

| Flag | Meaning |
|---|---|
| `--wait SEC` | Block until a waking message arrives or `SEC` seconds pass (0 to 600). A newer `inbox --wait` stops an older one. |
| `--last [N]` | Re-read the last `N` delivered messages (1 to 50, default 10). Consumes nothing new. |

```sh
sparrow inbox --wait 600
sparrow inbox --last 5
```

Never run `inbox --wait` inside an agent window. Use `sparrow wait` and stop.

**`done`, `ask` and `wait`** refuse while waking messages are unread. They say who sent them and tell you to run
`sparrow inbox`. Read the mail, act on it, then run the command again with your complete report.
<!-- /messaging -->

**`sparrow log [@handle] [-n 30]`** prints the last `n` messages of the project (1 to 10000), or only those to or from
`@handle`. It is read-only and shows messages whether or not they were consumed.

## Board

Tickets are keyed `KEY-N`, where `KEY` is a short prefix derived from the project name and `N` is a number that is unique across projects. Every `card` command also takes `N` or `#N`. Plain
`sparrow card` means `card list`.

| Command | What it does |
|---|---|
| `sparrow propose <title> [ticket flags]` | Propose a ticket for a captain to triage. |
| `sparrow card list` | List tickets. |
| `sparrow card show <N> [--json]` | Full ticket. |
| `sparrow card pick <N>` | Assign it to yourself, move to In progress, print the brief. |
| `sparrow card add <title> [ticket flags]` | Add a ticket. |
| `sparrow card edit <N> [ticket flags]` | Edit fields. |
| `sparrow card move <N> <state>` | Move to `proposed`, `todo`, `in_progress`, `review`, `done` or `dropped`. |
| `sparrow card assign <N> <@handle\|me\|none>` | Set or clear the assignee. |
| `sparrow card note <N> <text>` (alias `comment`) | Add a comment. |
| `sparrow card block <N> <who/what>` and `unblock <N>` | Set or clear "waiting on". |
| `sparrow card later <N> [--undo]` | Shelve or restore. |
| `sparrow card urgent <N> [--undo]` | Mark or clear urgent. |
| `sparrow card check <N> <i> [--undo]` | Tick or untick "Done when" item `i` (1-based). |

**Ticket flags** (`propose`, `card add`, `card edit`):

| Flag | Meaning |
|---|---|
| `--context c`, `--problem p`, `--approach a` | The three prose sections. |
| `--check "..."` | One "Done when" item. Repeat for more (2 to 7 is the sweet spot). |
| `--category c`, `--tag t` | One lowercase category; repeatable tags. |
| `--impact` (or `--return`) `low\|medium\|high`, `--effort low\|medium\|high` | Drive the payoff label and sorting. |
| `--estimate 2h` | Your honest estimate (`90m`, `2h`, `1d`). |
| `--urgent` | Only if it blocks someone now. On `card edit`, use `--urgent on\|off`. |
| `--blocked "who/what"` | Waiting on a person. On `card edit`, `--blocked off` clears it. |
| `--details d` | Free text that fits no section. |

`card add` also takes `--state s` and `--assignee @h`. `card edit` also takes `--title t` and `--later on|off`, and
`none` clears impact, effort, estimate and category.

**`card list`** takes `--state s`, `--sort newest|oldest|urgent|roi|impact|effort|estimate|updated`,
`--category c`, `--urgent`, `--blocked`, and `--all` (adds dropped tickets).

```sh
sparrow propose "Show estimate vs actual on done cards" \
  --problem "Observed: a Done card shows no timing. Expected: estimate next to real time." \
  --check "A done card shows its estimate" --impact high --effort low --estimate 4h
sparrow card list --state review --sort roi
sparrow card move KEY-12 review
```

## Hook (internal)

`sparrow hook <kind>` is called by the harnesses (Claude Code Stop hook, Codex notify, OpenCode plugin) to tell the
server a turn ended. You never run it. It never breaks a harness: if its module is missing it prints to stderr and
exits 0.
