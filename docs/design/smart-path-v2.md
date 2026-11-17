# Smart Path v2: it knows where you are and what you're hauling

Status: owner order 2026-11-17 ("fix everything about it... redesign it"). Branch `feat/smart-path-v2`.
Replaces the `/smart-path` page's form-first flow. The engine (`services/smart-path/route-check.ts`, the verdict in
`lib/smart-path.ts`, fuel, food, weather, road work, state rules) and its fixed priority, legal first, rested second,
paid third, are unchanged.

## What was wrong (owner's words, then cause)

- **"You have to set a whole bunch of stuff before it populates."** The page asked for a load, a departure time,
  a start place, pickup and delivery windows, gallons, food mode, sleep hours and a workout before running.
  Nearly all of it is already in the app.
- **"Scroll up to the map, down to see why it's not loading."** The map sat at the top, the form in the middle,
  and the status and result at the bottom.
- **"100,000 words underneath."** Every line of every section rendered at full length.
- **"It doesn't know anything about what's going on. 0% smart."** It never used the truck's live position, which
  stop is next, whether the pickup was already done, or the stops' appointment times, even though the engine
  could reroute from the truck and the active-load builder already knew all of that.

## v2 behaviour

**Zero input.** Opening Smart Path immediately plans the run from what the app knows (`/api/v1/smart-path/auto`,
`services/smart-path/auto-context.ts`):
- **Load:** the active load (the same pick as Home and Abel, `pickActiveLoad`), or the one he chooses.
- **Where he is:** the newest position (this phone, else the Tracker / Telegram feed), with its age stated.
- **Phase:**
  - next stop is the pickup → *heading to pickup*: deadhead from the truck to the pickup, then the loaded run;
  - next stop is a delivery → *loaded*: the pickup is behind him, so the run starts at the truck, straight to the
    destination (the engine's reroute);
  - no live position → planned from the pickup, and it says so.
- **Times:** leave now, or the time he picks. Pickup and delivery windows come from the stops' appointments
  (appointment to appointment + 2 h); with no appointment, the load's dates as before.
- **His clocks:** from his duty log (unchanged engine).
- **Preferences** (food style, sleep window, workout) are remembered on the phone, not asked every time.

**One screen, no scrolling to find things.**
1. **Status card** (top, sticky): the verdict in one big word (ON TIME / EARLY / LATE / NOT LEGAL), one sentence of
   why, and what Smart Path assumed ("Loaded, from your position 3 min ago, leaving now"). While it works, this card
   shows the progress; an error shows here too.
2. **Map** (compact), with the truck, the route, and the planned stops.
3. **Key facts** as four tiles: arrive at, hours left on arrival, next fuel, next sleep.
4. **The plan** as a short timeline: one line per stop (break, sleep, fuel, food), time and place only.
5. **Details** folded away: the full verdict lines, fuel math, weather, road work, state rules, engine notes.
   Nothing is removed, only collapsed.
6. **Change**: a small button opens the settings (another load, leave time, preferences) and re-runs.

Phone-away law stands: plan parked; Drive mode and Abel speak it on the road. Times are shown in his zone, never UTC.
