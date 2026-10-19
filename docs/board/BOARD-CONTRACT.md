# Board v2 — build contract

Owner: @captain. Branch `board-v2`, worktree `/Users/vermarjun/Desktop/SWEFactory/sparrow-board`.
Research behind the choices: `.orchestra/ticket-research.md` (read §2 and the writing guide).

## Why
The user triages 30-60 cards that captains propose, and today the board is a grey wall of titles: no dates, no
priority, no way to tell what a card is for or to hand it to an agent. Board v2 makes every card **skimmable on the
face, complete in the sheet, and pickable by an agent by key** (`PLU-12`), and it moves cards through the columns by
itself as work happens, logging timings so estimate vs actual can be compared at Done.

The user's own words for the bar: "very easy to skim through, very easy to look at the issue and understand it, and
to give it to an agent so it can work on it and move it across the board. Easier for both me and the agent."

## Hard rules (everyone)
- Work ONLY inside `/Users/vermarjun/Desktop/SWEFactory/sparrow-board`. Never edit `/Users/vermarjun/Desktop/SWEFactory/sparrow`
  (the live server on :4040 and the `sparrow` CLI every agent uses run from that checkout).
- Never touch the live server (:4040), `~/.sparrow`, or the user's tmux sessions. Tests always with the 4 isolation vars
  (see CLAUDE.md). For a running server use `bun bin/sparrow sandbox up` from the worktree (or `SPARROW_HOME=.sandbox/...`
  + a free port), and stop only what you started (`sandbox down`; never `pkill -f sparrow`).
- `src/shared/types.ts` and `src/shared/cards.ts` are the seam, written by the captain. Do not change them; if you need
  a change, `sparrow ask` the captain with the exact diff you want. Use the helpers in `cards.ts` (cardKey,
  parseCardRef, parseLevel, parseEstimate, formatEstimate, formatSpan, cardTimings, isQuickWin, sortCardsBy,
  CARD_SORTS, STATE_LABEL, cardBrief) instead of re-implementing them.
- No data migration of existing cards (the user migrates them with their own captain). Old rows simply get column
  defaults; every reader must cope with `history: []`, notes without `kind`, and all-null markers.
- Do not `git commit`; the captain commits. Do not run `sparrow install` or touch `~/.claude`.
- Board stays tracking-only: nothing on the board ever spawns, wakes or messages an agent.

