# Driver HUD — owner requirements round 2 (design)

Source: the owner's road dictation, 2026-11-05 night (relayed by King). Sequence A → B → C, a full gate per block. Extends `docs/design/driver-hud.md` (§5 driving lockout, §2 clocks) and `docs/design/logging-reminders.md`. Paper-log **helper, not an ELD** — nothing here is a certified record.

## Block A — duty status can never trap the driver

**A1. The status switcher is exempt from every motion/parked gate, permanently.**
- Home HUD status buttons are never disabled by motion. The status sheet is not wrapped in `StoppedGate`. The sheet's form is marked `data-motion-exempt`, and `setFormsInert` now honours that mark on **forms** as well as loose controls (it only did for loose controls — this was the trap: the form was made inert while moving).
- While moving (or speed unknown) the sheet is the **quick** variant: no text fields, one large button, time = now. Typing while rolling stays impossible; changing status does not. When stopped it is the full form (backdating, location, note) as before. The variant follows live motion.
- `MotionLock`'s lock banner gains a **Switch to Driving** button whenever the log is not already Driving (it only appeared in the slow-creep mismatch prompt — at ≥15 mph with a non-driving status the owner had no way out). The banner is `data-motion-exempt`.
- Drive Mode's status prompt uses the same quick sheet (no `StoppedGate`).
- Still gated on purpose (not the switch path): editing/backdating a day (Day log, Paper log, the full duty-log forms), and every other form while Driving + moving (audit P1 preserved). HUD, the status switcher, and the AI-authorization switches stay live.
- Guard: tests assert the buttons are enabled while moving, the sheet is exempt, and `setFormsInert` leaves exempt forms alone.

**A2. Motion-based auto-switch to Driving** (status Off duty / Sleeper / On duty not driving).
- *Sustained motion* (`lib/sustained-motion.ts`, pure): consecutive GPS fixes with speed ≥ **5 mph** while the bubble estimator also says moving, continuously for **60 s**. A dip below 5 mph shorter than 15 s does not reset it (stop-and-go); a gap of > 20 s between fixes (tunnel, lost GPS) resets it — no evidence is not motion. Dock creep (< 5 mph) and GPS jitter at a standstill (estimator says stopped / speed ≈ 0) never accumulate.
- At detection (60 s) the mismatch prompt is shown (unchanged copy plus a countdown note); if motion **continues** for a further **30 s grace** with the status still non-driving, the app auto-switches. "Not now" dismisses the prompt, not the auto-switch (driving unlogged is the violation this prevents); the in-app notice carries a one-tap way to change it back.
- *Stamp:* `POST /api/v1/duty-logs/auto-motion` inserts a Driving row with `started_at` = the **detection time** (never earlier), `source = 'auto_motion'` (migration 00072; the note also says "Automatic: switched by detected truck motion at …" so an unmigrated database still records it), and sends the Telegram/in-app notice "Switched to Driving at [time ET] — truck moving."
- *Never rewrites history:* the server refuses (200, `switched:false`) if the latest row is already Driving, or if the latest row started at/after the detection time (a manual change won the race), or if the log is empty (unknown status is not assumed). Idempotent per detection (`submission_id`). detected_at must be ≤ 10 min old and not in the future.
- Failure to reach the server leaves the manual prompt on screen and retries a few times; it never loops or double-switches.

**A3. Reverse case:** status Driving but **stationary ≥ 5 min** (positive stopped fixes, gaps reset it) → a prompt "Stopped for 5 minutes — still driving?" with **On duty** and **Off duty** one-tap buttons (quick save, time = now). **Prompt only; never an auto-switch out of Driving.** Dismissed until the next move-then-stop cycle.

