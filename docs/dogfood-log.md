# Dogfood log: Skills feature build (2026-10-18)

The Skills feature was built through the user's running Sparrow instance (main checkout, v0.1.0, port 4040).
One entry per issue. Severity: **high** (wrong result / lost work), **med** (cost time or needed a workaround),
**low** (confusing, cosmetic). "Blocked" = I could not continue without a workaround.

| # | Time | Agent | Severity | Blocked | Status |
|---|---|---|---|---|---|
| D1 | 13:12 | resumes | low | no | open |
| D2 | 13:15 | @iris | med | yes (worked around) | open |
| D3 | 13:14 | hire --cwd worktree | low | no | open (doc) |
| D4 | 13:29 | sparrow-captain skill | med | no | **fixed** 43dfb7a |
| D5 | 13:33 | web Agents page | low | no | open |
| D6 | 13:45 | @ben tests | high | no | **fixed** (test helper) |
| D7 | 13:53 | tests in agent windows | med | no | **fixed** 668b53a (harness tests) |
| D8 | 13:59 | fake-agent leaks | low | no | open |
| D9 | 14:12 | sandbox catalog refresh | low | no | open |
| D10 | 14:15 | pkill / argv / codex exit 0 | high | no | open (captain error fixed by practice) |
| D11 | 14:19 | identity lost → captain mode | med | no | open |
| D12 | 14:47 | @noor killed :4040 | high | yes ~3 min | open (root causes) |
| D13 | 15:02 | API accepts cross-site writes | med | no | **fixed** for /api/skills*, open elsewhere |
| D14 | 15:16 | `sparrow stop` via SPARROW_URL | high | yes | **fixed** 0b692dd, live re-tested |
| D15 | 15:19 | @kai restarted :4040 | high | unblocked | open |
| D16 | 14:22 | `sparrow install` roots | med | no | **fixed** 0cc7a30 |

## Entries

### D1 · 13:12 · resumes · low · not blocking
- **Did:** `sparrow resumes` before hiring.
- **Expected:** each description matches the configured runtime.
- **Happened:** three descriptions name the wrong model or harness. `builder` says "(Claude Code, Opus)" but runs
  `sonnet`. `builder-codex` says "gpt-6.1-sol" but runs `gpt-6-luna`. `verifier` says "Read-only, adversarial
  reviewer (Codex)" but runs OpenCode `deepseek-v4.1-flash` at effort `low`.
- **Evidence:** `sparrow resumes` output at 13:12.
- **Why it matters:** DESIGN §8 added `{{model}}`/`{{runtime}}` template vars for exactly this; the user's copies in
  `~/.sparrow/resumes` still hard-code names, and nothing flags the drift. A captain choosing a verifier by
  description would expect Codex.
- **Proposed fix:** Doctor check "description names a model/harness that differs from the resume's settings"
  (regex over known harness/model names), with a one-click "use {{runtime}}" fix in the Resumes page.

### D2 · 13:15 · @iris (researcher, OpenCode kimi-k3) · med · blocked (worked around)
- **Did:** hired a researcher. The `opencode-go` provider returned HTTP 500 for every request (also `deepseek-v4.1-flash`;
  reproduced outside Sparrow with `opencode run --print-logs`: `AI_APICallError: Internal Server Error`).
- **Expected:** Sparrow tells me the agent can't reach its model.
- **Happened:** each failed turn fired `session.idle`, so Sparrow treated it as "stopped without reporting": two
  nudges were typed into a TUI that was still retrying (the second shows `QUEUED`), then the call ended
  `unreported` at 13:17:42 with the screen tail as "last message". Nothing says "provider error". The agent did zero
  work but looks like a lazy agent.
- **Evidence:** inbox system message 13:17:42; `tmux capture-pane -t sparrow-sparrow-skills:iris` shows
  `Internal Server Error [retrying in 3s attempt #5]`.
- **Proposed fix:** the OpenCode plugin forwards `session.error` (and Codex/Claude API-error screens) as a
  `provider_error` hook; the server skips nudges for that turn and sends one system notice "@iris: model provider
  error (opencode-go 500); message it to retry". Doctor could also flag the provider as failing.

