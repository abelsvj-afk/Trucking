# Active-load navigation (design of record until spec section 2.9 lands)

Owner direction 2026-11-10. The audit file `UIUX-Audit-Editing-Navigation-2026-11-10.md` (section 2.9) is NOT in the repo; by the
owner's answer the brief's five points are the spec until it lands. Status: **checkpoint 1 BUILT (shared state + Abel read path +
server-side automatic route + geocode cache); guidance on the map, trailer-aware rerouting and the HOS/ETA card line are NOT built yet.**

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
  Without stop records, the load's origin until its pickup date has passed, then its destination - and the state says that is the basis.
- Start: the device's own fix when the caller sends one, else the newest Tracker/Telegram position. A server position older than
  60 minutes is not routed from; the state says how old it is.
- Nothing is invented: no position, unknown address, geocoder or routing outage = no route, with the plain reason.

## 2. Automatic route (server half built)
The existing chain (`services/integrations/routing.ts`) with the truck's own dimensions: ORS `driving-hgv` (only when `ORS_API_KEY` is
set - read from env; whether it is set in production is not visible from the repo), then Valhalla truck costing, then OSRM car.

## 4. Provider honesty (server half built)
`truckLegal` is the engine's own flag. `guidanceAllowed` is true only for a truck-legal route. A car-profile route may be displayed,
carries the notice "NOT truck-legal ... guidance is off", and carries NO turn list - so nothing downstream can guide on it by accident.

## Still to build (after the owner's check-in)
- 3. Guidance on the everyday map through the existing route-line hook (`useActiveRoute` -> `HomePositionCard` -> `DriveMap`): route
  line, turn list, live distance/ETA, automatic reroute off-route, U-turn refusal while trailering.
- 5. The HOS line on the map's status card (ETA against the real drive clock; display only).
- UI stamp for a not-truck-legal route.

## Known limits
- Stops with no stop records are chosen by date, not by a recorded pickup.
- The ETA is straight drive time; breaks are not modelled (Abel is told to compare with the hours tools).
- Not verified against live providers from the build sandbox (outbound calls are blocked there).
