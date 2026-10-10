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
bun scripts/shots.ts     # screenshots + drag proof against the mock → ../.orchestra/shots/T4
bun scripts/live-check.ts   # SSE live append, pinned scroll, reconnect (own mock on :4145)
bun scripts/real-smoke.ts   # real server + fake harness, isolated (port 4144, tmux -L sparrow-test-T4)
```

Layout: `src/lib` (api, store, SSE hook, pure reducer + helpers), `src/pages` (Board, Chat, Agents),
`src/components/sparrow` (shared bits, markdown), `src/components/ui` (shadcn), `src/components/kibo-ui/kanban`
(registry code with small marked "Sparrow edit" changes: no in-place mutation, final order passed to `onDragEnd`,
4 px drag activation so clicks open the card).