### D3 · 13:14 · hire --cwd into a worktree · low · not blocking
- **Did:** `sparrow hire … --cwd ../sparrow-skills` (a git worktree of the sparrow repo) from the worktree.
- **Happened:** the worktree is a separate project `sparrow-skills` (basename of its git root), with its own captain,
  board and tmux session `sparrow-sparrow-skills`. Expected for isolation, but the cards on the `sparrow` board are
  not visible here, and the session name repeats "sparrow".
- **Proposed fix:** none needed; document in the captain skill that a worktree is its own project.

### D4 · 13:29 · assets/skills/sparrow-captain · med · not blocking · FIXED (`sparrow-fix:` commit)
- **Found by:** @nina's research: `npx skills list -g` prints `⚠ Skipped …/sparrow-captain/SKILL.md — YAML parse error`.
- **Cause:** unquoted `: ` inside the description ("(those are workers: use sparrow-worker)"). Claude is lenient, but
  strict YAML parsers (Bun.YAML, Vercel's CLI) drop the skill.
- **Fix:** quoted the description; `test/cli/skill-assets.test.ts` parses every shipped SKILL.md strictly and checks
  the spec name/description rules (fails on the old file, passes now).
- **Re-test on running instance:** not applicable until merged; installed copies will show "outdated" in Doctor
  until `sparrow install` runs.

### D5 · 13:33 · web UI Agents page · low · not blocking
- **Did:** opened `http://127.0.0.1:4040/#/agents?p=sparrow-skills` after @maya, @leo and @nina had reported `done ok`.
- **Expected:** an idle agent's row shows how its job ended (done ok / blocked / failed + the result's first line).
- **Happened:** "Last update" shows the last `sparrow update` progress line, e.g. @leo: "The evidence report is
  drafted. I'm doing one last local CLI/schema check…" (6m), although it finished with a full result. Nothing in
  the row says the job is done or whether it succeeded; the state chip just says `idle`.
