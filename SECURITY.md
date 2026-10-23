# Security

Sparrow is a local tool for a single trusted user. It is not hardened to be exposed to a network or shared between
people, and it does not try to contain the agents it runs. Read this page before you point a crew at anything you
love.

## What Sparrow is

A server on your machine, listening on `127.0.0.1` (default port 4040) over plain HTTP. It starts Claude Code, Codex
and OpenCode as ordinary processes under your user account, in tmux windows, and passes messages between them. Treat
every task, resume, skill and harness it launches as code running with your own authority.

## What you should know

- **Workers auto-approve everything.** Agents start with their harness's permission bypass: Claude Code with
  `--dangerously-skip-permissions`, Codex with `--yolo`, OpenCode with `--auto`. They can run any command, read or
  change any file your user can, and use the network. Sparrow does not add a container, a separate OS account or a
  filesystem fence. A working folder, a `can_hire` list and prompt instructions steer behaviour. They do not enforce it.
- **No authentication.** The API has no login, password or token. An agent identifies itself with a header, and a
  known id is not a secret. Anything that can reach `127.0.0.1:4040` as any local user can read your messages, hire
  agents and edit resumes. Captain crews are private by convention and guard rails, not by a security boundary against
  local processes.
- **Loopback only.** The server binds `127.0.0.1` and there is no option to change that. Do not forward the port to a
  network or put a reverse proxy in front of it. On a shared machine, other users can reach loopback too.
- **Browser requests are checked, but that is CSRF protection, not authentication.** Writes from a browser must pass
  `Sec-Fetch-Site` and `Origin` checks and send JSON, so another website cannot drive your server through your
  browser. The CLI and hooks send none of those headers and pass.
- **Plaintext storage.** Messages, task text and results live unencrypted in `$SPARROW_HOME/sparrow.db`, and prompts,
  system prompts and launch scripts sit in `$SPARROW_HOME/agents/`. Live screens are captured in memory for the UI and
  for crash notices. Sparrow does not redact secrets. Do not paste credentials into briefs, and do not commit
  `~/.sparrow`.
- **Your harness config is linked in.** Codex agents get a private home that symlinks your real Codex auth, config,
  plugins and rules. OpenCode agents inherit your global OpenCode config and MCP settings. Sparrow edits
  `~/.claude.json` to pre-accept project trust for the folders it launches Claude Code in. Skill grants control
  skill discovery, not file access.
- **A captain is whatever you gave it.** The captain session is your own coding session, with the permissions you
  chose for it. Sparrow only gives it a CLI.

## What Sparrow does not protect against

- A malicious or confused agent doing damage with your user's permissions (deleting files, pushing code, reading
  secrets, calling APIs with your keys).
- A prompt injection that reaches an agent through a web page, a file or a ticket and talks it into doing the same.
- Another local process or user talking to the API.
- Anyone with read access to your home directory reading the database or agent folders.
- Messages being lost or never read by a model. Delivery is persisted and recoverable, not acknowledged end to end.
- Unreviewed skills. A skill is instructions plus scripts; a skill you did not read is code you did not read.

## Reduce your risk

- Run crews in a throwaway worktree or a disposable VM or container if the code or the task is not yours.
- Keep secrets out of working folders and briefs. Give agents scoped, revocable credentials.
- Hire a read-only role (`advisor`, `verifier`) when the job does not need to write.
- Review what agents did before you merge it. That is what the verifier is for.
- Use `sparrow sandbox up` to try Sparrow itself without touching your real state.

No independent security audit has been done, and Linux has had less testing than macOS.

## Reporting a vulnerability

Please report it privately. Do not open a public issue.

1. Go to the repository's **Security** tab: <https://github.com/vermarjun/Sparrow/security>.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Say what you found, the version (`sparrow --version`), your OS, and the smallest steps that reproduce it.

This is a small open-source project: there is no bounty and no formal response time. The maintainers read every
report, and a valid one is fixed and credited if you want credit.

Things that are by design and not vulnerabilities: workers running with permission bypass, no authentication on a
loopback-only API, plaintext local storage, and an agent acting with its user's authority. If you think one of those
should change, open a normal feature request.
