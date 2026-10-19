# Card face redesign — exploration brief

## The user's verdict on the current face (screenshot of the board, Detailed density)
"Everything is perfect, only last few changes required: R, E are shown as signals, wtf is that UI? Blocked, Urgent and
other tags can be represented via color, no need to write them as tags. I can see the tags by clicking on the ticket,
no need to see them at the bottom; color coding can segregate. I want you to be innovative, this could look much
better. Think more, see what others are doing, build a good product that feels good enough to be used."

Today's face (web/src/components/board/CardFace.tsx, `ClassicFace`): key + category chip + age; title; (detailed:
one-line problem preview); an orange "Blocked · on …" text line; a row of text pills "Urgent", "Quick win", `R ▮▮▮`
`E ▮▯▯` signal-bar meters, `~2h`, `✓ 0/3`, comments, `@captain`; (detailed: tag chips). Too many words, cryptic meters.

## What every variant must do
- **No signal bars.** Return (impact) and effort must read instantly without a legend, or through one tiny legend.
- **Urgent / Blocked / Quick win / Later are NOT text pills on the face.** Encode them with colour + a shape/position
  (so they stay distinguishable for colour-blind users: e.g. solid red rail for urgent, hatched/striped orange for
  blocked). The blocked-on text ("IT: NetSuite access") lives in a hover tooltip and in the sheet, not on the face.
- **No tags on the face** in either density. Category stays (it is the one primary bucket), but quieter than today.
- Keep the information the user asked for: key (PLU-12), title, category, age/proposed time (tooltip with full
  date/time and proposer), assignee, comment count; Detailed adds the one-line problem preview, estimate and checks
  progress. Done cards read as done (green). Shelved (Later) cards read as parked (muted).
- Compact density should be ~3 short rows; Detailed ≤ 5. Skimming 30 cards must be fast: title is the hero.
- Keep the hover QuickActions (`QuickActions` exported from CardFace.tsx), the `onClick={onOpen}` root, and the root
  data attributes `data-card-id data-key data-urgent data-blocked data-later` (e2e scripts use them).
- Light theme, consistent with the app (zinc neutrals, the column colours in web/src/lib/boardStyle.ts). No emoji.
- Use the helpers: `isQuickWin`, `roiScore`, `cardKey`, `formatEstimate`, `cardTimings` (@shared/cards),
  `isShelved`, `commentCount`, `previewOf`, `whoName`, `fullDate`, `ago`, markers.tsx pieces where they still fit.

## Inspiration to study (look at real screenshots/docs, 10 minutes max)
Linear (issue cards: ID, title, tiny property icons, avatar initials), Height, Plane, Shortcut (story cards),
Trello (colour label strips without text), GitHub Projects, Jira (priority glyphs, story-point bubbles), Things 3
(calm minimalism), Asana. Steal the best ideas, not the look.

## Where
Your variant file only: `web/src/components/board/faces/Face<A|B|C>.tsx` (+ optional helpers
`web/src/lib/face<A|B|C>*.ts` with tests). Do not edit any other file; if you need a shared change, `sparrow ask` the
captain. Preview with `?face=a|b|c` in the URL query BEFORE the hash, e.g.
`http://127.0.0.1:<vite port>/?face=a#/board?p=plutus`.
Run your own mock + vite on your own ports (don't build web/dist; others share it):
`cd web && bun mock/server.ts --port <mock port> --quiet &` and `VITE_API=http://127.0.0.1:<mock port> bunx vite --port <vite port> --strictPort &`
(stop exactly those processes by PID when done; never `pkill -f`).
Screenshots: write your own puppeteer script in `web/scripts/face-<a|b|c>-shots.ts` (pattern: web/scripts/shots.ts);
1440x900 board Compact, board Detailed, Later expanded, and a 2x zoomed crop of 4 representative cards (urgent,
blocked, quick win, done, shelved, plain, legacy) to `.orchestra/shots/faces/<a|b|c>-*.png`. Look at them critically,
iterate at least twice, and only report when you would be proud to ship it.

## Acceptance
`cd web && bun run typecheck && bun run lint && bun test test/` green (ignore warnings in files that aren't yours).
Report with `sparrow done`: the idea in 3 lines, how each signal is encoded (a small table), screenshot paths, and what
you'd still improve.
