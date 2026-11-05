# Driver usability — the consolidated design (Stage 9)

Status: owner-ordered 2026-11-04 ("make this actually usable for a truck
driver … everything in the app"). This document reconciles
`driver-hud.md` (HUD, live layer, paper-log review, day view, safety rule),
the product audit of 2026-11-04 (`docs/audit-register-2026-11-04.md`) and the
owner's standing rules. Where this and `driver-hud.md` differ, this one is
newer; `driver-hud.md` keeps the detailed mechanics.

Boundary, unchanged: **paper-log helper, not an ELD.** The truck's certified
ELD is the carrier's system; the disclaimer stays on every HOS surface.

## 1. Two modes, one rule

- **Parked mode** — the full business cockpit. Everything readable, every
  control available.
- **Moving mode** — glance only. The map stays visible; nothing needs reading
  or typing. Entered whenever the phone does not POSITIVELY report the vehicle
  stopped (`lib/vehicle-motion.ts`: speed <= 5 mph from a fix <= 15 s old).
  Unknown speed, a stale fix, no GPS permission: all count as moving. **Unknown
  never unlocks anything.** When the driver says "I'm parked" (the confirmation
  is voided the moment movement is seen) the parked controls return.

## 2. Home (owner-operator cockpit), top to bottom

1. HUD — current status + ticking time-in-status, four live clock rings, four
   status buttons, Day log, Paper log, live position card (only with a fresh GPS
   fix; says "phone GPS", accuracy and age).
2. News banner — never silent (loading / off / unavailable-with-retry / rotation),
   headline word-reveal; live via the live layer + a 5-minute safety re-read.
3. Your next step — one prioritized action, from the full carrier-window HOS read.
4. Active load — route, dates, miles, rate worded as *operational revenue counted
   when delivered*, overdue flagged and asked, never assumed.
5. Active plan (Smart Path), then Day Wrap (money at risk: detention, missing
   POD, unlogged fuel, proposals waiting for his yes).
6. This month — rolling number animation; "Operating result", never "profit".

Quick actions and the assistant follow. Every card is live (§6).

## 3. Acting in place

Status change and the editable day (change / move start / add a change / delete,
soft and restorable) open as bottom sheets over Home — no page switching.
Sheets are accessible dialogs (focus in/out, Tab trap, Esc/backdrop, scroll lock,
reduced-motion safe). A status change defaults to *now*; an earlier time is
flagged "entered after the fact"; the future is refused. Location: typed, or
"Use my GPS position" (coordinates + accuracy, honest — no reverse geocoding
source exists).

## 4. Drive Mode

- **Moving surface** (`DriveGlance`): live map following the truck, next stop,
  next maneuver, HOS clocks (read-only chips), and exactly two controls: Skip
  stop and "I'm parked". No links out, no assistant link, never blank.
- **Clocks alongside the route** (`DriveClocks`): drive / 14-hour window /
  break / cycle, ticking each second from the same engine as Home; "unavailable"
  or "starts when you go on duty" instead of any invented number.
- **Status prompts** (`DriveStatusPrompt`): before GO it offers "Log Driving";
  when parked / after the run, "Off duty" / "On duty". It only OFFERS: a tap
  opens the confirm sheet (behind the same motion gate); nothing is ever booked
  automatically.
- **Spoken turns** (`lib/drive-maneuver-speech.ts`): each maneuver is spoken about
  half a mile out and once close in, never repeated, never stale.
- **App-wide lock** (`components/MotionLock.tsx`): while the phone reports the
  truck moving, every form in the app is inert with a banner saying why (only
  with location permission already granted; unknown speed does not lock the
  whole app - the HUD and Drive ask "I'm parked" instead).
- **Rerouting** (`lib/drive-reroute.ts`): sustained >0.3 mi off the planned line
  on a good fix (>=25 s, accuracy <=100 m) says so aloud and asks the route-check
  for a route from HERE to the destination (`already_picked_up`, no pickup
  detour). The answer replaces the plan ONLY if the provider marks it
  truck-checked; otherwise the old plan stays and he is told plainly to use the
  truck's own navigation. At most one request per 2 minutes; "Re-plan from here"
  is also a button.
- **Screen-off tracking** (`services/telegram/live-location.ts`, migration 00060):
  a web tab cannot read GPS with the screen off, so Telegram's own app does it —
  he shares Live Location with Abel (paperclip → Location → Share My Live
  Location, up to 8 hours) and each position arrives as an `edited_message`.
  The server keeps only the LATEST fix (`driver_positions`), derives speed from
  consecutive fixes (no speed from noisy, far-apart or inaccurate fixes; a few
  metres of wander is zero), and tracks movement/stop episodes
  (`lib/live-motion.ts`). Moving 2+ min while the log is not Driving, or stopped
  20+ min while it says Driving, makes Abel PROPOSE the change, carrying the time
  the movement really began; it waits for his yes like any pending action, with
  a 30-minute cooldown. Nothing is ever booked automatically. Drive falls back to
  this position only when its own GPS has gone quiet and the Telegram fix is
  under 45 s old (`GET /api/v1/position`). Honest limit: it only works while he
  is sharing; with no share there is no background tracking.

### Duty-aware app-wide lock (owner request 2026-11-05, relayed by King)

`MotionLock` (forms and editable controls) now looks at the logged duty status too (`lib/motion-lock-policy.ts`):
- **Driving, or no/unknown status** + moving -> locked (unchanged).
- **On duty (not driving), Off duty, Sleeper** + moving **slowly** (< 15 mph) -> no hard lock: a prompt says "the truck is moving, but your status says X — Switch to Driving?" (one tap logs Driving now and the lock follows); "Not now" leaves forms open under a slim persistent banner.
- The same non-driving status at **15 mph or more, or with no speed reading** -> still locked. This is the one deliberate narrowing of the request: a mislogged status must not unlock a truck at road speed. The owner may change `MISMATCH_MAX_MPH`.
- **Unchanged and still strictly fail-closed:** the Home HUD status sheet and Drive Mode (`StoppedGate`, `DriveGlance`). `DriveStatusPrompt` already offers only statuses other than the current one and appears only on the preview/parked screens, so it needed no change.

### GPS "fidget" fix and the bubble (owner report 2026-11-05)

Parked, the phone's position wanders and its speed flickers (and some phones
report no speed at all while standing still), so the app treated a parked truck
as moving and locked forms. Rule now (`lib/motion-estimator.ts`, used by the
app-wide lock, Home and Drive): once a stop is seen, remember where (the
**anchor**) and ignore wander inside a bubble around it (radius = max(30 m,
1.5 x the fix's accuracy)). **Moving** needs evidence that survives the bubble:
two consecutive fixes outside it, two consecutive clearly-moving speeds
(> 8 mph), or one good fix above 15 mph. Slow drift with a reported low speed is
followed, not counted. A phone that reports no speed is **stopped** from steady
fixes inside the bubble (it used to be "unknown", which locked the app while
parked). Unchanged and still fail-closed: a poor (> 100 m) or stale (> 15 s) fix
is unknown; nothing unlocks until a stop has held 10 s. While parked the drawn
icon is pinned to the anchor so it does not jitter; location is requested at
high accuracy (the low-accuracy network fix can wander hundreds of metres).
Like Google Maps, the icon and lock react a few seconds after real movement
starts - the price of not reacting to noise.

Not yet built from his description: the route-following *camera* behavior
(zoom-in on the icon, heading-up, prediction of the next turn along the planned
line) is Drive's map `follow` mode today; whether it feels like a truck GPS is
his test on a real drive. Turn "prediction" is the spoken half-mile/close tiers.

## 5. Animation, where it earns its place

Parked screens only: rolling money figures, headline word-reveal, ring arcs
(1 s), sheet slide-up, "Live" pulse. Drive/moving screens are visually stable.
Everything honors `prefers-reduced-motion`. `WordReveal` keeps the full text
readable to assistive tech (the animated words are decoration).

## 6. Liveness (no stale numbers)

One Realtime channel (`LiveDataProvider`), subscribed only with a signed-in
session; tables in `lib/live-tables.ts` and migration 00058; events are only a
"re-fetch" signal (payloads never rendered); own writes refresh instantly;
focus refreshes everything; a 5-minute re-read covers a dropped channel. "Live"
shows only while subscribed. The live two-company proof (NV-3) is King's.

## 7. Honesty rules for every figure

Rate = operational revenue recognized on delivery, never cash received.
Contribution margin / operating result, never "profit". Provisional HOS carrier
settings are labeled wherever the cycle is stated. A clock or total that cannot
be computed says so. Times are the viewer's/carrier's, never UTC.

## 8. Open, with owners (reconciled 2026-11-05)

Built and removed from this list: image-led news, rerouting, background position
(via Telegram Live Location), spoken turns, Drive clocks, the app-wide motion
lock, DST-correct day graph.

Still open:
- ~~Proactive Telegram logging reminders (hud §7)~~ built 2026-11-05 (`logging-reminders.md`), off until switched on.
- Home map card (hud §8) — owner decision.
- Telegram paper-log approval across an unreadable gap — **ruled** 2026-11-04 (flagged stretches book; unreadable are dropped and named); keep as a regression test.
- Motion gate coverage on every remaining form (SAF-1 test) — Wave 4.
- Drive tab / navigation placement decision.
- Live NV-3 isolation proof; refresh of the visual audit after deploy (King).
- Owner acceptance: paper-log reader against his own photographed sheet; a real drive with Live Location shared.
