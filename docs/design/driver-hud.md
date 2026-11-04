# Driver HUD, live clocks, and driver-usable pass (Stage 9)

Status: DRAFT for owner/King review - 2026-11-04. Implementation waits on this
doc (CLAUDE.md spec-first). Covers Missions 2 (paper log in-app review),
3 (live layer) and Stage 9 (driver usability) of the handoff.

## 1. Boundary (unchanged, stated first)

The app is a **paper-log helper, not an ELD**. The owner will carry the
carrier's certified ELD and uses this app as his own second record, to protect
himself. Everything an ELD *shows* the driver is in scope; certification,
tamper-proof engine sync and roadside data transfer are not, and nothing may
claim them. The disclaimer stays verbatim on every HOS surface. Carrier settings
(70/8, 00:00 anchor, restart, America/New_York) are provisional defaults and are
labeled as such until the owner enters the carrier's real rules.

## 2. Home = the HUD (first thing on the page)

Order, top to bottom, phone portrait, no scrolling for items 1-4:

1. **Duty status bar** - current status (Off Duty / Sleeper / Driving / On Duty
   Not Driving) with a running "since HH:MM" in the viewer's local time.
2. **Four clock rings** - 11-hour drive remaining, 14-hour window remaining,
   30-minute break due, 70-hour cycle remaining (carrier-anchored engine).
   Tick every second from fetched duty data (no per-second network); pause when
   the tab is hidden; amber under 60 min, red under 15 min.
3. **Status change buttons** - four big buttons (min 56px). Tap = choose status,
   one confirm sheet showing the time (defaults to now, editable, never
   future-dated), location (GPS if granted, else typed), optional note. Saving
   writes a `duty_logs` row. Not usable while the vehicle is moving (see 5).
4. **News banner** (step 6 ruling: never silent) directly beneath the HUD.
5. Next step, active plan, day wrap, quick actions (existing cards).

If there is no active duty period the rings say "Clocks start when you go on
duty" - never a fabricated running clock.

## 3. Logging, made visual

- **Day graph**: the standard 24-hour four-row grid drawn from `duty_logs`, tap a
  segment to edit/delete (record-lifecycle rules apply). Shows totals per row.
- Midnight-crossing segments split at the carrier day boundary for display only.
- Every edit keeps the audit trail; deleted rows are recoverable.

**As built (2026-11-04, branch `m3-hud-b`):** Hours shows a day view
(`components/hud/DayLog.tsx`) above the list: the carrier day as the 24-hour
grid (shared `components/paper/DayGraph.tsx`), totals per status, ‹ › to step
back through the HOS window (older days stay in the list). Today stops at
"now"; time before the first row he ever logged is left blank. Tapping a
stretch opens `DayEditPanel`: change status, move the start (only between its
neighbours, never into the future), add a change inside the stretch, or
delete (soft, restorable; the confirm names which status then runs on and
until when). All through the normal duty-log API. Paper-sheet rows carry the
re-mark reminder; rows saved >5 min after their start time show "entered
after the fact". Times are entered on the carrier's clock (`lib/zoned-day.ts`,
now shared with the server's paper-log code; DST-correct). Known limit: on a
23/25-hour changeover day the graph positions use elapsed minutes, so stretches
after 02:00 are drawn up to an hour off; the edit panel's times are exact.

## 4. Live layer (all main pages)

- Supabase Realtime subscriptions per company on duty_logs, loads, expenses,
  fuel_purchases, maintenance; RLS identical to REST; throttled refetch;
  refetch-on-focus; instant local refresh after own edits.
- A "Live" indicator shows **only** while the channel is connected. On drop the
  page keeps working and claims nothing.
- Motion: ring/number transitions honor `prefers-reduced-motion`.
- Proof: two-company test on every channel (NV-3).

**As built (2026-11-04, branch `m3-hud-c`):** one channel per signed-in
tab (`components/live/LiveDataProvider.tsx`) over the tables in
`lib/live-tables.ts`; migration `00058` adds exactly those tables to the
`supabase_realtime` publication (a test keeps the two lists identical).
The channel subscribes only after a signed-in session loads, with that
token set explicitly, so it can never join as anonymous and show "Live"
while receiving nothing. Each table has a version; `useApiList`,
`useHosWindow` and `useFinancialSummary` re-fetch silently when theirs
changes. Triggers: a change event (throttled 1.5 s per table), a write
made in this tab (instant, via the `trucking:mutation` window event the
API client fires after any successful non-GET), and the page becoming
visible. Event payloads are never rendered - they only trigger a
re-fetch through the company-scoped REST API - so isolation rests on
the same RLS as the REST path plus Realtime's own RLS check. The live
two-company proof (NV-3) still has to be run against the real project.

## 5. Driving safety rules

No typing UI while moving. When GPS speed > ~5 mph (or Drive Mode is active) the
HUD shows glance-only clocks and a voice/Telegram prompt; status changes needing
input are deferred until parked. If speed is unknown the app says so.

## 6. Paper log in-app review (Mission 2)

Telegram path exists (Image Intelligence section 7: grid reader, code
cross-checks, 0.95 clean bar, 0.80 floor, proposals only). Missing, and built here:
a **review screen** - the photo beside the recreated day graph, segment by
segment, low-confidence segments flagged in red, every segment editable, one
"Save to my log" action; nothing is booked until then. After saving, the HUD
continues from the last status with no invented gap or overlap.

