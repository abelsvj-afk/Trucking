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

## 4. Live layer (all main pages)

- Supabase Realtime subscriptions per company on duty_logs, loads, expenses,
  fuel_purchases, maintenance; RLS identical to REST; throttled refetch;
  refetch-on-focus; instant local refresh after own edits.
- A "Live" indicator shows **only** while the channel is connected. On drop the
  page keeps working and claims nothing.
- Motion: ring/number transitions honor `prefers-reduced-motion`.
- Proof: two-company test on every channel (NV-3).

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

(a) HUD + clock rings + status sheet on Home/Hours (b) day graph editing
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
