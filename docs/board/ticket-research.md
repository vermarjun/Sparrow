# Sparrow board — ticket readability & triage digest

Scope: how to make a work card fast to skim and easy to understand for both a human
planner and the AI agent that picks it up. Research only; maps to the live schema in
`src/shared/types.ts` (`title`, `context`, `problem`, `approach`, `checks[]`, `urgent`,
`impact`, `effort`, `estimate_min`, `blocked_on`, `later_at`, `category`, `tags`).

---

## TL;DR — recommendations first

1. **Keep the order Context → Problem → Approach → Done-when**, but treat the **title as the BLUF**: one
   outcome-first sentence. The four sections already follow SCQA (Situation=Context, Complication=Problem,
   Question=implicit, Answer=Approach), and "Done-when" is the acceptance test [1][2].
2. **Card face = title + 2 badges (impact, effort) + category chip + state icons (urgent/blocked).**
   Show nothing else. Title first, left-aligned. Never encode meaning in colour alone — pair every colour with
   a shape/icon/label; avoid red-green [3][4].
3. **Enforce tight per-section limits** (Context ≤ 2 lines, Problem = observed vs expected in ≤ 3 lines,
   Approach ≤ 5 lines of plain English with **no code**, Done-when = 2–7 binary, testable checks). Use active
   voice, short sentences [5][6][7].
4. **Prioritise with an impact × effort 2×2 ("quick wins first"), not a full RICE score.** `urgent` is a
   boolean override, not a score. For estimates, always apply an outside-view multiplier (×1.5–2) because of
   the planning fallacy, and record actual time for later reference [8][9][10].
