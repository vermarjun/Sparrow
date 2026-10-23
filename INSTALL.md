# Install Sparrow with your coding agent

Paste the following prompt into a fresh Claude Code, Codex or OpenCode session:

```text
Install Sparrow on this machine and get it running. Work idempotently and keep my existing state, edited resumes and harness logins. Do not change my harness settings.

1. Install it with one of these. Use the install script unless npm is already how I install tools.
   curl -fsSL https://raw.githubusercontent.com/vermarjun/Sparrow/main/install.sh | sh
   npm i -g sparrow-agents
   If ~/.local/bin is not on my PATH, tell me the one line to add; use the absolute path for this session.
2. Run `sparrow --version`, then run `sparrow` with no arguments. The first run sets itself up, starts a local server on http://127.0.0.1:4040 and tries to open the UI. If no browser opens, tell me the URL.
3. Read the readiness check that `sparrow` printed. Report it to me line by line: tmux, which harnesses are installed and logged in, which roles are hireable now, and which fell back to another harness. If tmux is missing or no harness is logged in, give me the exact command from the output and wait for me.
4. Tell me to open the UI, go to Doctor and press Run doctor. Do not run the doctor yourself and do not try to repair harnesses: it hires a real agent on each harness and can spend a little usage.
5. When I say the doctor is green, start a captain: `sparrow captain --cwd <my project folder>` (Claude Code), or continue in this session and let it register as the captain.
6. Report the real command output and the URL. Explain `sparrow status`, `sparrow stop`, and `sparrow uninstall` (stop first). Do not claim a harness works until its doctor checks pass.
```

More detail: [Getting started](docs/getting-started.md). Prefer to see what the script does first? Read
[install.sh](install.sh). To remove Sparrow later: `sparrow stop && sparrow uninstall` (add `--purge` to delete your
data).
