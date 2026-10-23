# Concepts

The words Sparrow uses, one short section each. If a term in the CLI or UI confuses you, it is probably here.

## Captain

The captain is the coding session you talk to: Claude Code, Codex or OpenCode in your terminal. The first `sparrow`
command a session runs registers it as a captain of the project. A captain plans, hires, reviews and integrates. It
is never spawned by Sparrow (except through `sparrow captain`, which opens a Claude Code captain in tmux for you).

Internally the captain is an agent row of kind `human`, at depth 0, allowed to hire any resume. "Human" is the
server's name for the kind. The session itself can be an AI.

## Crew and agents

An agent is a named worker: a handle like `@maya`, a resume, a harness, a model, an effort, a working folder and a
parent. Its identity outlives any single terminal window. The crew is the set of agents a captain has hired.

## Resumes

A resume is a Markdown file that defines a role: harness, model, effort, who the role may hire, call limits, skills
and the system prompt. You hire from resumes (`sparrow hire builder ...`). Eight ship by default:

| Slug | Harness | Model | What it is for |
|---|---|---|---|
| `builder` | Claude Code | opus | Implement one task end to end and prove it works. |
| `builder-codex` | Codex | gpt-6.1-sol | The same role on Codex. |
| `verifier` | Codex | gpt-6.1-sol | Read-only, adversarial acceptance checks. |
| `researcher` | OpenCode | opencode-go/kimi-k3 | Web and code research with cited findings. |
| `presenter` | OpenCode | opencode-go/glm-5.3 | A single-file HTML explainer or deck. |
| `sub-captain` | Claude Code | opus | Own a slice of work and hire its own builders. |
| `deckhand` | Claude Code | haiku | Cheap, mechanical, one-shot chores. |
| `advisor` | Claude Code | opus | A read-only second opinion on one question. |

