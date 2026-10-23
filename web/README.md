# Sparrow web UI

The observer UI for Sparrow: a tracking-only **Board**, a read-only **Chat** log and an **Agents** page with a live screen peek.
It never hires, messages or spawns anything; the only writes are creating and moving cards (`POST /api/cards`, `PATCH /api/cards/:id`).

React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui (Nova preset) + Kibo UI kanban (dnd-kit) + zustand. Types come from `../src/shared/types.ts` (`@shared/*`).

```sh
bun install
bun run build            # tsc -b + vite build → web/dist (the Sparrow server serves it on :4040)
bun run dev              # Vite on :5173, /api proxied to http://127.0.0.1:4040
bun run mock             # mock server with seeded data + live events on :4140 (also serves dist)
bun run dev:mock         # Vite with /api proxied to the mock
bun test test/           # unit tests (helpers, event reducer, mock API)
bun scripts/shots.ts     # screenshots + drag proof against the mock → ../.sandbox/shots/T4
bun scripts/shots.ts --v2 --size 1440x900 --out ../.sandbox/shots/board-v2   # Board v2 pass: board, Later, list, filters, sheets, dialog + PATCH checks (restart the mock first: it keeps state)
bun scripts/verify-live.ts --url http://127.0.0.1:4140 # SSE live append against the mock
bun scripts/captains-real-smoke.ts # real server + fake harness, isolated home/port/tmux
```

The **Skills** page (`#/skills`, `#/skills/<name>`) drives `/api/skills/*` (library, harness toggles, adopt, conflicts, git); build a sandbox demo with `bun ../scripts/skills-demo-fixture.ts` from `web/`.

Layout: `src/lib` (api, store, SSE hook, pure reducer + helpers), `src/pages` (Board, Chat, Agents),
`src/components/sparrow` (shared bits, markdown), `src/components/ui` (shadcn), `src/components/kibo-ui/kanban`
(registry code with small marked "Sparrow edit" changes: no in-place mutation, final order passed to `onDragEnd`,
4 px drag activation so clicks open the card).

Browser scripts discover Chromium on PATH; set `CHROME_BIN` to override it. `SPARROW_WEB_URL` and `SPARROW_DEMO_PROJECT` set default browser-script targets. Run all checks with the isolation environment in [AGENTS.md](../AGENTS.md).
