# Map finish (2026-11-19)

Owner brief 2026-11-18 (TruckPath is the reference; screenshot 2026-11-19), finishing the drive map on top of the 3D truck merged in `d20a244`. Branch `fix/map-finish-2026-11-19`. It supersedes PR #91, whose commit is carried here and reconciled.

## One measurement for every distance — `src/lib/route-measure.ts`

**Defect:** the app said 11 mi to I-20 while the owner's other map said 19. The drive page mixed two scales:
- line miles: the simplified route polyline's own length, which is shorter than the road;
- road miles: the router's `distanceMiles`.

`liveFraction` divided one by the other, and POI distances subtracted line miles from road-scaled miles.

**Rule:** every distance on the map is **road miles**, measured one way:
1. project the point onto the nearest **segment** (never snap to a vertex);
2. take the line length up to that point;
3. scale it to the router's road miles, **per leg** (the deadhead and loaded legs are simplified differently).

**Users:** `drive.ts` session progress (`planFractionAt`), the page's live fraction, the countdown, turns, truck stops, bridges. The plan snapshot records `deadheadEndIndex` and `deadheadMiles`. Older saved plans lack them and are measured as one leg.

## One motion system — `src/lib/truck-motion.ts`

Both the 3D layer (every frame, while gliding) and the page's numbers (`useSmoothedFix`, ~5 Hz) run the same pure functions on the same raw fixes. PR #91's separate glide math was removed.

**Glide:**
- along the road when both ends are on the line;
- straight between the two fixes otherwise;
- eased over the time between fixes (0.3–2.5 s);
- snaps on a jump over 2 km;
- never extrapolates past the newest fix.

**Nose:** points the way the truck is travelling:
1. the road's direction on the route;
2. off the route, the bearing between fixes;
3. the GPS heading only when the truck has not moved.

**Repaint:** only while gliding.

**3D failure fallback:** a render failure mid-drive, or a lost WebGL context, removes the layer and brings the flat gold icon back. Before, only a start-up failure did; a visible truck beats an invisible one.

## Route glow — `src/lib/route-glow.ts`

- The pulsing gold glow sits under the white casing and the gold line.
- Each update changes two paint values on one layer, about 8 times a second.
- It pauses while the page is hidden and holds still for reduced motion.
- Night glow is wider and brighter than day.

## Maneuver zoom and the early call-out — `src/lib/drive-maneuver-zoom.ts`

| Maneuver | Zoom starts | Zoom strength |
|---|---|---|
| Highway exit, ramp, or turn onto a highway (I-/US-/SR-/Hwy) | ~4.5 mi (the owner's example) | gentle (+0.4 → +1.6) |
| Street turn | ~1.5 mi | closer (+0.8 → +2.4) |
| Straight / "stay on" / arrival | never | — |

- One spoken call-out fires where the zoom starts.
- Exits worded without left/right now count as maneuvers.

## What's ahead, and the bottom bar

**One ahead list** feeds both the map icons and the left-hand chips, so they cannot disagree:
- **Contents:** truck stops (OSM `highway=services` / HGV fuel), rest areas, fuel, truck parking, and low or unknown-clearance bridges.
- **Selection:** within 30 mi, nearest first.
- **Chips:** icon plus miles to one decimal; the nearest three show, the rest are behind **More** (TruckPath style).
- **Source:** free data only (Overpass/OSM), no new provider.

**Bottom bar:**
- miles with one decimal;
- time left that counts seconds under 10 minutes;
- "Arrive about h:mm AM/PM" plus the zone label of where the truck is, never UTC.

## Auto-switch to Driving (position-feed path) — `src/lib/live-motion.ts`

**Root cause 1:** the Tracker sends a fix every 5 s, and the 0.01 mi jitter floor made every pair under 7.2 mph read as 0 mph.

**Root cause 2:** a single stopped reading reset the motion run.

Together, pulling out of a lot and stop-and-go town driving never held the 90 s the switch needs.

**Fix:**
- Good-accuracy pairs (≤ 20 m) get a 0.004 mi floor.
- A stop under 15 s keeps the run. This is the open-app detector's existing dip tolerance; no new column, because `moving_since` and `stopped_since` are already stored.

**The hidden-page gap:** a browser cannot see motion while the page is hidden; that is a platform limit. The Tracker / Telegram feed carries it, and that path is what this fixes.

## Location voice notes

Not built yet: two decisions are the owner's (see the PR).
