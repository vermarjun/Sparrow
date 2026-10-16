# Install Sparrow with Claude Code

Paste the following prompt into a fresh Claude Code session:

```text
Install Sparrow on this Mac and get its UI running. Work idempotently: keep existing state, edited resumes, deleted-resume tombstones, harness authentication, and unrelated configuration.

1. Check prerequisites: Bun, tmux, and at least one of Claude Code, Codex, or OpenCode. Check that the chosen harness is logged in (claude auth status, codex login status, or opencode auth list). Explain any missing prerequisite and ask me to install/log in before continuing. Do not change my global harness settings.
2. Locate my existing Sparrow checkout (start with the current directory). If none exists, ask for the repository URL and clone it into a folder I choose; do not invent a repository URL.
3. In the checkout run bun install, then bun bin/sparrow install. This builds the UI, seeds missing resumes without overwriting edits or resurrecting deletions, installs Sparrow skills and harness plugins, and links ~/.local/bin/sparrow. Repeat safely if interrupted.
4. Ensure ~/.local/bin is on PATH. If needed, add a single export PATH="$HOME/.local/bin:$PATH" line to my shell startup file, preserving the rest. Use the absolute linked executable for this session if the new PATH is not loaded yet.
5. Run sparrow with no arguments. It starts the server detached, opens the browser, prints its URL, and returns. Repeating it opens the existing server. If the browser did not open, open the printed URL.
6. Tell me to click Run doctor in the UI and inspect any failed harness checks. The doctor is explicitly user-triggered; do not run it or attempt harness repairs automatically. Once ready, I can use Start captain in the UI or sparrow captain --cwd <project-folder>.
7. Report the real command results and the URL. Explain sparrow status and sparrow stop. Do not claim a harness works until its doctor checks pass.
```