## 1. Data model (already in `src/shared/types.ts`)
`Card` gains: `context, problem, approach` (markdown strings, '' = empty), `checks: {text, done}[]` ("Done when"),
`tags: string[]`, `urgent: boolean`, `impact` (the user's "return") and `effort`: `'low'|'medium'|'high'|null`,
`estimate_min: number|null`, `blocked_on: string|null` + `blocked_at`, `later_at: number|null` (shelved under the
Later line), `history: {at, by, from, to}[]`. `CardNote.kind?: 'comment'|'event'`.
Requests share `CardFields` (`ProposeReq`, `CardCreateReq`, `CardPatchReq` extend it). Patch adds
`assignee: 'me'` and `check: {index, done}`.

Display key: `cardKey(card)` → `PLU-12` (prefix = first 3 alnum chars of the project id, cosmetic; ids are global).
Every place that accepts a card number accepts `12`, `#12`, `PLU-12` (`parseCardRef`).

## 2. Server (owner: backend builder)
**DB** (`src/server/db.ts`): add columns to `cards` via `ADDED_COLUMNS` and the CREATE TABLE:
`context/problem/approach TEXT NOT NULL DEFAULT ''`, `checks/tags/history TEXT NOT NULL DEFAULT '[]'` (JSON),
`urgent INTEGER NOT NULL DEFAULT 0`, `impact TEXT`, `effort TEXT`, `estimate_min INTEGER`, `blocked_on TEXT`,
`blocked_at INTEGER`, `later_at INTEGER`. `rowToCard` maps them (booleans, JSON with fallbacks). insert/patch handle them.

**Validation / normalisation** (one helper used by propose, create and patch): title 1-200 chars trimmed; sections
≤ 20 000 chars; `checks` ≤ 30 items, each text 1-500 chars (strings become `{text, done:false}`, blank ones dropped);
`tags` lowercased, trimmed, deduped, ≤ 12, each ≤ 32 chars, no commas; `category` trimmed lowercase or null;
`impact/effort` via `parseLevel` (also accept null); `estimate_min` via `parseEstimate` (accept the strings too);
`blocked_on` non-empty → blocked (keep `blocked_at` if already blocked), null/'' → unblocked; `later` boolean.
Errors are 400 with an actionable message (what field, what is allowed).

**Permissions**: captain or UI (no header): everything. Card's assignee: `note`, `state: 'review'`, `check`,
`blocked_on` (an agent may say it is blocked). Any agent: `propose` with all `CardFields` (never state/assignee).
Everyone else: 403 with a message that says what they may do instead.

**Timeline**: comments (`note`, `sparrow update --card`) are `kind:'comment'`. The server writes `kind:'event'` notes
for: state change (`moved todo → in_progress`), assignee (`assigned to @maya` / `unassigned`), urgent
(`marked urgent` / `cleared urgent`), blocked (`blocked on <x>` / `unblocked after <formatSpan>`), later
(`shelved under Later` / `back from Later`), field edits (`edited title, approach` — one event per patch, listing
field names), check (`checked "<text>"` / `unchecked "<text>"`), auto moves (below). Events from the UI have `by:'user'`.

**History**: push `{at, by, from:null, to}` on every insert (propose/create) and `{at, by, from, to}` on EVERY state
change, whatever caused it (patch, hire `--card`, auto-review). `by` = handle or 'user'.

**Side effects of a state change**: entering `in_progress`, `review` or `done` clears `later_at` (event
`back from Later`); entering `done` or `dropped` clears `blocked_on` (event). Urgent is never auto-cleared.

**Auto moves** (the board follows the work; it still never spawns anything):
1. `hire --card N` (exists): also push history, clear later, and append the ticket to the task text:
   `task + "\n\n---\n" + cardBrief(card, who)` so the agent gets the whole ticket (context, problem, approach,
   checks, comments) in its first prompt. Keep the `card_id` on the message.
2. `done` with status `ok`: every card whose assignee is the caller and whose state is `in_progress` moves to
   `review` (event `@maya reported done → review`, history by the agent). `blocked`/`failed`: no move; add an event
   `@maya reported blocked|failed` with the first ~200 chars of the summary.
3. Moving to `done` is only ever done by a captain/UI (the user confirms). Agents get 403 as today.

**API**: add `GET /api/cards/:id` → `Card` (404 when missing / other project for an agent caller). Accept `PLU-12` in
`:id` too (parseCardRef). Everything else keeps its shape; `card.updated` SSE on every change.

## 3. CLI (owner: backend builder) — `src/cli/main.ts`, `src/cli/format.ts`
Card refs accept `12|#12|PLU-12` everywhere (`--card` on hire/send/update too).
```
sparrow propose "<title>" [--context c] [--problem p] [--approach a] [--check "…"]… [--category c] [--tag t]…
                [--urgent] [--impact|--return low|medium|high] [--effort low|medium|high] [--estimate 2h] [--details d] [--blocked "<on>"]
sparrow card list [--state s] [--sort newest|oldest|urgent|roi|impact|effort|estimate|updated] [--category c] [--urgent] [--blocked] [--all]
sparrow card show <N> [--json]          # cardBrief + timing summary + recent events
sparrow card pick <N>                   # captain: assign to me, move to in_progress, print the brief + next-step hint
sparrow card add "<title>" [same flags as propose] [--state s] [--assignee @h]
sparrow card edit <N> [--title t] [--context …] [--problem …] [--approach …] [--details …] [--category c|none]
                  [--tag t]… (replaces) [--check "…"]… (replaces) [--impact l|m|h|none] [--effort …] [--estimate 2h|none]
                  [--urgent on|off] [--later on|off] [--blocked "<on>"|off]
sparrow card move <N> <state> | assign <N> <@h|me|none> | note|comment <N> "<text>"
sparrow card block <N> "<who/what>" | unblock <N> | later <N> [--undo] | urgent <N> [--undo] | check <N> <i> [--undo]   # i is 1-based
```
`card list` output: grouped by column (manual order unless `--sort`), shelved cards under an indented `· later ·`
sub-heading per column, one line per card: `PLU-12  ‼ ⛔ Title · ui · R high/E low · ~2h · 3d · @maya`
(‼ urgent, ⛔ blocked with `blocked on …` appended, ★ quick win). `card show` prints `cardBrief` then
`Timing: proposed 17 Oct · started … · in review … · build 2h 10m · review 25m · est 2h → 2h 10m build (1.1×)`
(captain change: the estimate is compared with BUILD time only; review is the user's latency and is shown beside it)
and the last 8 events. `card pick` ends with:
`Next: work it; when the build is done run \`sparrow card move PLU-12 review\`. Never move it to done yourself; the user does that after review.`
Usage strings + `--help` updated. JSON mode (`--json`) prints raw objects as today.

## 4. Prompts, skills, docs (owner: backend builder)
- `assets/protocol.md`, `assets/skills/sparrow-worker/SKILL.md`: how to propose a good ticket (paste the writing guide
  from ticket-research.md, adapted: Approach must be plain English with NO code; always give impact, effort and an
  estimate; context says who asked and where it came from), `sparrow card show N` to read a ticket, assignee may
  `card note`, `card check`, `card block`, `card move N review`; `done` auto-moves its in-progress card to review.
- `assets/skills/sparrow-captain/SKILL.md` §6 Board: keys (`PLU-12`), `card pick` when the user says "pick PLU-12"
  (it moves the card to In progress and prints the brief), `card move N review` when the build is done, never `done`
  unless the user confirmed, setting markers (`card edit … --urgent on --impact high`), block/unblock, later, and
  that hiring with `--card` hands the agent the whole ticket. Keep it short; the skill is read every session.
- `assets/resumes/*.md` only where they mention cards (sub-captain).
- `docs/DESIGN.md`: Card fields, API table (`GET /api/cards/:id`), CLI block, the auto-move + timeline rules, the
  board UI paragraph (write the UI paragraph from §5 below).

## 5. Web UI (owner: UI builder) — `web/**` only
Stack as today (React 19, Tailwind 4, shadcn/radix, dnd-kit via `components/kibo-ui/kanban`, zustand store, sonner).
Light theme like the rest of the app. Quality bar: a polished product board (Linear / Height level of care), dense
but calm, readable at 1280×800 and 1440×900. Use `frontend-design` judgement; no template look, no emoji.

**Colour system** (one meaning per hue, ALWAYS paired with an icon or text; colour-blind safe):
- Columns: Proposed violet, To do slate, In progress blue/sky, Review amber, Done emerald/green, Dropped zinc.
  Column header gets its colour (dot + tinted header strip + count pill); column body a very light tint of it so the
  board is not a grey slab. Done cards get a green check icon and a subtle green accent.
- Urgent = red (flame/alert icon + "Urgent"), Blocked = orange (ban/hand icon + "Blocked · <on>"), Quick win = green
  bolt, Later = muted slate/blue-grey styling. Category chips: stable hashed palette (8-10 hues, `bg-*-100 text-*-800`
  style) so each category always has the same colour; tags are neutral outline chips.

**Toolbar**: search (`/` focuses; matches key, title, all sections, tags), Sort select (`CARD_SORTS`, applies to
Proposed and To do; In progress/Review manual; Done = most recently done first), filter chips (Urgent, Blocked,
Quick wins, Category multi-select, Assignee), density toggle (Compact / Detailed), view toggle (Board / List),
Show dropped, New ticket (`n`). Persist sort/filters/view/density per project in localStorage (try/catch; must render
fine without it). Show a one-line summary: `33 tickets · 4 urgent · 2 blocked · 7 later`.

**Card face** (research §2: title first, few markers): row 1 key (mono, muted) + category chip + right-aligned age
(`3d`, tooltip `Proposed 17 Oct 2026, 05:39 by @captain`); row 2 title (medium weight, 2-line clamp); row 3 markers:
Urgent / Blocked state icons (with short text), Return and Effort as two compact labelled meters (e.g. 3-bar signal
glyph + `R`/`E` label, tooltip "Return: high"), Quick-win bolt when `isQuickWin`, assignee handle with StateDot at the
right, comments count. Detailed density adds: one-line muted preview of problem‖context‖details, estimate `~2h`,
checks progress `2/5`, tags. Urgent cards: red left accent; blocked: orange left accent. Hover quick actions on
Proposed cards: Accept (→ To do), Later, Drop; on To do: Later. Keyboard focusable; Enter opens.

**Later line**: Proposed and To do columns end with a dashed divider `Later · 7` (collapsible, collapsed by default,
remembered). Shelved cards render below it in the muted Later style. "Move to Later" / "Bring back" from the card's
hover menu and from the sheet. Dragging a card onto the Later area shelves it if dnd makes it straightforward; if not,
menu + sheet are enough.

**Drag**: between columns always (one PATCH, optimistic, revert + toast on error). Reorder within a column only in
Manual sort; otherwise a same-column drop is a no-op.

**Ticket sheet** (replace the current sheet; ~720px wide; scrollable body, sticky header):
- Header: key with copy button, state pill (coloured, a dropdown to change state), title (click to edit inline),
  "Copy for agent" button (copies `cardBrief` markdown) and "Copy pick command" (copies
  `Pick up PLU-12 from the Sparrow board: run sparrow card pick PLU-12`), close.
- Properties grid (all editable inline, saves via PATCH): Urgent toggle, Blocked (toggle opens "Blocked on…" input),
  Later toggle, Return (impact), Effort, Estimate (accepts `2h`, `90m`, `1d`), Category (combobox of existing
  categories + free text), Tags (chip editor), Assignee (project agents + none). Meta line: `Proposed by @captain ·
  17 Oct 2026, 05:39 (3d ago) · updated 2h ago`.
- Blocked banner (orange) when blocked: `Blocked on IT: NetSuite access · for 2d` + Unblock.
- Brief sections, in this order, each with a small icon, label and a one-line hint shown when empty:
  **Context** ("Why does this exist? Who asked, where did it come from?"), **Problem** ("What is wrong right now?
  Observed vs expected."), **Approach** ("Plain-English plan. No code."), **Done when** (checklist with checkboxes,
  progress bar, add / edit / remove / reorder items; ticking uses `check`), **More details** (legacy `details`; hidden
  when empty unless editing). View = Markdown; pencil / click → textarea; Cmd+Enter or blur saves, Esc cancels.
- **Timing** panel: milestones (Proposed, Accepted, Started, In review, Done with date+time), a stacked horizontal
  bar of time in each state using the column colours with durations, and `Estimate 2h · Build 2h 10m (1.1× over) · Review 25m`
  (green ≤ 1.1×, amber ≤ 1.5×, red above; "no estimate" when none). Reopened count when > 0. Uses `cardTimings`.
- **Activity**: one timeline; comments as readable blocks (author, time, markdown), events as compact grey lines with
  small icons; "Comments only" toggle. Composer at the bottom (Cmd+Enter sends `note`).
- Footer: contextual next actions — Proposed: Accept → To do, Later, Drop; To do: Start → In progress; In progress:
  Send to review; Review: **Approve → Done** (green) and **Send back → In progress**; Done: Reopen.

**New ticket dialog**: larger dialog: title, state (To do default, or Proposed), category, urgent, return, effort,
estimate, tags, then the four sections (Done when as one check per line). Only title is required.

**List view**: a dense table of the filtered tickets (Key, Title, State pill, Category, flags, Return, Effort, Est.,
Age, Assignee, Updated); click a header to sort (use `sortCardsBy` where it fits), row click opens the sheet, shelved
rows muted with a Later tag, grouped or filterable by state. This is the planning view for a big Proposed backlog.

**Insights** (stretch, only after everything above is done and verified): a small popover/strip with done in the last
7 days, median active time, median estimate ratio, and the 3 worst misses.

**Data plumbing**: `web/src/lib/api.ts` add `card(id)`; store keeps cards as today (SSE `card.updated`). Pure helpers
for filtering/grouping/colour hashing go in `web/src/lib/` with unit tests in `web/test/`. Update `web/mock/server.ts`
(seed 25+ realistic v2 cards across all columns with every marker combination, history so timings show, a few legacy
cards with no v2 fields; PATCH applying the same rules closely enough for the UI) and `web/scripts/shots.ts` (board,
board detailed, later expanded, list view, sheets for proposed / blocked / done-with-timing, new ticket dialog).

## 6. Acceptance
Backend: `bun test test/` green with the isolation vars, including new tests for: v2 fields round-trip and
normalisation, permission matrix, events + history on every path, auto-review on `done ok`, no move on blocked,
later/blocked clearing rules, `GET /api/cards/PLU-12`, hire `--card` appends the brief, CLI `card show/pick/edit/
block/later/check` happy paths and errors, legacy rows (insert a row with only v1 columns) still read fine.
`bunx tsc --noEmit -p .` (or the repo's typecheck) clean.
Web: `cd web && bun run typecheck && bun run lint && bun test test/` green; `bun run build` succeeds; shots at
1440×900 and 1280×800 with zero console/page errors against the mock, then against a real sandbox server seeded via
the new CLI (drag a card, edit a section, tick a check, toggle later/urgent/blocked — confirm via `GET /api/cards/:id`).
Screenshots in `.orchestra/shots/board-v2/`.
