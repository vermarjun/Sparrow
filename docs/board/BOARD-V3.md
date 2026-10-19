# Board v3: minimal pass (supersedes BOARD-CONTRACT §5 wherever they differ)

Source: `.orchestra/advisor-board.md` (read it), filtered by the captain. Rule: **absence is the default.** A plain card
means "nothing special"; colour appears only when something needs the user.

## Colour system (the only loud colours on screen)
- Urgent: solid red rail. Blocked: orange 45° hatched rail. Done: green check + green key. Quick win: green word.
  Pattern + tooltip are the non-colour cue. Swatches come from `web/src/lib/swatchStyle.ts` / `components/board/swatch.tsx`.
- Columns: NO body tints, NO tinted header strips. Board background zinc-50, columns white-ish/neutral; each column
  keeps its state colour only as the header dot and a 2px top line in that colour (boardStyle.ts).
- Category: keep the hashed hue on the small dot (user likes colour coding), text muted. Avatars: neutral (zinc), green
  "working" dot only.
- Payoff words on the face: only **Quick win** (green), **Worth it** and **Big bet** (indigo), **Heavy lift / Money pit**
  (muted warm). Steady / Filler / Low value / partial ("High return") show nothing on the face (List view keeps all).
- Pick border OR shadow for cards, not both; 10px gap; title 14px medium zinc-900; meta 11px zinc-400.

## Chrome budget
- ONE toolbar row, ≤ 5 controls: Search · Filter (popover) · Sort · Board|List · New ticket.
- The title line `Board  30 tickets · 4 urgent · 3 blocked · 4 later` IS the urgent/blocked/later filter: each count is a
  toggle (active = underlined/coloured). Category, Assignee, Quick wins, Show dropped live in the Filter popover.
- No Compact/Detailed toggle (one face). No Insights button. No keyboard hint in the toolbar: `?` opens a shortcut sheet.
- Column header = dot + name + count. Estimate sum and urgent/blocked/stale counts go in the count's tooltip. The Done
  header tooltip also carries the one-line insight (`4 done this week · est 0.8× median`).
- Later line: `Later · 7 · oldest 21d`.
- Done column shows the last 7 days + an `N older` link that opens the List view filtered to Done.

## Interactions
- Peek: hover 600ms or Space on a focused card → small popover with problem preview, estimate, checks x/y, blocked-on
  text, full proposed date + proposer, payoff in words ("Return high · Effort low").
- Motion: 150-200ms layout animation when a card leaves/enters a column; subtle lift while dragging.
- Undo toast on every key action (a, l, d, u, 1-3), not just d.
- Empty states: Proposed "Nothing to triage. Captains' proposals land here." To do "Nothing queued." In progress
  "Nothing in flight." Review "Nothing waiting on you." Done "Nothing finished this week."
- `?` shortcut sheet. `t` (or clicking the Proposed count) opens Triage mode.

## Triage mode (new)
Split view replacing the board: left = Proposed list (not shelved, oldest first, compact rows with rail + payoff +
age), right = the ticket as a fixed pane. j/k moves, pane follows; a/l/d/u/b/1-3/⇧1-3 act; acted row animates out,
focus advances; header `12 left`; at zero a calm "Triage done" state with "Review Later (7)" as a second pass over
shelved cards. Esc exits.

## Ticket sheet
Order: header (key+copy · state pill dropdown · `Copy for agent ▾` split button that also offers "Copy pick command" ·
`⋯` menu with Urgent/Blocked/Later/Drop · close) → title (inline edit) → ONE property sentence of click-to-edit tokens:
`High return · Low effort → Quick win · ~30m · security · Unassigned · proposed by @captain 5d ago · tags…` (urgent
shows as a red word here only when set) → signal banner only when blocked (orange, with Unblock) → brief sections
**Context → Problem → Approach → Done when** (the USER's order; keep it), unboxed, headings + spacing, empty ones
collapsed to one muted line `+ Context  + Approach` → More details (only if non-empty or being added) → Timing only in
Review/Done, one collapsed line that expands → Activity with consecutive move events folded into one line → sticky
footer (primary becomes Unblock when blocked). Each signal appears in exactly ONE place.
`TicketSheet` gains `mode?: 'sheet' | 'pane'` (pane = inline, no overlay, no close-on-outside) for Triage mode.

## New ticket
Quick create: title + a row of property chips (state, category, urgent, return, effort, estimate) + "Add details"
which expands the four sections. Enter creates.

## List view
Drop the State column when grouped by state; blank cells instead of dashes; hide all-empty columns; the row's left
edge carries the same rail as cards (remove the Flags column if the rail + Later moon cover it); consistent header case.
