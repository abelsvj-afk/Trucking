# Claude Code prompt — Fable window, Trucking app v2 (paste-ready)
Owner-approved direction 2026-11-10: top-model work only — the active-load navigation
connection (§2.9 of `docs/briefs/UIUX-Audit-Editing-Navigation-2026-11-10.md` in this repo). Supersedes the
Tracker prompt as the FIRST Trucking slice; the Tracker prompt stays valid as a later slice.

---

You are working in the Trucking repo — "Road to Legacy — Trucking Business OS." Verify the current main tip first (at or after 4daf1b64, Fly v76). Read spec §2.9 in `docs/briefs/UIUX-Audit-Editing-Navigation-2026-11-10.md` (in this repo) before writing code — it is the design of record for this work. Branch `feat/active-load-navigation` from main. Do NOT merge, do NOT deploy — open a pull request when done.

THE PROBLEM (why this is the hard one):
The app already has real truck-routing engines (built for Smart Path): OpenRouteService driving-hgv with the driver's dimensions (primary), Valhalla truck costing (fallback), OSRM car profile (last resort only). But the Home map shows NO route in daily use, because a route is only drawn from a Smart Path run saved on that phone — no run, no line, and the app never invents one. The connection between the driver's actual work and the map was never built. Build it.

DELIVERABLE — active load → automatic truck route + guidance, on the existing layer:

1. ACTIVE LOAD AS SHARED STATE. One source of truth for "the current active load and its next stop," readable by the web app AND by Abel (the Telegram agent). Abel tool decision, required in this build: Abel can read the active load, its next stop, and the current route summary (distance + ETA) — name the tool/endpoint in the PR.
2. AUTOMATIC ROUTE. When an active load exists, compute the route from the truck's current position (latest Tracker ping / device location) to the next stop automatically — no Smart Path run required. Stop addresses geocode once and cache.
3. GUIDANCE ON THE EVERYDAY MAP. Route line, turn list from the provider's maneuvers, live distance remaining + ETA, and automatic reroute when he leaves the route. Rerouting respects trailer state: NO U-turn instructions while trailering (route around the block); U-turns allowed only when bobtail/no-trailer state says so.
4. PROVIDER HONESTY. ORS driving-hgv is the truck-legal primary (note in the PR whether the ORS key is configured in code paths you can see — do not print any key value). Valhalla truck costing is the fallback. If only OSRM (car profile) is reachable, the route may display but guidance must REFUSE to engage and the UI must stamp it not truck-legal — never silently guide a semi on car routing.
5. HOS AWARENESS. The map's status card shows ETA against the driver's real clocks: if the ETA exceeds remaining drive time, say so plainly on the card ("ETA 6:10 PM — past your drive clock by ~40 min"). Display only — do not change any HOS math.

BOUNDARIES:
- A redesign crew is building the Home surface in parallel. Integrate through the map component's existing route-line mechanism (the same hook Smart Path runs use). Do NOT restyle Home, move blocks, or rewrite their surface; if their branch has moved the map code, rebase onto latest main and flag the conflict in the PR instead of overwriting.
- Do not touch: Business Credit, the day-log editor work (migration 00088 is spoken for — if you believe you need a migration, STOP and flag it in the PR instead of writing one), pay terms, signing config.
- Branding locked: black + gold #c9a227. NO UTC in anything user-facing, ever.

USAGE DISCIPLINE (follow exactly):
- Read the §2.9 spec and the routing/map modules first; no full-repo crawls, no re-reading files already read this session.
- Checkpoint the PR description after the shared-state piece works, before guidance.
- Ambiguity → STOP and ask in the PR. Do not add features beyond the five points above.
- Run the repo's existing gates and report results exactly — passes and failures both; never state a number you did not run.

DONE = PR against main with: the shared active-load state + Abel read path, automatic routing, guidance with trailer-aware rerouting, provider-honesty behavior, the HOS/ETA card line, gate results, and a list of anything deliberately NOT done.
