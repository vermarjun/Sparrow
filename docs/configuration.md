# Configuration

Three layers decide how Sparrow behaves. Later layers win:

1. Built-in defaults ([`src/shared/config.ts`](../src/shared/config.ts)).
2. `$SPARROW_HOME/config.json`, written by the **Settings** page of the UI.
3. The `SPARROW_SETTINGS` environment variable (a JSON object), meant for tests and sandboxes. Keys set this way show
   as read-only in the UI.

## Settings

Edit these on the **Settings** page (`#/settings`) or by hand in `config.json`. Changes through the UI apply at
once, with no restart. Values must be whole numbers inside the range shown.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `max_running` | 3 | 1 to 50 | Agents that may work at the same time across all projects. Extra hires queue. An agent parked on `ask` or `wait` holds no slot. |
| `max_running_per_captain` | 0 | 0 to 64 | Most agents one captain's crew may run at once, so one busy captain cannot take every slot. 0 means no per-crew cap. |
| `max_depth` | 3 | 1 to 10 | How deep the hiring tree may grow. You are level 0: you, sub-captain, builder, helper. |
| `quiet_minutes` | 15 | 1 to 240 | A working agent silent this long is nudged to post an update. A resume's own `limits.quiet_minutes` wins. |
| `max_call_minutes` | 90 | 1 to 1440 | The parent is told once when one call runs this long. Nothing is killed. A resume's own limit wins. |
| `max_nudges` | 2 | 0 to 10 | Reminders per call when an agent stops without reporting. After these the call ends as `unreported`. |
| `max_restarts` | 1 | 0 to 10 | Automatic restarts after a crash before the agent is marked `crashed`. |
| `provider_error_threshold` | 3 | 1 to 100 | Consecutive provider errors that mark a harness and provider as degraded. Informational: it never blocks hiring. |
| `provider_error_window_minutes` | 15 | 1 to 1440 | The errors above must fall within this many minutes. |
| `close_grace_ms` | 8000 | 0 to 120000 | Delay between a report (`done`, `ask`, `wait`) and closing the agent's tmux window. |
| `watchdog_ms` | 5000 | 500 to 60000 | How often the server checks that working agents are alive and within limits. |
| `snapshot_ms` | 10000 | 1000 to 600000 | How often the screens of working agents are captured for the UI. Held in memory only. |
| `fresh_fallback_ms` | 20000 | 0 to 600000 | A resumed call that dies within this window restarts with a fresh session instead. |
| `doctor_timeout_ms` | 90000 | 5000 to 600000 | Per-harness cap for the doctor's live hire-and-report check. |
| `doctor_models` | `{}` | n/a | Per-harness model the doctor should use (`claude`, `codex`, `opencode`), instead of the cheapest it finds. |
| `skills_dir` | `~/Skills` | n/a | Your skills library folder. See [Skills library and grants](#skills-library-and-grants). |

`config.json` keeps keys it does not know about. A minimal file:

```json
{ "max_running": 5, "quiet_minutes": 20, "doctor_models": { "claude": "haiku" } }
```

You can also start a server with a different slot count for one run: `sparrow up --max-running 5`.

## Environment variables

Set these in the shell that runs `sparrow` (or before starting the server). Every one is optional.

| Variable | Default | Meaning |
|---|---|---|
| `SPARROW_HOME` | `~/.sparrow` | Where all state lives. Point it elsewhere to run a separate Sparrow. |
| `SPARROW_PORT` | `4040` | Server port. The server always binds `127.0.0.1`. |
| `SPARROW_URL` | `http://127.0.0.1:$SPARROW_PORT` | Server URL the CLI talks to. |
| `SPARROW_SETTINGS` | unset | JSON object of settings that override `config.json`. |
| `SPARROW_TMUX_SOCKET` | unset (your default tmux server) | Use `tmux -L <socket>`. Isolates Sparrow's windows from your own tmux. |
| `SPARROW_TMUX_PREFIX` | `sparrow-` | Prefix of Sparrow's tmux session names. |
| `SPARROW_CLAUDE_BIN` | `claude` on `PATH`, else `~/.local/bin/claude` | Claude Code executable. |
| `SPARROW_CODEX_BIN` | `/opt/homebrew/bin/codex` | Codex executable. Set it if yours lives elsewhere. |
| `SPARROW_OPENCODE_BIN` | `~/.opencode/bin/opencode` | OpenCode executable. Set it if yours lives elsewhere. |
| `SPARROW_CLAUDE_JSON` | `~/.claude.json` | Claude Code's global state file, where Sparrow pre-accepts project trust. |
| `SPARROW_CAPTAIN_ID` | unset | Pin a terminal session to one captain (id or handle). Needed for OpenCode when a project has several. |
| `SPARROW_SKILLS_DIR` | `skills_dir` setting, else `~/Skills` | Skills library folder. |
| `SPARROW_SKILLS_HOME` | unset | Fence all skill and harness-folder writes under this directory. Used by sandboxes and tests. |
| `SPARROW_WEB_DIR` | `<checkout>/web` | Where the UI package lives. Mostly for tests. |
| `SPARROW_SKIP_WEB_BUILD` | unset | `1` makes `sparrow install` skip the UI build. Tests only. |
| `SPARROW_GIT_TIMEOUT_MS` | `60000` | Timeout for skills-library `git pull` and `push`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps config and skills. Sparrow follows it. |
| `CODEX_HOME` | `~/.codex` | Where Codex keeps config and skills. Sparrow follows it. |
| `XDG_CONFIG_HOME` | `~/.config` | Base of OpenCode's skills folder. |

Variables that start with `SPARROW_AGENT_`, `SPARROW_CALL_ID`, `SPARROW_WINDOW` and `SPARROW_HARNESS` are set by
Sparrow inside agent windows. Do not set them yourself. `SPARROW_AGENT_URL` tells an agent which server spawned it,
so an agent keeps reporting to the right one even if your port changes later.

## Where state lives

Everything is under `$SPARROW_HOME` (default `~/.sparrow`).

| Path | What it holds |
|---|---|
| `sparrow.db` | SQLite: agents, calls, messages and deliveries, projects, tickets. Plaintext. |
| `config.json` | Your saved settings. |
| `server.pid` | `{"pid","port","started_at"}` of the running server. |
| `server.log` | stdout and stderr of the detached server. First place to look when something is off. |
| `resumes/` | Your editable resume files. `resumes/.deleted/` holds recoverable deleted ones and tombstones. |
| `agents/<id>/` | Per-agent files: `system.md`, per-call prompt and launch scripts, settings, skill links. |
| `captains/` | Launch scripts for captains started with `sparrow captain`. |
| `claude-plugin/` | Sparrow's skills as a Claude Code plugin, used by spawned Claude agents. |
| `opencode/plugins/sparrow.js` | The OpenCode plugin that reports idle and errors. |

Outside `$SPARROW_HOME`, `sparrow install` writes `~/.local/bin/sparrow`, and copies `sparrow-captain` and
`sparrow-worker` into `~/.claude/skills` and `~/.codex/skills`. At runtime Sparrow also edits `~/.claude.json` to
pre-accept project trust for Claude Code windows.

## Resume files

A resume is `$SPARROW_HOME/resumes/<slug>.md`: YAML frontmatter, then the role's system prompt. The filename is the
slug (lowercase letters, digits and `-`, starting with a letter, at most 32 characters). If a slug exists in your
folder it wins over the version shipped with Sparrow.

```markdown
---
name: builder
title: Builder
description: Implements one task end to end ({{runtime}}).
harness: claude
model: opus
effort: high
can_hire: [deckhand, advisor]
limits: { quiet_minutes: 15, max_call_minutes: 90 }
skills: [verification-before-completion]
---
You are a senior software engineer. You own ONE task end to end...
```

| Field | Meaning |
|---|---|
| `name` | Written for readability. The filename supplies the slug. |
| `title` | Display name. Defaults to the slug. |
| `description` | One line shown in `sparrow resumes` and the UI. May use the template variables below. |
| `harness` | `claude`, `codex`, `opencode` (or `fake`, for tests). Anything else becomes `claude`. |
| `model` | Model name as the harness spells it, no spaces or quotes. `null` or omitted means the harness default. |
| `effort` | Effort level as the harness spells it. `null` or omitted means the harness default. |
| `can_hire` | List of resume slugs this role may hire, or `['*']` for any. Empty means nobody. |
| `limits.quiet_minutes` | Quiet-nudge threshold for this role. Falls back to the `quiet_minutes` setting. |
| `limits.max_call_minutes` | Long-call notice for this role. Falls back to the `max_call_minutes` setting. |
| `skills` | Skills from your library to grant this role. |
| `helper` | `true` makes the role a leaf: it can never hire, whatever `can_hire` says. |
| `one_shot` | `true` retires the agent on its first recorded `done`. |

Body text may use `{{harness}}`, `{{model}}`, `{{effort}}` and `{{runtime}}` (for example `claude · opus · effort
high`). They are filled in from the live resume, so a description does not go stale when you change the model.

Edit a resume in the UI (**Resumes**, with a Test button and an Apply button) or in any editor. Applying a resume change that
switches an agent's harness clears that agent's saved session. A resume marked **UNUSABLE** in the UI has a
problem the doctor can name: fix it before hiring.

## Skills library and grants

Sparrow keeps two kinds of skills apart:

- **Its own two**, `sparrow-captain` and `sparrow-worker`. Always granted, and a skill of the same name in your
  library cannot replace them.
- **Your library**, a folder of skill directories (each with a `SKILL.md`). Default `~/Skills`. Move it with the
  `skills_dir` setting or `SPARROW_SKILLS_DIR`. The **Skills** page scans the library and each harness's own skill
  folders, shows which resume uses what, and handles import, adopt and git status. There is no `sparrow skills`
  command.

Harness skill folders Sparrow knows about: `~/.claude/skills` (read by Claude Code and OpenCode), `~/.codex/skills`,
`~/.config/opencode/skills`, `~/.agents/skills`.

Grants are per resume, in its `skills:` list. A snapshot is stored at hire and apply time, and each launch re-checks
the real paths and links the skills into that agent's private launch folder. A name that does not exist produces a
warning on the hire, not a failure.

This isolates skill discovery, not the machine. Project skills and a harness's bundled skills can still appear, Codex
links your real auth and config into its per-agent home, and OpenCode inherits your global config. An agent can read
any file your user can. See [SECURITY.md](../SECURITY.md).
