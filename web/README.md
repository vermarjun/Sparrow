# Sparrow web UI

The browser UI for a local Sparrow server: **Captains** (one row per feature in flight), a **captain page** with Activity, Team (with a live screen peek of each agent's tmux window) and Cards, the **Board** (a ticket tracker with triage mode), the **Resumes** editor, and the Skills, Doctor and Settings pages.
It never spawns agents itself. Its writes are the ones the server API exposes for people: creating and moving tickets, renaming and archiving captains, editing resumes, running the doctor.

React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui (Nova preset) + Kibo UI kanban (dnd-kit) + zustand. Types come from `../src/shared/types.ts` (`@shared/*`).

```sh
bun install
bun run build            # tsc -b + vite build → web/dist (the Sparrow server serves it on :4040)
bun run dev              # Vite on :5173, /api proxied to http://127.0.0.1:4040
bun run mock             # mock server on :4140 with the "tortuga" demo world and live events (also serves dist)
bun run dev:mock         # Vite with /api proxied to the mock
bun test test/           # unit tests (helpers, event reducer, mock API)
```

## Mock and demo data

`mock/` is an in-memory stand-in for the server API with a believable demo world: project `tortuga` (ticket keys `TOR-n`) with three captains, a sub-captain with its own hires, 18 tickets, the shipped resumes, plus a second project `tortuga-ledger`. Flags: `--no-live` (no simulated activity: use it for screenshots and checks), `--doctor-done` (start with a finished doctor run), `--port`. Setting `MOCK_OPENCODE_LOGGED_OUT=1` makes the simulated doctor report OpenCode as logged out.

## Scripts

Browser scripts use Chrome through `puppeteer-core`: put Chromium on `PATH` or set `CHROME_BIN`. `SPARROW_WEB_URL` and `SPARROW_DEMO_PROJECT` set the default target. Point them at a mock started with `--no-live` (the mock keeps state in memory, so restart it between runs of the mutating ones).

| Script | What it does |
| --- | --- |
| `bun run shots` (`scripts/readme-shots.ts`) | README/docs screenshots of the demo world into `../docs/images/ui-*.png` (starts its own mock; shrinks the PNGs). |
| `bun run shots:terminal` (`scripts/terminal-shots.ts`) | Composes `../docs/images/terminal-crew.png` from the saved tmux captures in `scripts/terminal-fixtures/`; `--redact <dir>` makes new fixtures from raw captures. See the file header for how they are recorded. |
| `scripts/captain-page-e2e.ts --url …` | Interaction checks on the captain page (title editing, tabs, team tree, agent sheet, filters, outcomes, rename). Exits 1 on a failed check. |
| `scripts/board-e2e.ts --url …` | Board interactions (drag, hover actions, Later, search) confirmed against `GET /api/cards/:id`; also works on a real server. Creates and drops two probe tickets. |
| `scripts/captains-shell-shots.ts --url … --api …` | Shell screenshots and keyboard/overflow checks (⌘K, sidebar, New captain, project switcher). |
| `scripts/captain-page-shots.ts --url …` | Captain page screenshots plus horizontal-scroll checks, desktop and mobile. `--live` needs a mock with ticks (`MOCK_TICK_MS=2500`). |
| `scripts/verify-captains.ts --url …` | Every route in light and dark at 1440 and 390 px, with console and keyboard checks. |
| `scripts/verify-live.ts --url …` | SSE appends while the header and tabs stay put; needs a mock **with** live ticks (`MOCK_TICK_MS=2000`). |
| `scripts/verify-contrast.ts`, `scripts/verify-visual.ts` | Audits that print findings (low contrast, light slabs in dark mode, clipped or off-screen elements) and exit 0. |
| `scripts/captains-real-smoke.ts --dist dist` | The real server with the fake harness in an isolated home, port and tmux socket, driven through the UI. |

Layout: `src/lib` (api, store, SSE hook, pure reducer + helpers), `src/pages` (Captains, Captain, Board, Resumes, Skills, Doctor, Settings),
`src/components/sparrow` (shared bits, markdown), `src/components/ui` (shadcn), `src/components/kibo-ui/kanban`
(registry code with small marked "Sparrow edit" changes: no in-place mutation, final order passed to `onDragEnd`,
4 px drag activation so clicks open the card).

The Skills page (`#/skills`, `#/skills/<name>`) drives `/api/skills/*` (library, harness toggles, adopt, conflicts, git); build a sandbox demo with `bun ../scripts/skills-demo-fixture.ts` from `web/`. Run all checks with the isolation environment in [AGENTS.md](../AGENTS.md).