5. **Backlog hygiene that measurably speeds triage:** a "Later" icebox shelf, staleness flag, per-column WIP
   limits (Little's Law), and blocked cards sorting to the top of their column [11][12].

---

## 1. Section order and naming (minimise reading effort)

- **BLUF / Minto pyramid:** lead with the conclusion; readers skim top-down and stop when they have enough [1].
  The conclusion is the **title** — do not add a separate TL;DR paragraph (it duplicates the title and the
  Problem line). A title like "Add `--limit` to `card list`" already tells a planner whether to keep reading.
- **SCQA mapping:** Context = Situation, Problem = Complication, Approach = Answer to the implicit Question
  ("what should we do?"). Done-when is the acceptance gate, so it stays last. **Context → Problem → Approach →
  Done-when is the right order** — it matches both SCQA and the universal bug-report convention
  (context, expected-vs-actual, fix, verification) [2][7].
- **Chunking / working memory:** each section is one chunk; keep each ≤ ~3 items or short lines. Working memory
  holds roughly 4 chunks (Miller's classic "7±2" was revised down) — so 4 sections is already at the ceiling;
  do not add more sections [13].
- **Progressive disclosure:** the card face shows only the title + markers; the full four sections live in the
  side sheet, revealed on click [14].

**Final names + one-line prompt each** (keep the existing names; they're plain and unambiguous):

| Section | 1-line prompt for the proposer |
|---|---|
| **Title** | "One outcome-first sentence: what changes for whom." |
| **Context** | "Why this exists now — who asked, where it came from, what it unblocks (≤ 2 lines)." |
| **Problem** | "What is wrong today: Observed X, Expected Y (≤ 3 lines)." |
| **Approach** | "Plain-English proposal of the fix — no code (≤ 5 lines)." |
| **Done when** | "2–7 checks, each binary and verifiable by someone other than you." |

---

## 2. The card FACE (30+ cards, seconds)

- **Show, in order:** title (left, top) → category chip → impact badge → effort badge → urgent ⚠ / blocked ⛔
  icon → assignee @handle. **Hide:** context/problem/approach/checks, estimate, tags, notes count, timestamps
  (until hover/click).
- **First item = title.** The eye reads left-to-right top-to-bottom; a strong verb-first title is the single
  fastest skim cue [3].
- **Badge limit: 2.** impact + effort. `urgent`, `blocked`, `later` are **state icons, not badges** — they carry
  shape/position meaning and don't add to the badge count. Beyond ~3 visual markers per card, pre-attentive
  "pop-out" collapses into serial search and skimming speed drops sharply [3].
- **Pre-attentive attributes** (colour, position, shape, size) are processed in <200 ms without conscious
  attention, but only when each signal is **unique and non-conflicting**; a red circle among red squares and
  blue circles does *not* pop out (conjunction search) [3].
- **Colour rules:** reserve colour for **state/urgency only** (e.g. urgent = amber, blocked = red), one hue per
  meaning. **Never colour-only:** ~8% of men are red-green colourblind (deuteranopia/protanopia), so pair every
  colour with an icon or text (⚠/⛔). Prefer blue + amber (a "colour-blind-safe" pair) over red + green; keep
  hue differences plus a redundant symbol [4][15].
- Position is a free, strong channel: blocked cards pin to the top of their column; "later" cards drop below a
  visible fold line. Position carries meaning without consuming a badge or a colour [3].

---

## 3. Writing rules per section (AI proposer must follow)

Use active voice, concrete nouns, and short sentences (avg ~15 words, max 25) [6]. No passive "should be
improved". Every rule is enforced at write time, not read time.

**Title** — ≤ 70 chars, verb-first, names the observable outcome.
- ✅ "Show `estimate vs actual` on done cards"
- ❌ "Regarding timing improvements on cards"

**Context** — ≤ 2 lines / ~40 words. Who/what/when; a pointer, not history.
- ✅ "From Monday's meet with Shubhankar — customers report onboarding takes 3 days."
- ❌ "In our ongoing effort to continuously improve the product experience across many touchpoints, and in
  light of various conversations over the last several weeks, we have identified that there may be an
  opportunity to consider improving onboarding in some way."

**Problem** — ≤ 3 lines. Always **Observed vs Expected** (the two facts that make it actionable).
- ✅ "Observed: `card list` prints 40 cards with no cap. Expected: a `--limit` flag caps output."
- ❌ "The list command is kind of bad and could be better."

**Approach** — ≤ 5 lines / ~80 words. Plain English, **zero code**, no "then just". State the shape of the
change and the main risk/alternative if relevant.
- ✅ "Add an optional `--limit N` flag (default 20). Reuse the existing pagination helper; no schema change."
- ❌ "Refactor the list function to accept a `limit` param, `slice(0, limit)`, guard against `NaN`, add tests…"

**Done when** — 2–7 checks, each one sentence, **binary and verifiable** (pass/fail, not a vibe). Someone
other than the author can check each without asking.
- ✅ "`sparrow card list --limit 3` prints exactly 3 cards." / "No flag → prints 20." / "`--limit 0` errors cleanly."
- ❌ "The list feature is improved." / "Handle edge cases properly." / "Tests pass." (untestable / not specific)

---

## 4. Prioritisation signals + estimation

- **Impact × Effort 2×2 is the primary tool.** Sort "high impact + low effort" (quick wins) first, then high/high
  (bet), low/low (fill-in), low/high (don't). This is the value/effort matrix underlying ICE and the "Quick
  Wins" quadrant in RICE breakdowns [8][10]. Two badges (`impact`, `effort`) are enough to sort; a full RICE
  number is overkill for a personal board.
- **ICE** (Impact × Confidence × Ease, 1–10) and **RICE** (Reach × Impact × Confidence ÷ Effort) are for
  **large, contested backlogs**; use them to batch-rank occasionally, not to score every card [8][10]. ICE is
  for fast triage, RICE for build-slot decisions; don't mix the two scales in one ranking [10].
- **Eisenhower urgent-vs-important:** `urgent` (boolean) is the "do now" axis; `impact` is the "important" axis.
  Model them as two independent fields rather than one 2×2, so the planner can filter "urgent" without
  conflating it with "valuable" [9].
- **Estimation (planning fallacy):** people systematically underestimate their own task times (Kahneman &
  Tversky 1979); in one study students finished ~68% of projects later than predicted (Buehler, Griffin & Ross
  1994) [9]. Counter with the **outside view**: instead of "how will I do this", ask "how long did similar
  cards take" and multiply the inside estimate by ~1.5–2×. Show **estimate vs actual** side-by-side once a card
  hits Done — the feed-forward loop is what calibrates future estimates (reference-class forecasting) [9].
- **Presenting it:** on the face show `impact`/`effort` (drives quick-win sort) and `estimate_min` in a dim
  muted text (it's a guess, not a fact). Don't show a raw estimate before the plan exists.

---

## 5. Triage hygiene for a large Proposed backlog

- **Later / icebox:** a dedicated `later_at` shelf below a fold line removes parked ideas from the active
  skim; revisit on a fixed cadence (weekly) rather than letting them rot silently [12][16].
- **Staleness:** flag cards untouched > N days (e.g. 14) in Proposed; stale cards either get details or get
  shelved. Staleness is the single cheapest signal that a ticket has gone cold.
- **WIP limits per column:** cap "In progress" (e.g. 2). Little's Law says cycle time ≈ WIP / throughput, so
  lower WIP shortens time-to-done; WIP limits force finishing before starting [11].
- **Blocked-first:** sort blocked cards to the top of their column and surface `blocked_on` ("on whom/what") as
  an icon + short text. Unblocking is often the highest-leverage 5 minutes for the whole board.
- **Dedupe at intake:** title search against existing cards before proposing (GitHub's own templates tell
  reporters to check for duplicates first) [7].
- **One card, one job:** Shape Up's "appetite + pitch" practice — a card should be a shippable chunk, not a
  project. Split anything whose "Done when" list exceeds ~7 checks [12][16].

---

## Ticket writing guide (paste into agent prompts)

```
Write every ticket so a human can triage it in ~5 seconds and an AI can start it without asking questions.

Title      One outcome-first sentence (≤70 chars, verb first): "what changes for whom."
Context    Why now — who asked / where from / what it unblocks. ≤2 lines.
Problem    "Observed: <what happens>. Expected: <what should happen>." ≤3 lines. Never "it's bad."
Approach   Plain-English fix shape, NO code, ≤5 lines. Name the main risk/alternative if any.
Done when  2–7 checks. Each is one sentence, binary (pass/fail), verifiable without asking you.
           No "tests pass" or "improve the feature".

Markers    urgent = boolean (true only if it blocks someone right now).
           impact/effort = low|medium|high (pick honestly; they drive "quick win" sorting).
           blocked_on = "who/what" you are waiting on, or empty.
           estimate_min = honest guess; then double it (planning fallacy).

Rules      Active voice, short sentences. No code in Approach. No emojis. One card = one shippable job.
           Search existing cards first; don't duplicate. If "Done when" needs >7 checks, split the card.
```

---

## Sources

- [1] Barbara Minto, *The Pyramid Principle* (SCQ Framework) — barbaraminto.com/concept
- [2] SCQA: Situation-Complication-Question-Answer — barbaraminto.com ; Jackson MS summary PDF (2026)
- [3] Pre-attentive attributes & <200 ms pop-out, conjunction-search failure — Fusco et al., *Visual Perception
  and Pre-Attentive Attributes*, PMC12292122 (2025); Colin Ware, *Information Visualization: Perception for Design*
- [4] Red-green confusions in deuteranopia/protanopia — NIST, *Color Perceptions of Deuteranopic and Protanopic
  Observers*, J. Res. NBS 41(4) 1948; Datylon, "Best charts for colourblind viewers" (2022)
- [5] Google developer documentation style guide — "Paragraph structure" (key point first, ≤5–6 sentences),
  "Sentence structure", "Write for a global audience" — developers.google.com/style
- [6] Plain-language sentence length (avg 15, max 25 words) — Australian Govt Style Manual,
  stylemanual.gov.au ; ONS "Plain language" (80% prefer plain language)
- [7] GitHub issue-form templates & bug-report convention (expected vs actual, steps to reproduce, dedupe) —
  docs.github.com ; stevemao/github-issue-templates ; GitHub community "Best practices for writing issues"
- [8] RICE: Reach × Impact × Confidence ÷ Effort — Intercom, "RICE: simple prioritization for product managers"
  (Sean McBride); ICE — Sean Ellis growth practice
- [9] Planning fallacy — Kahneman & Tversky 1979; Buehler, Griffin & Ross 1994 (students ~68% late),
  JPSP 66:366; Eisenhower urgent/important — S. Covey, *First Things First*
- [10] RICE "Quick Wins" quadrant & ICE-for-fast-triage, don't mix scales — productfolio.com ; RizwanZafaris
  product-manager-OS rice-scoring-sheet.md
- [11] WIP limits & Little's Law (cycle time ≈ WIP/throughput) — D. Anderson, *Kanban*
- [12] Shape Up: appetite, pitch, betting table, "later" shelf — Basecamp, basecamp.com/shapeup (R. Singer)
- [13] Working-memory capacity ~4 chunks — G. Miller (1956) "The Magical Number Seven"; N. Cowan (2001)
- [14] Progressive disclosure — J. Nielsen, nngroup.com
- [15] ~8% male red-green colourblindness; pair colour with icon/text — NIH/NEI prevalence; PMC12292122
- [16] Icebox / backlog triage — product schools' prioritization guides (productfolio.com, tempo.io RICE guides)
