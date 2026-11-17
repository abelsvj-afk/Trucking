# Smart Path live awareness (design)

Status: **Built 2026-11-17** on branch `feat/smart-path-live-awareness`
(owner order, voice call 2026-11-17: "Yes" to starting it; the bar is
"comparable if not better than a regular trucking GPS"). Extends
`docs/design/smart-path-intelligence.md` (Phases 1–3) and
`docs/design/driver-mvp.md` §8. It does not change the verdict's fixed
priority — **legal first, rested second, paid third** — and every new
section is advisory: it never flips the verdict and never claims a
route is clear or legal.

## 0. What the owner asked, in his words

The app he planned long ago must be very, very intelligent about a
trucking route — bridges and whatever regular trucking apps / trucking
GPSs use. Five asks:

1. A bridge coming up, warned on the map while he is looking at it.
2. Weather on the route.
3. Delays about an hour ahead in his direction — traffic jam, accident,
   delay.
4. The affected stretch of the route colored red/orange by severity,
   Google Maps style.
5. The ahead-of-time call — reroute around it faster, OR stay because
   it will be over soon.

## 1. What was already there (verified on main 67d12e7, 2026-11-17)

- **Weather EXISTS (NWS, Phase 2b):** forecast read at the time he
  reaches each corridor point, alerts dropped when they end before /
  start after arrival. It lived only on the parked plan surface; Drive
  Mode showed none of it. This build does not rebuild weather — the
  section stays on the plan surface (Details) unchanged; the live
  work here is traffic + bridges.
- **Roadwork EXISTS as machinery, EMPTY in practice:** WZDx parser +
  section builder, but the feed registry is empty on purpose, so every
  crossed state reports "no work-zone data".
- **No live-traffic feed of any kind.** No TomTom/HERE/Mapbox key, no
  traffic API route, no traffic env var.
- **Truck routing chain:** ORS `driving-hgv` → Valhalla truck →
  OSRM car (truckLegal false, labeled NOT truck-checked).
- **Maps:** MapLibre over OSM raster tiles, keyless by design. Plan
  map: single black route line. Drive map: single glowing-gold
  remaining-route line. No severity coloring, no bridge/incident
  markers.

## 2. Rules that bind this build (same as intelligence §0)

1. **Free first.** TomTom's free tier (below) and keyless Overpass.
   No paid source was adopted.
2. **Stale is labeled, never silent.** Every section carries `asOf`
   (Eastern time in the UI); a down source shows "unavailable", never
   a guess.
3. **Advisory, not authority.** Traffic and bridges never flip the
   verdict. The page says "check the posted signs and your truck's
   own nav".
4. **Untrusted input.** TomTom and Overpass responses are
   Zod-validated; free-text fields are shown as text, never
   interpreted as instructions.
5. **No UTC in anything user-facing.**
6. **No carrier content anywhere** (owner order 2026-11-14).
7. **Abel tool decision:** no new tool. `check_route` already covers
   "what's ahead on my route" — `formatRouteCheck` now includes the
   traffic + bridges sections. `delivery_feasibility` keeps its
   explicit "traffic NOT included" wording.

## 3. Traffic source: TomTom Traffic Incidents API v5

Verified 2026-11-17 against developer.tomtom.com. Free tier:
**2,500 non-tile transactions/day + 50,000 tile requests/day, no
credit card, commercial use permitted.** Key `TOMTOM_API_KEY` (free
registration) — owner setup item, same pattern as `ORS_API_KEY`.
Absent key → the section is `unavailable` with a plain-words note.

- Query: bbox, max 10,000 km² per call; `timeValidityFilter=present`
  (only incidents live right now). Fields used: `magnitudeOfDelay`,
  `delay` (seconds), `length`, `from`/`to`, `startTime`/`endTime`,
  `iconCategory`, `events[].description`, `roadNumbers`.
- **Budget:** plan-time check chunks the route into ~60-mi bboxes
  (≈1 call per 60 route miles, capped at 10). Live polling covers
  only ~60–100 mi ahead, 1–2 bbox calls per 2-min poll = 30–60/hour,
  300–600 per 10-hour day. Server-side 2-min in-process cache.
  Well under 2,500/day.
- **No Flow API, no tiles.** Segment coloring comes from incident
  geometry mapped onto the route (from/to miles) + magnitude/delay.
  The key stays server-side; the map stays keyless by design.

### Honest limits (stated in the UI)

TomTom knows *reported* incidents — accidents, jams, closures,
road work — with a reported delay when one is measured. It does not
know every slowdown. **An uncolored stretch means "no reported
incident", never "clear".**

### Severity

- **Severe (red `#dc2626`):** magnitudeOfDelay ≥ 3, or delay ≥ 25 min.
- **Moderate (orange `#ea580c`):** magnitude 2, or delay ≥ 10 min.
- **Minor:** everything else — listed in Details, never colored,
  never part of the call.