## Block B — HOS clocks: escalation and plain-language consequences
(designed here, built after A)
- Ring tone from the **same** `computeHudClocks` read: green; **amber ≤ 2 h**; **red ≤ 30 min**; **expired** = red + "EXPIRED" text/pattern (not colour alone). Replaces the old 60/15-minute tones for all four clocks.
- Telegram at **2 h, 1 h, 30 m and expiry**, once per threshold per clock per shift (dedupe key includes the clock and the shift's start), each stating the **consequence and the action**; sent even in quiet hours (safety), at those thresholds only. Built on the existing `reminder_sends` dedupe.
- Tap a clock → a plain-language explainer written for a new driver: what it is, what happens at zero, what resets it (11 h, 14 h window, 30-min break, 70 h/8-day incl. the 34-hour restart).

## Block C — Home mini map, ELD-style
(designed here, built after B)
- Top-down semi-truck vector icon rotating with heading; follow mode (zoomed, heading-up, truck centred); the active load's planned route as a line with progress when a route exists (none → position + heading only, no invented route); posted-speed badge only from OSM `maxspeed` data (no data → no badge, never estimated); current speed display stays.

## Process
After each block: the full gate; then at the end two audits — pass 1 mistakes/edge cases (auto-switch vs manual switch race, GPS loss, notification duplication, colour vs HOS read, map with no route/GPS/speed data); pass 2 a professional review for tired, one-handed, glare, 10-second-glance use. Findings folded in before the report. Nothing is deployed by the builder.

## As built (2026-11-06) and audit record

**Built:** Block A (`lib/sustained-motion.ts`, `lib/auto-switch.ts`, `lib/auto-motion-rules.ts`, `POST /api/v1/duty-logs/auto-motion`, migration 00072, the quick `StatusSheet`, `MotionLock` banners); Block B (`lib/reminders.ts` thresholds + texts, `lib/hud-clocks.ts` tones/words, `ClockRing`, `lib/clock-explainers.ts`, `ClockExplainerSheet`); Block C (`lib/truck-icon.ts`, `lib/heading.ts`, `lib/route-progress.ts`, `services/integrations/osm-speed.ts`, `GET /api/v1/map/speed-limit`, `lib/speed-limit-policy.ts`, `use-active-route`, `HomePositionCard`, `DriveMap` follow/heading-up).

**Audit pass 1 - mistakes, pitfalls, edge cases. Found and fixed:**
1. *Auto-switch overruling a deliberate choice.* If the driver logged On duty / Off duty a few seconds into a move, sustained motion would still have switched them to Driving 40 s later. Now a row logged after the motion began is the driver's own call: the client stands down and the server refuses (`manual_change_won`: newest row at/after the start of the motion run, not just after detection). Tested both sides.
2. *Two tabs/devices racing the same detection* hit the unique `submission_id` index and would have returned a 500; now a replay (`deduplicated`).
3. *Speed limit attributed to the wrong road.* The first design queried only ways that carry a `maxspeed`, so an untagged main road would borrow a tagged frontage road's limit. Now the nearest motor-road way (aligned with the heading) is chosen FIRST and only its own tag is read; untagged -> no badge; two near-equal roads with different limits -> no badge; footpaths/cycleways never count. Tested.
4. *Cluttered countdown* ("at 3:42:15 PM") replaced with "in about N seconds".
Checked and sound: auto-switch vs manual switch (server judges against the newest row, idempotent per detection; the worst case is a harmless second Driving row if a manual tap lands just after the automatic one); GPS loss/tunnel (a >20 s gap resets sustained motion and standstill - no evidence is never motion, never "stopped"); notification duplication (key = clock + threshold + shift, dedupe row inserted first, released on a failed send; a scheduler restart cannot resend; skipped thresholds are not back-filled; only the tightest reached threshold is sent per clock per tick); ring colour vs HOS read (one `computeHudClocks`; a test asserts colour and notification agree at every sampled point); map with no GPS (card absent), no route (position + heading only, says so), no speed (dash), no limit data or service down (no badge).

**Audit pass 2 - a professional building for tired, one-handed, glare, 10-second-glance use. Found and fixed:** the quick-switch button is now the largest control on its sheet (76 px, bold, with the cancel control visually secondary); lock/prompt banner buttons are >= 48 px; the truck icon is larger (32 px wide) and keeps a white outline for glare; the EXPIRED ring no longer strikes through its time (illegible) - it is a heavy red border + tinted face + bold "EXPIRED" word; the Home map takes no touch pan/zoom so a one-handed scroll never gets trapped by it; speed is a 2 rem numeral on a dark plate; the posted-limit sign is a white plate with a black border and 2 rem numerals; notices say what happened, when (Eastern), and how to undo it.

**Known limits - stated, not hidden:**
- *Background (updated 2026-11-06, owner order):* a web page cannot read GPS while the screen is off or the app is closed. The open-app detector therefore only works on screen; the **same automatic switch now also runs server-side on the Telegram Live Location stream, which keeps reporting with the app closed** (see `docs/design/background-tracking.md`). The fully native route (a thin shell with background geolocation) is designed there and awaits the owner's phone type.
- *Posted limit:* OSM `maxspeed` coverage is incomplete and some US ways carry directional tags (`maxspeed:forward/backward`) that are deliberately ignored; those, and any road without a tag, show no badge. The Overpass host must be reachable from the deploy network (not verifiable from the builder's sandbox) - King verifies once deployed; if it is not reachable the badge simply never appears.
- *Route line:* drawn from the checked run saved by Smart Path on this device (localStorage), only for a still-confirmed load and only if not older than 72 h. A route planned on another device is not shown here.
- *Not an ELD:* nothing here is a certified record; the automatic row says so in its note.
