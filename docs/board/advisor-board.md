# Advisor: making the Sparrow board minimal and pleasant

@sage-adv, 2026-10-19. I looked at `.orchestra/shots/final/*` (the newest face-A integration), BOARD-CONTRACT §5,
FACE-BRIEF, `web/src/lib/faceA.ts`, `web/src/lib/triage.ts` and `Toolbar.tsx`. The research claims are cited at the
bottom. Claims marked *(judgment)* are my own design opinion.

## The diagnosis in one paragraph
Face A fixed the card itself: no tags, rails instead of pills, one payoff word. What still makes the board feel busy
is **everything around the cards, and colour used for too many meanings at once.** On one 1440×900 screen I count
five pastel column tints, five coloured headers, red and hatched-orange rails, eight payoff words in four colours,
about ten hashed category-dot hues, coloured initials avatars, two rows of toolbar (about 16 controls) and cryptic
header stats (`● 1 ⊘ 1 ~3d 2h 11`). The header stats are the same mistake as the old `R ▮▮▮` meters the user rejected.
The rule that fixes all of this: **absence is the default state.** A plain card means "nothing special". Colour
appears only when something needs the user: urgent, blocked, done, quick win.

## 1. The top 5 changes to how it feels day to day (ranked)

1. **Take colour back from the chrome so the signals stand out.** In `web/src/lib/boardStyle.ts` and
   `BoardColumns.tsx`: drop the column body tints and the tinted header strips. Keep one coloured state dot plus the
   label and count in a neutral header, on a white or zinc-50 board. Make category dots neutral grey: the word
   carries the meaning, and ten hashed hues are pure noise (`faceA.ts` `categoryIndex`). There are also hue
   collisions today. Proposed is violet, and so are "Worth it" and "Big bet". Review is amber, close to the blocked
   orange. Once the columns are neutral, red, orange and green are the only loud colours on the screen, so the eye
   goes straight to them. *(judgment; Linear's board uses neutral columns with a state icon in the header.)*
2. **Say less on the face. The payoff word should only appear when it changes a decision.** In `faceA.ts`
   `payoffOf`, show **Quick win** (green), **Big bet** (indigo) and **Money pit / Heavy lift** (muted warning). Leave
   `steady`, `filler` and `lowvalue` silent on the face: "Steady" on a medium/medium card says nothing. The List view
   keeps the full word for every card. The result is that about a third of the cards get a third row and the rest
   are two rows (meta + title), which is the scan speed the brief asked for. Also drop the coloured background on
   the initials avatar. One neutral avatar with the green "working" dot is enough.
3. **One row of toolbar, with the summary as the filter.** In `Toolbar.tsx`: make the header line
   `30 tickets · 4 urgent · 3 blocked · 4 later` the filter itself. Each count is a toggle, and the active one gets
   underlined. That removes the whole chip row (Urgent / Blocked / Quick wins / Later). Put Category, Assignee,
   Quick wins and Show dropped in one `Filter` popover. Final row: Search · Filter · Sort · Board|List · New ticket.
   The keyboard hint moves to `?` (a shortcut sheet) and leaves the toolbar. *(Linear puts all of this behind one
   "Display options" button, Cmd+V.)*
4. **A hover peek instead of the Compact/Detailed toggle.** Delete the density toggle (prefs.density, the
   `Detailed` branch in `CardFace`). Keep one face, Compact. Holding Space, or hovering for 600 ms, on a focused card
   shows a small popover: the problem preview, `~2h`, `0/3` checks, the blocked-on text and the full date and
   proposer. That is also where the rail's tooltip text belongs. Linear does exactly this: cards are kept small and
   Space peeks at the detail. The user gets the detail on demand and the toggle disappears.
5. **Motion and empty states, so it feels like a product and not a table.** Use 150-200 ms FLIP layout animation
   when a card leaves a column (accept, later, drop), followed by `focusAfterRemoval` (already in `triage.ts`). Add a
   subtle scale on lift while dragging. Every destructive key gets an Undo toast; `d` already has one, so give `l`
   and `a` one too. Empty states should read as calm text, not a blank column: Proposed empty says "Nothing to
   triage. Captains' proposals land here." and Review empty says "Nothing waiting on you." Finally, typography: the
   meta row at 11px zinc-400, the title at 14px medium zinc-900, and 10px gaps between cards instead of the current
   ~8px plus a border plus a shadow. Pick border **or** shadow, not both.

## 2. What to cut or hide (minimal wins)

| Item | Verdict | Why |
|---|---|---|
| Column body tints + tinted header strips | **Cut** | Colour noise, and they compete with the signals (§1.1) |
| Header stats `● 1 ⊘ 1 ~3d 2h` | **Cut** to a plain count | Cryptic glyph soup, like the rejected R/E meters. Put the estimate sum in the count's tooltip |
| Legend/filter chip row | **Cut**, merge into the summary line + Filter popover | Duplicates the summary counts |
| `Keyboard: j/k a l d u` | **Move** to `?` | Toolbar space for something used once |
| Compact/Detailed toggle | **Cut**, replace with the hover/Space peek | One face to maintain and nothing for the user to set up |
| Insights popover | **Cut from the toolbar.** Show it as one line in the Done column header tooltip (`4 done this week · est 0.8×`) | With 5 done cards the medians are noise. Bring it back as a page once there are 20+ done cards |
| Dropped toggle / column | **Hide** in the Filter popover. Dropped cards are visible in the List view | Nobody works the Dropped column |
| Done column | **Cap** at the last 7 days plus a "23 older" link that opens the List view filtered to Done | It grows forever otherwise |
| Payoff words Steady / Filler / Low value on the face | **Hide** (List view only) | §1.2 |
| Category dot hues | **Neutral** | §1.1 |
| List view `State` column | **Cut** when grouped by state (it is, in `list-1440.png`) | Says the same thing as the group header |
| List view `—` placeholders, empty Assignee/Updated columns | Blank cells; hide columns that are entirely empty | 40% of the table is dashes |
| List view `FLAGS` column | Replace with the same left rail on the row | One encoding everywhere, and the header casing is inconsistent (`FLAGS` vs `Key`) |
| New-ticket dialog sections | **Collapse**: title + a property chip row + "Add details" | Captains write most tickets through the CLI. A human needs title + Enter |

Keep: the List view (the planning surface), the Later line, `Copy for agent`, the footer's next action, keyboard
triage.

## 3. The ticket sheet: understood in 5 seconds, edited without friction

Today (`sheet-blocked.png`) "blocked" is said **four times**: a header chip, an orange banner, a toggle button and
the footer warning. Return and effort are two large segmented controls, and the property grid takes the top ~260 px.
The brief does not start until about y=500.

Order, top to bottom:
1. **Header line:** `PLU-21` (copy) · state pill (dropdown) · on the right `Copy for agent ▾`, a split button that
   merges the `>_` pick-command button, then close.
2. **Title**, large and editable inline.
3. **One property sentence** instead of the grid: `High return · Low effort → Quick win · ~30m · security ·
   Unassigned · proposed by @captain 5d ago`. Every token is a click-to-edit popover, like Linear's property chips.
   Urgent shows as a red word in this line, and only when it is set. Tags go at the end, in grey.
4. **The signal banner, only when it applies:** blocked (orange, `Blocked on IT: NetSuite sandbox access · 2d ·
   Unblock`) or urgent. One place only, so delete the header chips and the toggle buttons. Urgent, Blocked and Later
   move to the `⋯` menu, to the keys `u`, `b` and `l`, and to the banner.
5. **Brief:** no boxed cards, just headings with 16px spacing. I would order it **Problem → Done when → Approach →
   Context**, because "what's wrong and how we'll know it's fixed" is the 5-second read and context is background.
   This contradicts the contract's Context-first order, so the captain has to decide; it is *(judgment)*. Empty
   sections collapse into one muted line: `+ Context  + Approach`.
6. **Timing:** only in Review and Done, collapsed to one line (`Est 1h 30m · Build 2h 40m (1.8× over) · Review 55m`)
   that expands to the milestones and the stacked bar.
7. **Activity:** comments in full. Consecutive move events fold into one line, `Moved To do → In progress → Review →
   In progress → Review → Done · over 5d`. In `sheet/activity.tsx` that is a pure fold that belongs in a lib with a
   test.
8. **Sticky footer:** keep it. It is the best part of the sheet. When blocked, the primary button becomes
   `Unblock`, which replaces the warning text.

## 4. Triage for a 30-60 card Proposed backlog

The Later line plus j/k/a/l/d is the right set of **verbs**. The **surface** is wrong: a 270px kanban column that
shows about 8 cards is a poor place to compare 60. Linear gives triage its own Inbox view with single keys (1 accept,
3 decline, H snooze) and a detail pane. Superhuman's whole model is "one decision per item, then it leaves the
list".

Recommendation: a **Triage mode**, a split view and not one card at a time.
- Enter it by pressing `t`, or clicking the Proposed count. On the left is the List view filtered to Proposed, not
  shelved, sorted oldest first. On the right is the ticket sheet as a fixed pane. j/k moves and the pane follows.
- Keys as in `triage.ts`: `a` accept, `l` later, `d` drop, `u` urgent, `1-3` / `⇧1-3` return / effort, plus `b`
  for blocked. After any accept, later or drop the row animates out and focus advances. A header counter shows
  `12 left`, and at zero you see "Triage done", a small reward moment.
- Why not one card at a time, full screen: with 60 cards you need to see neighbours to spot duplicates and to rank.
  The split view gives the focus of a single card plus the context of the list. *(judgment)*
- Later needs a **review rhythm**, or it becomes a graveyard. Things 3 treats Someday as an incubator reviewed
  weekly. Linear's snooze resurfaces items. Minimal version: no snooze dates. Show `Later · 7 · oldest 21d` on the
  line, and offer "Review Later" in Triage mode as a second pass over the shelved cards.
- Keep the board's hover QuickActions for one-off triage. Triage mode is for the batch.

## 5. Changes to BOARD-CONTRACT.md / FACE-BRIEF.md (plan-level)

1. **Contract §5 still says to pair urgent, blocked and quick win with text** ("flame + 'Urgent'", "'Blocked ·
   <on>'"), along with R/E meters, tag chips in Detailed, a chip toolbar and column tints. FACE-BRIEF overrode the
   face, but the contract is still the spec builders read. Rewrite the colour system as: *neutral chrome; colour
   only for urgent (red solid rail), blocked (orange hatched rail), quick win (green word), done (green check); the
   rail's pattern + a tooltip are the non-colour cue.* This is the same idea as Trello's colour-blind mode, which
   adds patterns to colour labels and collapses labels to colour-only on the board.
2. **Add a chrome budget:** at most one toolbar row with 5 controls, column headers = dot + name + count, and any
   new control has to replace one.
3. **Add the missing interaction specs:** Space/hover peek, Triage mode (§4), Undo on every key action, empty-state
   copy, motion timings, the Done column cap, and `?` for the shortcut sheet.
4. **Payoff vocabulary:** 8 words is a lot to learn. The brief should say which words are shown on the face and that
   "no word" is a valid, meaningful state.
5. **Drop "Insights" from the stretch scope** until there are enough done cards. A fake-precise median of 5 points
   is worse than nothing.
6. **Sheet order and duplication:** say explicitly that each signal appears in exactly one place in the sheet, and
   settle the section order (§3.5).
7. **New ticket:** title-first quick create is the spec; the full form is the expanded state.

## Not verified
I did not check Height, Plane, Shortcut or GitHub Projects in the time box. Nothing above depends on them. GitHub
Projects' field-visibility settings are a similar idea to Linear's display options, but I did not confirm it this
session.

## Sources
- Linear Triage keys (1 accept, 2 duplicate, 3 decline, H snooze, G T): https://linear.app/docs/triage
- Linear Snooze (hides, then resurfaces): https://linear.app/docs/snooze
- Linear Display options (one control for grouping, ordering and shown properties; Cmd+V, Cmd+B):
  https://linear.app/docs/display-options
- Linear Board layout (limited card room; Space peeks; hide columns): https://linear.app/docs/board-layout
- Linear Priority (only 5 levels, none sorted last): https://linear.app/docs/priority
- Trello labels (colour-only by default, `;` toggles names; colour-blind mode adds patterns):
  https://support.atlassian.com/trello/docs/adding-labels-to-cards/ ,
  https://wearecolorblind.com/examples/trello-colorblind-friendly-mode/
- Things 3 Someday as an incubator with a weekly review: https://vanja.io/things-3-complete-guide/
- Superhuman one decision per message, inbox as a to-do list: https://blog.superhuman.com/inbox-zero-in-7-steps/
