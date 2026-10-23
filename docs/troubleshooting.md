# Troubleshooting

Start with two commands. They answer most questions:

```sh
sparrow status          # is the server up, who is working, how to attach
tail -n 50 ~/.sparrow/server.log
```

(Replace `~/.sparrow` with `$SPARROW_HOME` if you set one.)

## Server not running

Symptom: a command prints `Sparrow server: not running at http://127.0.0.1:4040`, or fails to connect after a few
retries.

```sh
sparrow            # start it detached and open the UI
sparrow status
```

If it starts and dies, read `~/.sparrow/server.log`. If you would rather watch it fail, run it in the foreground:
`sparrow up`. Agents are not allowed to start or stop your server. If you see `agents must not start/stop the user's
Sparrow server`, that command was run from inside an agent window. Run it from your own shell.

## Port in use

Symptom: the server does not come up with `Port 4040 is already in use` in the log, or `sparrow up` reports a foreign
process on the port.

```sh
lsof -nP -iTCP:4040 -sTCP:LISTEN     # who owns the port
```

If another program owns 4040, run Sparrow elsewhere. Every command needs the same port:

```sh
export SPARROW_PORT=4041
sparrow
```

`sparrow stop` only signals a process that Sparrow can confirm is its own server for this `SPARROW_HOME` and port. If
it refuses, it prints the listener it found. Inspect it yourself with `ps` before you kill anything.

## tmux is missing

Symptom: the doctor shows **tmux installed** as failed, or hires fail to open a window.

```sh
tmux -V
brew install tmux          # macOS
sudo apt install tmux      # Debian, Ubuntu
```

On Linux the first-run readiness check names the command for your distro. Sparrow only checks that `tmux -V` runs. If your own tmux config misbehaves, isolate Sparrow with
`SPARROW_TMUX_SOCKET=sparrow` so it uses its own tmux server.

## A harness is not logged in

Symptom: hires of that harness end quickly or sit at a login screen, or the doctor fails that harness.

```sh
claude auth status
codex login status
opencode auth list
```

Log in with the harness itself, then run the doctor again. The first-run readiness check (`✓ claude installed, login
found`) is only a hint: it looks for credentials on disk or in the environment and does not test them. The doctor does.