## 4. The ahead-of-time call (pure, `lib/smart-path-traffic.ts`)

For the worst delay ahead (longest reported delay, non-minor), in
order:

1. **Nothing ahead** → "none".
2. **It clears before he gets there** (provider `endTime` ≤ his ETA
   at that mile) → "stay", with the reason shown.
3. **A truck-checked detour saves ≥ 10 min** → "reroute", with the
   minutes saved.
4. **Otherwise stay**, with the reason: minor delay / detour saves
   too little / no truck-checked detour could be compared.

The detour is routed through the same truck routing chain with
avoid circles around the colored delays (ORS `avoid_polygons`,
Valhalla `exclude_polygons`; **OSRM refuses avoid outright** — a car
detour must never be the answer for a truck). A detour that comes
back car-only is ignored, and the call says so. On Drive, the detour
is a **one-tap "Take the detour"** — the call is the app's judgment,
the switch is his tap. Never a silent route swap while rolling.

## 5. Bridges ahead: Overpass (keyless)

Query `way["bridge"]["maxheight"]` per ~100-mi corridor chunk,
10-min server cache, same User-Agent/timeout discipline as the
places lookup. Each bridge maps to its nearest corridor mile and is
judged against his truck's height (from the truck profile):

- **Below** (limit < truck height) — hard warning.
- **Tight** (within 6" above) — caution.
- **Ok** — informational.
- **Unknown** (no recorded clearance, or no truck height in the app)
  — never a pass.

**Only bridges WITH a recorded clearance are listed.** A bridge with
no recorded clearance is never presented as cleared, and the section
says so. OSM restriction data is incomplete; the truck's own nav/ELD
is the final word. Clearance tags parse as meters (the OSM default)
or US feet/inches (`13'6"`, `13 ft 6 in`); anything else is dropped,
never guessed.

## 6. Where it shows

- **Plan (`/smart-path`):** "Ahead on this route" card with the call
  in plain words + low-bridge warnings; the map draws the colored
  stretches and ⚠/🌉 markers; Details carries the full traffic and
  bridges lists.
- **Drive (`/smart-path/drive`):** 2-min live poll while rolling
  (`POST /api/v1/smart-path/live-traffic`, remaining run only);
  colored stretches + markers on the drive map; the reroute banner
  with one-tap detour; each hazard spoken once, only when close
  ahead (traffic ≤ 15 mi, bridges ≤ 5 mi, reroute call once per
  incident). Mute respected. A failed poll is silent — the last good
  state stays.
- **Abel:** `check_route` answers include the traffic call, the
  delays, and the flagged bridges.

## 7. Files

- Pure: `src/lib/smart-path-traffic.ts`, `src/lib/smart-path-bridges.ts`,
  `src/lib/smart-path-avoid.ts`, `src/lib/smart-path-map-segments.ts`
  (incl. `sliceGeometryFromFraction` for the live poll).
- Integrations: `src/services/integrations/tomtom-traffic.ts`,
  `src/services/integrations/overpass-bridges.ts`.
- Sections: `src/services/smart-path/route-traffic.ts`,
  `src/services/smart-path/route-bridges.ts`.
- Wiring: `src/types/smart-path.ts` (`traffic?`, `bridges?`,
  `LiveTrafficResponse`), `src/data/schemas/smart-path.ts` (`avoid`,
  `liveTrafficRequestSchema`), `src/services/smart-path/route-check.ts`
  (optional seams + detour comparison), `src/services/integrations/
  routing.ts` + `openrouteservice.ts` + `valhalla.ts` (avoid),
  `src/lib/drive-reroute.ts` (avoid passthrough).
- Endpoint: `src/app/api/v1/smart-path/live-traffic/route.ts`.
- UI: `src/components/SmartPathMap.tsx`, `src/components/DriveMap.tsx`,
  `src/components/smart-path/SmartPathDetails.tsx`,
  `src/components/drive/DriveRolling.tsx`,
  `src/app/(app)/smart-path/page.tsx`,
  `src/app/(app)/smart-path/drive/page.tsx`,
  `src/services/bot/route-check-tool.ts` (`formatRouteCheck`).
- Config: `.env.example` (`TOMTOM_API_KEY`).

## 8. Acceptance

- Gate: lint 0, typecheck 0, production build 0, full vitest with
  `--pool=threads` (counts from the persisted gate log).
- A severe delay colors its stretch red and the call says reroute
  only when a truck-checked detour saves ≥ 10 min; a delay that
  clears before his ETA says stay; a car-only detour is never
  offered.
- A bridge under his truck warns; a bridge with no recorded
  clearance is never shown as cleared.
- With no TomTom key, traffic is "unavailable" and nothing is
  claimed; bridges still work.
- Drive polls every 2 min while rolling, speaks each hazard once,
  and swaps routes only on his tap.
