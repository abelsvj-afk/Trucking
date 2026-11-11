# Active-load navigation (design of record until spec section 2.9 lands)

Owner direction 2026-11-10. The audit file `UIUX-Audit-Editing-Navigation-2026-11-10.md` (section 2.9) is NOT in the repo; by the
owner's answer the brief's five points are the spec until it lands. Status: **all five points BUILT and gated on the branch; not merged, not deployed, migration 00089 not applied, not run against live
providers.**

## Decisions (owner, 2026-11-10)
1. Build from the brief's five points until the spec file lands.
2. Migration **00089** `geocode_cache`: a stop's address is geocoded once and kept (survives restarts, shared by both machines).
3. **Trailering = the active load has a trailer on it** (`loads.trailer_id`). No trailer = bobtail. While trailering, any reroute that
   contains a U-turn is refused (the old line stays); the truck's heading is passed to the engine so it routes onward.
4. The route summary is computed on the server by ONE builder, read by the web through `GET /api/v1/active-load` and by Abel through
   the read tool `active_load_status`. Not stored; a short in-process cache (5 min, ~500 m start cell) keeps the two in step.

## 1. Shared state (built) - `services/navigation/active-load-state.ts`
- Active load: `pickActiveLoad` (confirmed loads only) on the Eastern calendar.
- Next stop (`lib/next-stop.ts`): with stop records, the first stop not yet LEFT (arrived-not-left is still current; all left = none).
  Without stop records (owner rule): the origin until the pickup appointment WINDOW ENDS (no window: the end of the pickup date), then
  the destination - and the state says which basis it used. A pickup marked left on a stop record always wins.
- Start: the device's own fix when the caller sends one, else the newest Tracker/Telegram position. A server position older than
  60 minutes is not routed from; the state says how old it is.
- Nothing is invented: no position, unknown address, geocoder or routing outage = no route, with the plain reason.

## 2. Automatic route (server half built)
The existing chain (`services/integrations/routing.ts`) with the truck's own dimensions: ORS `driving-hgv` (only when `ORS_API_KEY` is
set - read from env; whether it is set in production is not visible from the repo), then Valhalla truck costing, then OSRM car.

## 4. Provider honesty (server half built)
`truckLegal` is the engine's own flag. `guidanceAllowed` is true only for a truck-legal route. A car-profile route may be displayed,
carries the notice "NOT truck-legal ... guidance is off", and carries NO turn list - so nothing downstream can guide on it by accident.

## 3. Guidance on the everyday map (built)
- Integration is through the EXISTING route-line mechanism only: `HomePositionCard` passes the route to `DriveMap`'s `geometry` /
  `traveledGeometry`, exactly as a Smart Path run does. A saved Smart Path run is the fallback when there is no automatic route.
  Nothing on Home was moved or restyled; no CSS was added.
- `lib/use-active-navigation.ts` asks `GET /api/v1/active-load` with the device's position, heading and speed: on first position, when
  the load or its stops change (live layer), every 5 minutes, and when the truck has been off the line 0.3 mi for 25 s on a good fix
  (the Drive Mode rules), never more often than every 2 minutes.
- `lib/active-navigation.ts` (pure): live miles left and ETA (the engine's own distance and drive time scaled by the share of the
  line still ahead - no speed is assumed), the next turn and the turns ahead from the provider's maneuvers.
- **Trailer-aware rerouting.** A route "needs a U-turn" when the engine labels one or when it starts more than 135 degrees away from
  the direction of travel (judged only at 8 mph or more). With a trailer on the load it is REFUSED: the old line stays and he is told
  to keep going; the next attempt is from further on, which is how it routes around the block. Bobtail may take it. The truck's
  heading is sent to the engine: Valhalla uses it (`heading` + `heading_tolerance` on the start location). **ORS is not sent a
  heading** - its bearing option is not something this build could confirm for the driving-hgv profile, and a rejected request would
  silently push every route to the fallback - so with ORS the protection is the refusal check on the result.
- A car-profile route may be drawn when nothing else is on screen, with the NOT TRUCK-LEGAL stamp, no turn line and no turn list;
  it never replaces a truck-legal line.

## 5. HOS awareness (built, display only)
The card line compares the remaining drive time with the tighter of his drive clock and 14-hour window, both taken from the clocks
`DutyHud` already computes (no hours math changed): "ETA 6:10 PM ET — past your drive clock by ~40 min", or how much is to spare
("no breaks counted"), or that hours are not available. Eastern time only.

## Not done (deliberately)
- No voice guidance, no lane guidance, no multi-stop preview: one stop at a time, the next one.
- No server-side storage of the route; no per-driver positions (the company's newest position is the truck).
- ORS heading/bearing (see above). No break planning in the ETA.
- Not run against the live engines or on a phone: unit and component tests only.

## Known limits
- Loads with no stop records: the origin until the pickup window ends (or the pickup date ends), then the destination; a pickup marked
  left on a stop record always wins.
- The ETA is straight drive time; breaks are not modelled (Abel is told to compare with the hours tools).
- Not verified against live providers from the build sandbox (outbound calls are blocked there).