Model names are defaults, not a promise that your account offers them. Edit them in the UI (**Resumes**) or in the
files under `~/.sparrow/resumes/`. See [Configuration](configuration.md#resume-files) for the file format.

## Calls

A call is one working execution of an agent: its own id, start and end time, prompt, and tmux window. An agent has
many calls over its life. The first call starts a new harness session. A later call reopens the saved session, so the
agent remembers the earlier work. `done`, `ask` and `wait` all end the current call.

"Remembers" means Sparrow asks the harness to reopen its session. How much the model keeps is the harness's call.

## Messages

<!-- messaging: verify against oss/protocol -->
Every message is stored in SQLite, with one delivery row per recipient. Messages come in two strengths:

| Kind | Examples | Effect |
|---|---|---|
| Waking | task, DM, question, result, action-needed system notice | Starts or resumes the recipient, and interrupts a wait. |
| Quiet | progress update, waiting status, FYI notices | Never wakes anyone. Rides along with the next read. |

A message is consumed only by an explicit read: `sparrow inbox`, `sparrow inbox --wait SEC`, the envelope Sparrow
hands an agent at the start of a call, or the handoff at the end of a turn (a Claude Code Stop hook block reason, or
text typed into a Codex or OpenCode window). If the spawn or the paste fails, the delivery goes back to pending.

Every other command only prints a notice to stderr, last, so redirecting or trimming output cannot swallow a
message:

```text
📨 2 unread for @captain: @ada result(ok), @leo question. Read: sparrow inbox
```

`--json` objects carry an `unread` list. `done`, `ask` and `wait` refuse while waking messages are unread. They name
the senders and tell you to run `sparrow inbox`. That is the "Not sent: new messages arrived" you may see in an agent
window.
<!-- /messaging -->

Sparrow persists every message. It does not promise that a model reads every message, only that you can always
re-read history (`sparrow inbox --last`, `sparrow log`).

## Inbox

Your pending deliveries, oldest first. `sparrow inbox` reads them. `sparrow inbox --wait 600` blocks until a waking
message arrives, or up to 600 seconds. On timeout it shows a `Still working:` digest: each active child and its
latest update. `sparrow inbox --last 20` re-reads the last delivered messages without consuming anything new.

## Results

An agent ends a call with `sparrow done`, and the summary has four sections:

| Section | Holds |
|---|---|
| Result | What was delivered, in two to five lines. |
| Evidence | The commands run and their real output. |
| Files | Paths created or changed. |
| Next | Open issues, risks, follow-ups, or "none". |

`done` takes `--status ok|blocked|failed`. The captain reads four short sections instead of a 3,000-line diff.

## Board and tickets

The board is a per-project list of tickets in six states: `proposed`, `todo`, `in_progress`, `review`, `done`,
`dropped`. Agents `propose` tickets, captains accept or drop them, you triage from the UI. A ticket has a context,
a problem, an approach, "Done when" checks, impact, effort and an estimate. Impact times effort gives a payoff label:
Quick win, Worth it, Big bet, Heavy lift or Money pit.

The board only tracks. Moving a card never hires or messages anyone. `sparrow hire --card N` is the exception that
links the two: it assigns the card, moves it to `in_progress` and gives the agent the whole ticket. A successful
`done` moves that card to `review`. Only you move cards to `done`.

## Projects and worktrees

A project is the git root of the directory where a captain runs. Linked git worktrees resolve to the same project
as their main checkout, so every worktree of a repo shares one board. A directory outside any git repo is a project
of its own. Sparrow never creates worktrees. A captain can make one and pass `--cwd` to a hire. `--cwd` only sets
where the agent works; it never changes the project.

## Multi-captain and private crews

Several captains can work in one project at once, typically one per feature or worktree. Each has a private crew:
`sparrow roster` lists only you and your hires, and you cannot message, release or reassign another captain's
agents. The board is shared. Results, questions and updates from your hires reach only you.

## Sub-captains

A sub-captain is an ordinary agent whose resume lets it hire other non-helper roles. Its crew stays in the root
captain's fleet. It runs `sparrow wait` while its builders work, and their results wake it. Hiring depth is capped
(default 3).

## Helpers: deckhand and advisor

A resume with `helper: true` is a leaf: it can never hire, whatever its `can_hire` says. Two ship by default. The
**deckhand** (Haiku) does mechanical work against an exact spec and bounces anything that needs judgment. The
**advisor** (Opus) answers one question, read-only. Builders can hire both.

## One-shot

A resume with `one_shot: true` retires the agent on its first recorded `done`, including `blocked` and `failed`
reports. Later sends to it are rejected. Follow-up needs a new hire. Only the deckhand ships with this flag. Its
context never grows and never leaks.

## Release

`sparrow release @handle` retires an agent for good: its window closes, its open call ends, its unread mail is
dropped and it never wakes again. History stays. Release is permanent by design. Only the parent or the root captain
of the same crew can release.

## Safety nets

Defaults live in [`src/shared/config.ts`](../src/shared/config.ts) and are tunable in `config.json` or the Settings
page. See [Configuration](configuration.md#settings).

| Net | Default behaviour |
|---|---|
| Stopped without reporting | Nudged through the harness's own hook up to 2 times per call, then the call ends as `unreported` and the parent is told. |
| Quiet agent | After 15 minutes without hearing from it (resume can override), it is nudged and the parent gets a quiet FYI. |
| Long call | After 90 minutes (resume can override), the parent is told once. Nothing is killed. |
| Crash | One automatic restart on the same session, then a crash notice with the last screen. |
| Resumed call dies fast | A resumed call that dies within 20 seconds restarts with a fresh session plus a bounded replay of recent messages. |
| Capacity | At most 3 agents work at once across projects. Extra hires queue. An agent parked on `ask` or `wait` holds no slot. |
| Depth | Hiring depth stops at 3: you, sub-captain, builder, helper. |
| Server restart | Live agent windows are adopted back. Dead ones become `crashed` and the parent is told. |
| Watchdog | Every 5 seconds the server checks that working windows are alive. |

## Skills

A skill is a folder with a `SKILL.md` that a harness loads on demand. Sparrow ships two: `sparrow-captain` (how to
run a crew) and `sparrow-worker` (how an agent reports). `sparrow install` copies them into `~/.claude/skills` and
`~/.codex/skills`, and every spawned agent gets them too. You can keep your own library (default `~/Skills`) and
grant skills per resume with the `skills:` list. This controls what a harness discovers. It is not an OS sandbox.
See [Configuration](configuration.md#skills-library-and-grants).
