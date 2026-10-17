# Remove group chat; updates become quiet DM deliveries

Owner-approved 17 Oct 2026. `src/shared/types.ts` is unfrozen for this change only.

## Goal

All communication is DMs. An agent's `sparrow update` goes to the DM thread with its parent and
is handed to the parent *only together with* something that wakes it (a result, a question, a
terminal system notice), or when the parent's `inbox --wait N` timer runs out. The human captain
never sees second-level traffic (a sub-captain's children report to the sub-captain only).

## 1. Quiet deliveries (server)

- `deliveries` gets a column `wake INTEGER NOT NULL DEFAULT 1` (add it with `ALTER TABLE` when an
  existing DB lacks it). `Delivery` in `src/shared/types.ts` gets `wake: boolean`.
- A **quiet** delivery (`wake = 0`) is pending like any other but:
  - never triggers `wake()` / a spawn / dequeue,
  - never resolves an `inbox --wait` long-poll early,
  - never blocks `done` / `ask` / `wait` (amendment A1 counts **waking** pending deliveries only).
- Whenever a recipient's pending deliveries are handed over (piggyback `inbox` on any response,
  `GET /api/inbox`, the envelope of a new call, turn-end delivery), quiet ones go too, in seq order.
  A call is still only started when ≥1 *waking* delivery is pending.
- `dropPending` (release) drops both kinds.
- `Message.mentions` keeps meaning "agent ids woken by this message"; quiet recipients are not in it.

## 2. What posts what

| Action | Thread | Delivery to parent |
|---|---|---|
| `update {text}` | DM caller ↔ parent, kind `update` | quiet |
| `wait {reason}` | DM caller ↔ parent, kind `update`, text `waiting: <reason>` | quiet |
| FYI system notices (`fyiParent`: restarting, restart queued, quiet nudge) | DM parent ↔ agent, kind `system` | quiet |
| `done` / `ask` / terminal notices (`notifyParent`) | unchanged | waking |
| `send @h` | unchanged (any agent may DM any non-retired agent in the project) | waking |

- No parent (the human captain): `update` → 400 `"@captain has no parent; updates go to a parent. Use sparrow card note to annotate a card."`;
  `wait` records no message (still sets `last_update`) and ends normally.
- `update` still sets `last_update(_at)` and appends a card note with `card_id`.
- The `'group'` fallback for the crash-restart-queued thread goes away (every spawned agent has a parent).

## 3. Group chat removed

- `send {to:'group'|'@group'}` → 400 `"Group chat was removed. DM a teammate: sparrow send @<handle> \"…\""`. @mention waking is gone.
- `'group'` stays a reserved handle.
- Old `thread = 'group'` rows stay in the DB but are hidden: `GET /api/threads` omits them, `GET /api/messages` filters them out, `?thread=group` returns `[]`.
- CLI: `sparrow send group …` and `sparrow log group` → usage error that says group chat was removed. Usage strings drop `group`.
- Types: `SendReq.to` comment, `Message.thread` comment (`'dm:<a>:<b>'` only), `thread_label` comment.

## 4. Inbox wait returns a team digest

- `GET /api/inbox?wait=N` (and without `wait`) returns `{inbox, team}` where
  `team: TeamStatus[]` lists the caller's non-retired children whose state is not `idle`:
  `{handle, resume, harness, state, call_started_at: number|null, last_update: string|null, last_update_at: number|null}`.
  Add `TeamStatus` to `src/shared/types.ts`. Other endpoints do not add `team`.
- Behaviour is otherwise as before: returns early on the first **waking** delivery, else at the timer.

## 5. CLI rendering (`src/cli/format.ts`, `src/cli/main.ts`)

The inbox block groups messages **by the agent they are about** (sender, or `meta.about` for
system notices), in seq order inside each group, with `hh:mm:ss` times:

```
━━ 📨 3 new messages for @captain ━━
── @james · builder · done ok · call 5m02s ──
  14:02:10  update  schema done; next API
  14:04:55  update  API done; tests next
  14:07:12  result (ok)
    <full result text>
── @maya (DM) ──
  14:06:00  question  Which port?
━━ Act on these before you finish. ━━
```

- Updates print in full (they are short). Results / questions / tasks / chats print full text indented.
- After the block, `sparrow inbox` prints the team digest (when `team` is non-empty):
  ```
  Still working:
    @leo · builder-codex · working 12m · last update 8m ago: wiring the API
    @iris · verifier · working 3m · no update yet
  ```
- On timeout with no messages: `No new messages (waited 600s).` followed by the digest. With no
  messages and no working children: just the first line.

## 6. Agent envelope (`src/server/prompts.ts`)

The envelope a woken agent gets uses the same grouping: per child, its updates with times, then
its result/question/notice. Quiet-only pending sets never start a call, so an envelope always has
≥1 waking message.

## 7. Docs, prompts, UI (track B)

- `assets/protocol.md`, `assets/captain.md`, `assets/skills/sparrow-captain/SKILL.md`,
  `assets/skills/sparrow-worker/SKILL.md`, resumes: no group chat; "updates go to your parent's DM
  and are delivered together with your result (they never interrupt anyone)". Remove `send group`
  examples and the `[group from …]` inbox example. Captain skill: describe the bundle and the
  timeout digest.
- `docs/DESIGN.md`: §3.3, §3.4, §3.6, §4 (`/api/inbox` returns `team`), §5 (CLI usage + inbox
  block example), §7 envelope, §9 Chat page, §10 replace A4 with: "an `update` wakes nobody and
  arrives bundled with the agent's result; `inbox --wait` timing out shows each working child's
  latest update", §11 add amendment A5 describing quiet deliveries.
- `web/`: Chat page shows DM threads only (no Group entry, no group special-casing in
  `lib/reduce.ts`, `lib/format.ts`). Updates already render as small muted lines; keep that.
  `cd web && bun install && bun run build` must pass.