- **Evidence:** screenshot `docs/skills-evidence/dogfood/ui-agents-1333.png`.
- **Proposed fix:** for `idle` agents whose last call ended `done`, show a result chip (`done ok`) and the result's
  first line instead of the last progress update (the data is in the last result message's `meta.status`).

### D6 · 13:45 · @ben (builder) · high · not blocking · fixed on feat/skills-p4 (test helper)
- **What:** @ben's first full `bun test test/` run wrote 274 stub agent dirs (each holding only `skills.json`) into
  the REAL `~/.sparrow/agents`. He moved them to the trash himself and reported it.
- **Cause:** `test/server/helpers.ts` never set a temp `SPARROW_HOME`. Before this feature the server tests wrote
  nothing per agent, so it went unnoticed; the new hire-time skill snapshot writes to the agent dir.
- **Verified by captain (13:59):** `~/.Trash` holds exactly 274 `ag_*` dirs, every one contains only `skills.json`,
  none of the ids is in `~/.sparrow/sparrow.db`, all 32 real agent rows still have their dirs, no `skills.json` is
  left under `~/.sparrow/agents`. No user data was lost.
- **Fix:** `test/server/helpers.ts` now points `SPARROW_HOME` at a temp dir (on feat/skills-p4). Proposed follow-up:
  a test preload that refuses to run when `SPARROW_HOME` is unset or equals `~/.sparrow`.

### D7 · 13:53 · tests run inside an agent window · med · not blocking
- **What:** @kai's full suite failed in harness tests until it cleared `SPARROW_URL`. Agent windows export
  `SPARROW_AGENT_ID`, `SPARROW_CALL_ID` and `SPARROW_URL` (DESIGN §3.1), and `bun test` inherits them, so test code
  that shells out to `bin/sparrow` or reads `serverUrl()` talks to the user's live server on :4040 as that agent.
- **Expected:** a test run is hermetic regardless of the shell it starts in.
- **Proposed fix:** a `bunfig.toml` test preload that deletes `SPARROW_*` identity vars (and sets temp
  `SPARROW_HOME`) before any test file loads.

### D8 · 13:59 · leaked fake-agent processes · low · not blocking
- **What:** 40 `bun …/src/harness/fake-agent.ts` processes are running, the oldest from 2026-10-17 15:57 in other
  worktrees (`sparrow-nogroup`, `sparrow-v2-resumes`) and new ones from this job's `sparrow-skills-p1`.
- **Cause (per @ben):** the `test/cli` (`u1cli-*`) suites leave fake agents running after the suite ends.
- **Proposed fix:** the suite's afterAll kills its tmux socket server (`tmux -L <sock> kill-server`) so fake agents
  in its windows die with it.

### D2 (update 14:05): root cause is an expired OpenCode Go API key
- `opencode run -m opencode-go/deepseek-v4.1-flash` now prints `Error: This API key has expired. Create a new API key
  in OpenCode Console…` (at 13:15 it was a bare HTTP 500). Only the user can renew it.
- `GET /api/doctor` still reports OpenCode `working: true` from a run on 2026-10-17 05:14, and `sparrow resumes` shows
  researcher / verifier / presenter as `status: ok`, `can hire`. Health is never re-checked when hires fail, so a
  captain keeps hiring OpenCode agents into a dead provider.
- **Proposed fix:** mark a harness+provider `degraded` after N consecutive provider errors from its agents (needs the
  provider_error hook above) and show it on `sparrow resumes` / the Resumes page.

### D9 · 14:12 · sandbox instance not fully hermetic · low · not blocking
- **What:** @ada's sandbox Sparrow instance (own SPARROW_HOME/PORT/socket) ran the model-catalog refresh at startup with
  the default `CODEX_HOME`, so Codex itself rewrote the real `~/.codex/models_cache.json` (mtime 14:08; attribution not
  proven, no pre-run mtime). Same for Claude/OpenCode catalog probes. No skill folder is touched.
- **Proposed fix:** a `SPARROW_NO_CATALOG_REFRESH=1` (or "catalog: cached only" when SPARROW_HOME is not the default)
  for test/demo instances.

### D10 · 14:15 · captain error exposes two Sparrow issues · high · not blocking
- **Did (my mistake):** to cancel a background `sparrow inbox --wait` I ran `pkill -f "sparrow.*inbox --wait"`.
- **Happened:** it also killed @cleo and @mira (Claude, exit 143) and @ivan (Codex). Their process command lines match
  because Sparrow passes the WHOLE system prompt as argv (`--append-system-prompt "$(cat system.md)"`, Codex
  `-c "$(cat developer-instructions.toml)"`), and the protocol text mentions `inbox --wait`.
  - Claude agents: Sparrow auto-restarted both on the same session within seconds (good: DESIGN §3.8 worked).
  - Codex: `codex` exits **0** on SIGTERM, so Sparrow treated it as "the user typed /exit" → `unreported`, no restart;
    the notice says "stopped without reporting" with a screen showing `Working (7m 19s …)` mid-task. I resumed it
    with `sparrow send`.
- **Sparrow issues underneath:** (a) multi-KB prompts in argv are visible in `ps` to every local process and make
  `pkill -f`/`pgrep -f` dangerous; pass them by file where the harness allows (Claude `--append-system-prompt-file`
  if available; Codex `developer_instructions` via a profile/config file). (b) exit 0 while the screen shows the TUI
  mid-turn (`Working (…)` / `esc to interrupt`) should be treated as a crash, not a clean quit.
- **Codex implementation note:** Codex has no file route for developer instructions without a private CODEX_HOME; feat/skills introduces a per-agent CODEX_HOME with symlinked auth/config, after which a profile/config file inside that home can carry it (follow-up).
- **Lessons for captains (added to my own practice):** cancel a background wait with the harness's task stop, never
  `pkill -f`; never pipe `inbox --wait` into anything that discards output (I lost nothing only because
  `sparrow inbox --last` recovered the messages: good feature).

### D11 · 14:19 · agent lost its identity mid-task · med · not blocking
- **What:** @cleo reported "`sparrow update` replied '@captain has no parent', so the milestone updates may not have
  reached you". My brief told builders to `unset SPARROW_URL SPARROW_AGENT_ID SPARROW_CALL_ID` before `bun test`;
  in a shell where that ran, `sparrow update` silently switched to **captain mode** and registered a human
  `@captain` for the project `sparrow-skills-p2` (git root of its cwd), then failed with "no parent".
- **Expected:** a CLI call from inside an agent window that has lost SPARROW_AGENT_ID is refused with a hint, not
  turned into a second human captain of a new project.
- **Proposed fix:** the launch script also exports `SPARROW_AGENT_ID` into a file (`$SPARROW_HOME/agents/<id>/env`)
  and sets `SPARROW_AGENT_HOME`; the CLI in captain mode checks `TMUX_PANE` against the server's agent windows (or
  a `SPARROW_WINDOW=1` marker that tests don't unset) and refuses: "this looks like an agent window whose
  SPARROW_AGENT_ID was unset; run in a subshell: (unset …; bun test)". Also: tell agents in the brief template to
  unset in a subshell.
- **Recurred (15:55):** @cleo reported the same "@captain has no parent" on a later job, even after the brief said
  "unset only in a subshell". Briefs can't fix this reliably; the CLI guard is needed.

### D12 · 14:47 · @noor (verifier) killed the user's live Sparrow server · high · blocked ~3 min
- **What:** to stop its own sandbox instance (:4470) @noor ran `pkill -f "bin/sparrow up"`. That also matched the
  user's server on :4040 (`bun …/sparrow/bin/sparrow up --port 4040`, pid 51637). Every agent's `sparrow` call failed
  ("server unreachable"); @kai's `sparrow done` failed at 14:46:5x; my `inbox --wait` exited 1.
- **Recovery:** @noor restarted it itself at 14:47:15 the way `startDetached` does (`bun …/sparrow/bin/sparrow up
  --port 4040`, detached, parent launchd, pid 87576) and DM'd me a heads-up. Boot recovery re-adopted the three live
  windows (@kai, @ada, @noor) as designed (§3.9); @kai's Codex session retried `done` and it landed at 14:47:17.
  Nothing was lost. I did NOT restart it myself (the brief forbids it); the user should know their server is now a
  process started by an agent (same binary, same home, same port), which inherited that agent's Claude env
  (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION=1`, …). Spawned windows unset the session vars
  (`UNSET_VARS`) and take their env from tmux, so the effect should be nil; a user restart at a convenient time
  would make it clean.
- **Cause (mine):** my verifier briefs said "stop your instance" without saying how. Same `pkill -f` class as D10.
- **Sparrow issues underneath:** (a) `sparrow stop` exists and honours `SPARROW_HOME`, but nothing teaches agents to
  use it; the worker skill could say "stop a sandbox server with `SPARROW_HOME=… sparrow stop`, never pkill".
  (b) The server process line `sparrow up --port 4040` is indistinguishable from a sandbox's `sparrow up`; a
  `--name`/home in argv (e.g. `sparrow up --home ~/.sparrow`) would make patterns safer. (c) `UNSET_VARS` misses
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_EXECPATH`.
- **Re-tested:** boot re-adoption worked on the live instance (log lines `recover: re-adopted @kai/@ada/@noor`).

### D13 · 15:02 · Sparrow API accepts cross-site writes · med · not blocking
- **What:** @noor showed a cross-site `Content-Type: text/plain` POST (a "simple" request, no CORS preflight) to
  `/api/skills` created a skill and linked it into the harness folders. The same holds for the pre-existing routes
  (`POST /api/cards`, `PATCH /api/cards/:id`, `POST /api/resumes`, `POST /api/captain/start`…): any web page the user
  visits can drive the local server, because there is no Origin check and JSON parsing ignores the content type.
- **Fixing on feat/skills:** the `/api/skills*` writes (B3 in docs/skills-evidence/phase3/verify.md).
- **Proposed fix for the rest (not built):** one middleware on every non-GET `/api/*` route: refuse
  `Sec-Fetch-Site: cross-site` and any `Origin` that isn't the server's own; require `application/json` on JSON routes.
  The CLI sends no Origin, so it is unaffected.

### D14 · 15:16 · `sparrow stop` from an agent window kills the live server · high · BLOCKING · FIXED on feat/skills (`sparrow-fix:` 0b692dd)
- **Did:** @ada stopped her sandbox instance exactly as I briefed: `SPARROW_HOME=<sandbox> SPARROW_PORT=4430 bin/sparrow stop`.
- **Happened:** the user's live server on :4040 stopped ("Sparrow server: stopped (pid 87576)"). All agent CLI calls and
  my `inbox --wait` then failed with "server unreachable".
- **Cause:** `stopServer()` asked `health()` at `SERVER_URL`, which is `SPARROW_URL ?? 127.0.0.1:<SPARROW_PORT>`;
  agent windows export `SPARROW_URL=http://127.0.0.1:4040`, so the explicit SPARROW_HOME/SPARROW_PORT were ignored
  for the pid lookup, and `stop` never checked the answering server against this home's `server.pid`.
- **Fix:** lifecycle commands use `127.0.0.1:<SPARROW_PORT>` whenever `SPARROW_PORT` is set, and `stop` refuses when
  the server answering is not the one recorded in this home's `server.pid`. Regression test
  `test/cli/lifecycle.test.ts` "stop targets this home, not the inherited SPARROW_URL": a decoy server at
  SPARROW_URL reporting a live pid survives a sandbox `stop` (fails on the old code: the pid gets SIGTERM).
- **Re-test on running instance:** not possible (the fix is on the branch; the user's server runs main's code and is
  currently DOWN). I did not restart it: the brief forbids restarting the user's instance.
- **Re-tested live on worktree instances (15:41):** instance A (`sparrow up --port 4491`, sandbox home) standing in for
  the live server; from a shell with `SPARROW_URL=http://127.0.0.1:4491`, `SPARROW_HOME=<b> SPARROW_PORT=4492 sparrow stop`
  → branch code: "Sparrow server: not running." and A still answers; main's code: "Sparrow server: stopped (pid …)"
  and A is gone. Bug reproduced on main, fixed on the branch.
- **Impact on this job:** from 15:16 every Sparrow message is blocked; I followed the remaining agents through their
  tmux windows and branch commits instead (see "Known gaps").

### D15 · 15:19 · @kai restarted the user's server from inside its Codex window · high · unblocked us
- **What:** after D14 left :4040 down, @kai's `sparrow done` failed; it then ran `sparrow up` itself (from a Codex
  background terminal) at 15:19:51. Every pending result (@kai, @ivan, @ada) arrived after that.
- **State of the user's server now:** pid 22395, `bun ~/.local/bin/sparrow up` (main's code, same home/port), parent
  launchd, started in the foreground of a Codex tool shell, so its log goes to that (now gone) terminal, not
  `~/.sparrow/server.log`; its environment carries @kai's identity (`SPARROW_AGENT_ID=ag_01M570DG…`,
  `SPARROW_CALL_ID`, `CODEX_SESSION_ID`, `CODEX_CI=1`, …).
