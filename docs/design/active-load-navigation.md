# Active-load navigation - BLOCKED before any code (2026-11-10)

Branch `feat/active-load-navigation`, cut from main `4daf1b6`. No application code has been written. The brief says to read
spec section 2.9 of `UIUX-Audit-Editing-Navigation-2026-11-10.md` first ("the design of record") and to STOP on ambiguity.
This note is that stop: what was checked, and the four things that need an answer.

## 1. The design of record is not reachable
`UIUX-Audit-Editing-Navigation-2026-11-10.md` is not on main, not on any of the 95 remote branches, not found by GitHub
code search in this repo, and not found by a Drive search (title or text). Nothing under `docs/` mentions a section 2.9 or
"active-load navigation". The five deliverables in the brief are clear enough to build from, but they are a summary; if
section 2.9 says anything they do not, building now risks contradicting it.
**Needed:** commit the file (or paste section 2.9), or say "build from the brief's five points".

## 2. "Geocode once and cache" needs storage that does not exist (migration question)
`load_stops` (00062) holds `name`, `address`, appointment and progress - no latitude/longitude. The only geocode cache is an
in-process `Map` in `services/integrations/geocoding.ts`: lost on every restart and not shared between the two Fly
machines, so a stop would be re-geocoded repeatedly (Nominatim allows about one request a second).
A real "once" means two nullable columns on `load_stops` (or a small cache table) - a migration. The brief says 00088 is
spoken for and to STOP rather than write one. Main is at 00086.
**Needed:** (a) reserve a number for this (for example 00089: `load_stops.lat`, `lng`, `geocoded_at`), or (b) accept the
in-process cache for now, stated as a known limit.

## 3. There is no trailer state to respect
Rule 3 says no U-turns while trailering, U-turns only when "bobtail/no-trailer state says so". The data has
`loads.trailer_id` and `drivers.assigned_trailer_id` (which trailer is ASSIGNED), but nothing that records whether a
trailer is hooked right now; "bobtail" appears only in display text. Also, neither truck engine is currently asked to avoid
U-turns: `openrouteservice.ts` and `valhalla.ts` send no heading/bearing or U-turn option.
**Needed:** which of these is the rule - (a) trailering = the active load has a `trailer_id` (or the driver has an assigned
trailer); bobtail = neither; or (b) a new explicit hooked/bobtail switch (a new stored field - a migration again); and
confirm the mechanism: pass the truck's heading to the engine so it routes onward instead of reversing, and drop any
maneuver the engine still labels a U-turn while trailering (refusing that reroute and keeping the old line).

## 4. Where the shared route summary lives
"One source of truth, readable by the web app and by Abel" for the load and next stop can be computed on the server from
existing tables with no new storage (`pickActiveLoad` + `load_stops` progress + latest `driver_positions`). The ROUTE
summary (distance + ETA) is different: if the phone computes it, Abel cannot read it; if the server computes it on each
read, Abel and the phone can disagree and every Abel question costs a routing call; storing the last computed route is a
third new table/column.
**Proposed (no migration):** one server endpoint `GET /api/v1/active-load` that returns the load, next stop and - computed
on request, with a short in-process cache keyed by position cell and stop - the route summary and provider honesty flag;
the web map and a new Abel read tool `active_load_status` both call the same builder. Say if you want it stored instead.

## Already verified from the code (no answer needed)
- Provider chain exists as described: ORS `driving-hgv` only when `ORS_API_KEY` is set (read from env in
  `routing.ts`; documented in `.env.example` as a Fly secret; whether it is set in production is not visible from the
  repo), then Valhalla truck costing, then OSRM car with `truckLegal: false`. Maneuvers are already normalised.
- Home's map already takes a route through `useActiveRoute()` -> `HomePositionCard` -> `DriveMap geometry`; that hook is
  the integration point, and today it only reads a Smart Path run from this phone's localStorage.
- Off-route detection and "a car route never replaces a truck route" already exist for Drive Mode (`lib/drive-reroute.ts`).
- `driver_positions` holds the latest Telegram/Tracker fix with heading and speed.