**As built (2026-11-04, branch `m3-hud-d`):** `/fleet/hos/paper` (photograph a
sheet; Telegram-read sheets listed too) and `/fleet/hos/paper/[id]` (review).
The grid read is stored on the document (`extracted_fields.paper_log_read`) by
both the app and the Telegram path, so the screen shows everything the reader
returned. `lib/paper-day.ts` builds the editable day with every hole explicit
and validates that 00:00–24:00 is fully covered by statuses he confirmed;
saving goes through `save_paper_log_day` (migration 00059), one transaction,
SECURITY INVOKER (RLS), conflicts acknowledged or refused, Telegram batch for
the same sheet retired. If reading is off or fails, the same screen is a
by-hand entry form for the day (a whole "missing" day he fills in). Times are
placed in the carrier time zone from HOS settings (FMCSA: home-terminal time).

**Known defect in the Telegram path (found 2026-11-04, not fixed here):**
`stagePaperLogDay` stages only the segments that cleared the bar; because a
duty row runs until the next row, a dropped or unreadable stretch mid-day is
silently absorbed into the previous status when that batch is approved. Its
"70-hour picture" line used the naive rolling 8-day sum - FIXED 2026-11-04
(King D-1): it now states the carrier-cycle before/after from the one HOS read.

**Owner ruling 2026-11-04 (naming condition):** flagged (0.80–0.95) stretches
and partial days MAY book via Telegram; the approval prompt itself names every
flagged stretch (status and times) - implemented in `stagePaperLogDay`.
Sub-0.80 stretches stay dropped and named, never staged; partial days stay
labeled partial. **Still open for a ruling:** "never filled" holds for what is
*staged*, but because a duty row runs until the next one, approving a batch
with a dropped or missing span mid-day still lets the previous status run
across that span in the app's clocks. The app review screen avoids it by
refusing to save an unresolved day; the Telegram path would need either a
by-word fill before approval or a stop-at-the-gap rule.

## 7. Telegram as the logging companion

Photos, voice, and text all become *proposals* (BOL, seal, fuel receipt, paper
log, status change). Abel can remind him to log (quiet-hours rules apply:
reports wait for morning; HOS-critical alerts are immediate), answer "how many
hours do I have left", and stage a duty change by chat for his yes. Forward
batching (one reply per burst) and BOL/seal repairs ship in step 10.

## 8. Map

Live position map on the HUD only when GPS is granted; it shows where the phone
is, not an ELD engine position. No route or fuel pins without a real data
source (Mission 4 honesty rule).

## 9. Acceptance

- Home opens on the HUD; status change in <= 3 taps; rings tick without network.
- Clocks equal the carrier-anchored engine on fixed fixtures, tested.
- "Live" never shows while disconnected, tested.
- Paper-log review: owner's own sheet recreates to his reading, verified.
- Two-company tests pass on every new read path and channel.

## 10. Build order

(a) HUD + clock rings + status sheet on Home - built, branch `m3-hud-a` (b) day graph editing
(c) live layer (d) paper-log review screen (e) Telegram logging reminders.
Each is its own branch off main with a full gate and King review.

## 11. Decisions (owner delegated, 2026-11-04 - "do what's best")

Chosen as an owner-operator would: fewest taps while rolling, nothing that
creates a legal or audit problem, and numbers that protect revenue.

1. **Status change time**: defaults to *now*; editable to a past time only
   (never future). A past time is saved with a visible "entered after the fact"
   mark and the real entry time kept in the audit trail, so a backdated log can
   never pass as live. One tap on the status button, one tap to confirm.
2. **Home order**: HUD first (status, rings, status buttons), then the news
   banner, then the next-step / active-plan / day-wrap cards. The profit-relevant
   items (detention clock running, load awaiting POD, invoice unpaid) surface in
   "Your next step" ahead of generic tips because they are the money left on the
   table; they are shown as contribution margin / receivable figures, never as
   "profit".
3. **Map**: a compact live-position card on Home only when GPS is granted and the
   phone has a recent fix (otherwise the card is absent, not blank). The full
   map, routing and guidance stay in Drive Mode, so Home stays fast and glanceable.


## 12. Home popups and live cards (owner request 2026-11-04)

The owner's standard is an ELD: act in place, never switch pages for the daily
jobs, and never see a stale number. On Home:
- **Sheets** (`components/Sheet.tsx`, accessible bottom sheet: dialog role,
  focus in/out, Tab trap, Esc/backdrop close, scroll lock, reduced-motion
  safe): the status change, and "Day log" (the editable 24-hour day with
  edit/insert/delete) open over Home. "Paper log" is one tap from the HUD.
- **Time in status** ticks beside the status, like an ELD's status line.
- **Live cards:** Day Wrap (including the proposed-records count) and the news
  banner follow the live layer; a 5-minute safety re-read covers a dropped
  channel. Live tables now include `bot_pending_actions`, `research_briefings`,
  `research_signals` (migration 00058).
- **Edit safety under live updates:** the day view tracks the picked entry by
  id, so a live change can never redirect an edit to a different entry; if the
  entry vanished, the editor closes and says so.
- **Not yet:** clocks alongside a route in Drive Mode (next).