- **Why it matters:** spawned windows set their own `SPARROW_*` and unset `CODEX_*` session vars (`UNSET_PREFIX_RE`),
  so agents should be unaffected, but the server has no log file and an agent's identity in its env. The user should
  restart it themselves (`sparrow stop && sparrow`) when convenient. I did not, per the brief.
- **Proposed fix:** `sparrow up` refuses to run when `SPARROW_AGENT_ID` is set ("agents must not start the user's
  server; tell your captain"), unless `--allow-from-agent` (tests); the worker skill says "if the server is
  unreachable, stop and report via your final message; never start or stop servers you didn't create".

### D16 · 14:22 · `sparrow install` ignores sandbox/override homes · med · not blocking · FIXED (`sparrow-fix:` 0cc7a30)
- **Found by:** @mira (Phase 1 verifier, BUG-6). `src/cli/install.ts` built `~/.claude/skills` and `$CODEX_HOME/skills`
  itself, ignoring `CLAUDE_CONFIG_DIR` and any sandbox override, so `sparrow install` in a test or sandbox wrote
  Sparrow's skills into the real harness folders.
- **Fix:** the skills step resolves its targets through `skillPaths()`; `test/cli/install.test.ts` covers custom roots.

### D17 · 2026-10-19 00:09 · @otto (dogfood builder) · med · not blocking
- **What:** while demonstrating D11 on main's code, @otto ran `sparrow update` in a shell with `SPARROW_URL` stripped
  and no `SPARROW_PORT`; the CLI fell back to :4040 and registered a human `@captain` + project `other`
  (root `<sparrow-dogfood-a>/.sandbox/d11-main/other`) in the user's live DB. Reported by @otto himself.
- **This is D11 itself, reproduced on the live server** (a CLI that lost its identity silently becomes a captain of
  a new project). The fix on fix/dogfood-a is the refusal. Cleanup of `other` and `sparrow-skills-p2` is in the
  dogfood fix report; I did not edit the DB.
- **Brief lesson:** demos of the *old* behaviour must also point at a sandbox port; "never use :4040" has to cover
  the main checkout's CLI too.

### D18 · 2026-10-19 00:40 · `sparrow stop --sandbox` stops another home's server · high · not blocking · fixing (fix/dogfood-a)
- **Found by:** @leo verifying D15. `SPARROW_HOME=<a home with no server.pid> SPARROW_PORT=4610 sparrow stop --sandbox`
  stopped pid 78450, a sandbox server of ANOTHER worktree (@rex's `sparrow-dogfood-b`) that happened to use 4610.
- **Cause:** `stopServer()` trusts the pid that `/api/health` on the port reports when this home has no pidfile (the
  D14 fix only refused a pidfile that disagrees).
- **Fix (routed to @otto):** stop only a server this home owns (pidfile match, or `--home <this home>` in its argv from
  D12); refuse otherwise.

### D19 · 00:40 · my verifier brief made a verifier unable to report · med · not blocking
- **What:** I told @leo "every sparrow command you run sets SPARROW_PORT/SPARROW_HOME to the sandbox". He applied it to
  his own `sparrow update`/`done` too: they went to the sandbox server (another worktree's, see D18), which answered
  "Unknown agent id …"; after that server stopped, `done` failed and the call ended "stopped without reporting".
  His full report was on disk, so nothing was lost.
- **Also:** two agents picked the same sandbox port (4610) because nothing allocates them.
- **Proposed fix (Sparrow):** a `sparrow sandbox up` helper that allocates a free port + socket + prefix under the
  caller's worktree and prints the env to use, and agent CLIs that always report to `SPARROW_URL` from the launch
  (ignoring a changed SPARROW_PORT/SPARROW_HOME for update/done/ask/wait). Brief template fix: "your own reporting
  always uses the env your window started with".

### D20 · 2026-10-19 00:49 · a "fails on main" proof stopped the user's live server · high · BLOCKING
- **What:** @otto's new regression test "agent sandbox on port 4040 is refused" runs the CLI with `SPARROW_PORT` unset.
  On the branch the guard refuses before any I/O; but my brief asked every fix to prove "fails on main", so it was also
  run against main's code, where that `sparrow stop` targets :4040 and stopped the user's server (log ends 00:48:59).
- **Cause (mine + Sparrow's):** a brief that asks for fail-on-main proofs of server-lifecycle guards, and a test whose
  failure mode is "kill the real server". There's no safe default: `sparrow stop` with no env targets the live server.
- **Fix:** the test moves to the pure `lifecycleRefusal()` function; CLI-level lifecycle tests always pin a temp home and a
  free port. Proposed Sparrow follow-up: the test preload (D7) refuses to run when `SPARROW_PORT` is unset or 4040.
- **Status:** the user's server is down; I did not restart it (brief). Agents keep working in their windows; their
  reports go to files until the server is back.