If Sparrow cannot find a harness you have installed, point it there with `SPARROW_CLAUDE_BIN`, `SPARROW_CODEX_BIN` or
`SPARROW_OPENCODE_BIN`. Sparrow already searches your `PATH` plus the usual npm, Homebrew, nvm, Volta and similar
folders (see [Harness discovery](configuration.md#harness-discovery)). If a variable you set does not name an
executable, Sparrow ignores it and warns you.

## A resume is UNUSABLE

`sparrow resumes` and the UI mark a resume UNUSABLE when its status is anything but `ok` or `unchecked`: the harness is
not installed, not logged in, or the model is not one the harness offers. The reason follows on the same line. Do not
hire it. A resume marked DEGRADED has had repeated provider errors; prefer another until a call succeeds.

1. Open **Doctor**, press **Run doctor**, and read the failed row for that harness. Each one has a fix line.
2. Or change the resume's model on the **Resumes** page to one your account has.
3. Run the doctor again.

## An agent is quiet or stuck

First find out what it is doing:

```sh
sparrow status                 # state and tmux attach line for every working agent
sparrow log @maya -n 20        # what it sent and received
tmux attach -t sparrow-<project>   # the real terminal (detach with Ctrl-b d)
```

The UI's team view also shows a live peek at the agent's screen. Then pick one:

- It is thinking or running a long command: wait. Sparrow already nudges it after 15 quiet minutes and tells you after
  90.
- It is waiting on you: it would have used `sparrow ask`. Check `sparrow inbox`.
- It is stuck: `sparrow send @maya "Status? What is blocking you?"` wakes a stopped agent. A working agent sees it
  at its next read or when its turn ends.
- It is lost: `sparrow release @maya`, then hire a fresh agent with a tighter brief. Release is permanent.

An agent that shows `queued` is waiting for a free running slot (default 3). Raise `max_running` in Settings, or wait.

## Nudges and "unreported"

An agent is supposed to end every call with `done`, `ask` or `wait`. When its turn ends without one, the harness hook
tells the server and the server nudges it, up to 2 times per call. After that the call ends as **unreported**: the
agent goes idle and you get a notice with its last message (or the tail of its screen). Nothing is lost. The work is on disk. Read the screen,
check the files, and either `sparrow send @maya "Report with sparrow done."` or release it.

Background tasks suppress nudges (an agent waiting on a build is not stopped). Provider errors end the turn as
`provider_error` without a nudge.

## Crash notices

A crashed agent is restarted once on the same session, and you get a quiet note. If it crashes again you get an
action-needed notice that includes the last screen and its exit code. One message from you resumes it:

```sh
sparrow send @maya "Continue from where you stopped."
```

A resumed call that dies within 20 seconds restarts with a fresh session plus a short replay of recent messages. If
the server itself restarted while an agent was working and its window is gone, the agent becomes `crashed` with reason
`server_restart` and you are told.

## "Not sent: unread messages"

`done`, `ask` and `wait` refuse while waking messages are unread. They print
`Not sent: unread messages from @x; run sparrow inbox, then report again (done).` Your report was not delivered, and
nothing was consumed. Run `sparrow inbox`, act on what it shows, then run the command again with your complete report,
not just the changes.

## Read a message you missed

Messages are stored whether or not anyone read them. To read them again:

```sh
sparrow inbox --last 20        # the last 20 delivered messages (1 to 50), consumes nothing new
sparrow log -n 100             # the project's message history
sparrow log @maya -n 30        # one agent's thread
```

When you have unread mail, every command ends with `📨 N unread for @you: ... Read: sparrow inbox`. If you see it,
run `sparrow inbox`. Released agents drop their pending mail by design, but their history stays in `sparrow log`.

## Other messages you may see

| Message | Meaning and fix |
|---|---|
| `UI not built` | A source checkout whose UI was never built. Run `sparrow install`, or `bun run web:build`. A binary install carries its UI. |
| No browser opens (Linux, SSH, container) | Sparrow only opens a browser when a desktop session exists. It prints the URL: open `http://127.0.0.1:4040` yourself, or, on a remote machine, tunnel it with `ssh -L 4040:127.0.0.1:4040`. |
| `the running server is vX, this sparrow is vY` | You upgraded the binary but the old server is still up. `sparrow stop`, then `sparrow`. |
| `sparrow uninstall` says the server is running | `sparrow stop` first. |
| `403` on a message, release or card | You tried to act on another captain's agent. Crews are private. |
| `409 N captains in <project>` | Several captains share this project and Sparrow cannot tell which one this shell is. Run from the captain's own session or set `SPARROW_CAPTAIN_ID`. |
| `may not hire` | The caller's resume does not list that role in `can_hire`. |
| `would create depth N` | The hire would pass `max_depth`. |
| `a new captain` after `/clear` | Claude Code gave the process a new session. Run `sparrow captain adopt @<your handle>`. |
| Agent windows closed, work looks done | Normal. A window closes a few seconds after the report to free memory. |

## Where the logs are

| What | Where |
|---|---|
| Server log | `$SPARROW_HOME/server.log` |
| Message history | `sparrow log`, the UI activity feed, or `$SPARROW_HOME/sparrow.db` |
| What an agent was told | `$SPARROW_HOME/agents/<id>/system.md` and `calls/<call>.prompt.md` |
| Live screen of an agent | `tmux attach`, or the screen peek in the UI |
| Real harness history | The harness's own session store (Claude Code, Codex and OpenCode each keep their own) |

## Stop and reset safely

Stop the server. Live agent windows are adopted back on the next start:

```sh
sparrow stop
```

Close one agent for good: `sparrow release @maya`. Close every Sparrow window by hand only if you must, and only
Sparrow's own sessions (`tmux ls`, then `tmux kill-session -t sparrow-<project>`). Never kill your other tmux
sessions.

Start over from a clean slate without losing anything you cannot get back:

```sh
sparrow stop
mv ~/.sparrow ~/.sparrow.bak     # keeps resumes, history and the database
sparrow install                  # recreates the home and reseeds default resumes
sparrow
```

Copy your edited resumes back from `~/.sparrow.bak/resumes/` if you want them. To try something risky without touching
your real state, use a sandbox instead: `sparrow sandbox up --dir /tmp/sparrow-try`.
