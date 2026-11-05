# Smart Path intelligence — Phases 1–3 (design)

Status: **DRAFT for owner review** (written 2026-11-05 from the owner's standing order:
"corridor geometry, regional fuel prices, weather and state laws on your actual route,
then construction and road events; stale data always labeled, never silently used").
**Phase 1 partly built (2026-11-05):** corridor points + ETA-at-mile (`lib/smart-path-corridor.ts`, `corridor` on the route-check response, an "Along the route" card on `/smart-path`). **States crossed built** (bundled coarse outlines, `lib/smart-path-states.ts`; border miles approximate). **Phase 2a regional fuel built** (`services/smart-path/regional-fuel.ts`: per-PADD EIA average, aging 8 d / stale 10 d, stale not ranked). **Phase 2b weather built** (`integrations/nws-route.ts`, `lib/smart-path-weather.ts`, `services/smart-path/route-weather.ts`; ≤12 spots, forecast read at his arrival time, alerts dropped if they end before / start after, failures named). Not built yet: state rules (2c) and road work (3). Provenance of the outline asset: a public GeoJSON of Census-derived state shapes (owner/King: swap for an official Census cartographic boundary file if exact provenance matters). Per CLAUDE.md the design is reviewed before code; the build
starts with Phase 1 once this is accepted (or amended). Extends
`docs/design/driver-mvp.md` §8 (Smart Path v1, §8.5 truck-legal routing); it does not
change the verdict's fixed priority: **legal first, rested second, paid third.**

## 0. Rules that bind every phase

1. **Free first.** Every source below is free and official or open. A paid source is
   proposed to the owner with the cost, never adopted silently.
2. **Stale is labeled, never silent.** Every external fact carries `fetchedAt`,
   `source`, and a `freshness` class (`fresh | aging | stale | unavailable`) computed
   in code from a per-source max age (table in §6). A stale value may be shown ONLY
   with the words "as of <Eastern time>" and never feeds the verdict's pass/fail;
   an unavailable source shows "unavailable", never a guess or last-known number
   presented as current.
3. **Advisory, not authority.** Weather, state-law and construction items are
   *warnings and context* on the verdict. They never flip legal/rested/paid
   by themselves and never claim a route is legal or clear. The page says "check the
   posted signs and your carrier's rules".
4. **Untrusted input.** Every response is Zod-validated; free-text fields are shown as
   text, never interpreted as instructions (CLAUDE.md prompt-injection rule). No AI
   writes any figure — code computes, AI may only phrase (as in v1).
5. **Eastern/viewer time** in everything user-facing; no UTC strings.
6. **Frontend ships with each phase** on `/smart-path` (and Abel's `check_route`
   answers read the same engine so chat and page cannot disagree).
7. **Two-company isolation** on every new read path; caches are keyed by place/route
   geometry, never by company, and hold no company data.

## 1. Phase 1 — Corridor geometry

**Goal:** a real corridor around the chosen route, so every later layer asks "what is
within X miles of THIS line" instead of "what is near the endpoints".

- `buildCorridor(geometry, widthMiles)` in `src/lib/smart-path-corridor.ts` (pure):
  resamples the route polyline at fixed spacing (default 10 mi), returns ordered
  `CorridorPoint { index, lat, lng, mileFromStart, fraction }`, plus a bounding box per
  chunk for cheap pre-filtering. Reuses `haversineMiles`, `distanceToRouteMiles`,
  `routeFractionOfPoint`, `pointAlongRoute` from `lib/smart-path.ts`.
- **States crossed:** `statesAlongRoute(corridorPoints)` → ordered
  `{ state, enterMile, exitMile }[]`. Source: a bundled low-resolution state polygon
  set (US Census cartographic boundary, public domain) checked in as a static JSON
  asset; point-in-polygon in code. No network call, no key, never stale.
- **Region mapping:** each corridor point also gets its EIA PADD region
  (static state→PADD table; sub-PADD where EIA publishes it, e.g. Florida, California).
- **ETA per point:** `etaAtMile(plan, mile)` from the existing planned drive/rest timeline
  (`elapsedAtDrivenMinutes`) so weather/construction are asked about the time he will
  actually be there, not now.
- Output added to the route-check response: `corridor: { widthMiles, states[], points[] }`.
- **Acceptance:** fixtures for three real-shaped routes (short in-state, two-state,
  five-state) give states in order with enter/exit miles that sum to the route length
  within 1%; a route hugging a state line never reports a state it never enters by
  more than the corridor width; geometry with <2 points yields an explicit
  "no corridor" result, not an empty-success.

## 2. Phase 2 — Regional fuel, weather, state laws

### 2.1 Regional fuel prices
- Source: EIA weekly retail diesel by PADD (already integrated in `eia.ts`; the
  `duoarea` facet is supported). Free; needs `EIA_API_KEY` (already in `.env.example`).
- For each state/PADD on the corridor, fetch the latest weekly point (cached per
  region for 6 h; the series itself changes weekly). Fuel candidates inherit the
  *region's* estimate (replacing today's single national average), labeled
  "EIA <region> weekly average, week of <date> — not this station's price".
- Freshness: EIA publishes Mondays; max age 10 days → `aging` at 8, `stale` at 10.
  Stale or missing → falls back to the national average WITH that label, or to
  detour-only ranking exactly as v1 does today.
- His own `fuel_purchases` history still wins over the regional estimate where a
  candidate matches his past stop (unchanged).
- **Acceptance:** a two-region route prices candidates per region with the right
  label; EIA failure degrades to the v1 behavior with a visible "unavailable" line;
  a stale snapshot is shown with its date and is not used to rank.

### 2.2 Weather on the route
- Source: NWS `api.weather.gov` (already used by the research engine; free, keyless,
  honest User-Agent). Two calls per sampled point: `/points/{lat},{lng}` →
  gridpoint, then the **hourly forecast** and **active alerts** for the point.
  Points are the corridor samples (§1) thinned to ≤ 12 per route; each request is
  cached by gridpoint for 30 min.
- Forecast is read **at the ETA of that point** (§1), not "now". Items produced:
  `{ mile, etaEastern, kind: alert|wind|precip|ice|visibility|heat|cold, severity,
  text, source: "NWS", fetchedAt }`.
- Thresholds are named constants shown in the response (e.g. sustained wind ≥ 35 mph
  for a high-profile trailer, any ice/freezing precip, visibility < 1 mi, NWS
  Warning/Watch for winter storm, high wind, dense fog, flood, tornado). They add
  warnings; they do not gate legality.
- Freshness: forecast max age 3 h (`aging` 1 h), alerts max age 30 min. NWS outside
  the U.S. or on error → "weather unavailable for this stretch".
- **Acceptance:** fixture alerts produce the right mile/ETA; an alert that expires
  before his ETA at that point is not shown as hitting him; every item shows the
  fetch time; NWS 5xx shows "unavailable" and the verdict is unchanged.

### 2.3 State laws on the route
Two honestly different things, kept separate:
- **Static truck rules table** (`src/data/state-truck-rules.ts`, curated, versioned,
  each row with `source_url` and `verified_on` date): per state — max overall
  length / trailer length / width / height where it differs from the federal norm,
  weight notes, idle-limit rules (anti-idling), chain/tire laws, speed-limit
  differences for trucks, hand-held and other driver rules the owner cares about.
  Matched against his **truck profile** (height/length/weight) for the states
  crossed (§1): a row only produces a warning when his profile actually
  exceeds/engages it. Rows older than 12 months show "last verified <date>".
  Nothing here is invented: a state with no verified row shows "no rule on file —
  check", never "no restriction".
- **Pending/enacted changes:** the existing OpenStates watcher output
  (research engine) is surfaced as "recent change in <state>" with the bill's own
  words and date, labeled as unverified summary — it does not alter the table.
- **Acceptance:** a truck taller than a state's posted limit warns in that state only;
  a state absent from the table says so; table rows carry `verified_on`; the page
  never states a law as current when `verified_on` is older than 12 months without
  saying how old it is.

## 3. Phase 3 — Construction and road events

- Source (free, official): state DOT work-zone feeds in the **WZDx** open
  specification (USDOT "Work Zone Data Exchange"; many states and the USDOT
  aggregate publish GeoJSON feeds, mostly keyless, some with free keys), plus NWS
  road-weather where available. A per-state feed registry
  (`src/services/integrations/wzdx-feeds.ts`) lists the feed URL, auth need, and
  coverage; states with no feed are listed as "no work-zone data for <state>" in the
  response so absence of data is never read as absence of work zones.
- Items: `{ mile, state, roadName, direction, kind: closure|lane_closure|restriction|
  incident, startsAt, endsAt, vehicleImpact (height/width/weight limits when the feed
  states them), text, source, fetchedAt }`, filtered to the corridor (§1) and to
  events active at his ETA at that mile.
- A feed-stated **height/width/weight restriction** that his truck profile exceeds is
  a verdict **warning with a plain-words line** ("posted 13'6", your truck is 13'6""
  etc.); it never claims the route is blocked or open.
- Freshness: events max age 15 min (`aging` 5 min); a state feed that is down shows
  "<state> work-zone feed unavailable" and counts as `unavailable`, not "clear".
- Cost/volume: ≤ one fetch per state feed per 5 min (cached server-side, shared across
  requests — single-owner scale, polite User-Agent, honors each feed's terms).
- **Acceptance:** fixture feeds filter to corridor + ETA; an event ended before his
  ETA is dropped; a down feed yields a labeled gap, never silence; restriction vs.
  profile fixtures warn correctly; a state with no feed is named in the response.

## 4. Data and API changes

- No migration expected for Phases 1–2 (computed per request; short in-process cache).
  Phase 3's registry is code. If persistent caching is later wanted, a design note +
  migration comes first (not assumed).
- `POST /api/v1/smart-path/route-check` response gains `corridor`, `regionalFuel`,
  `weather`, `stateRules`, `roadEvents`, each section shaped
  `{ status: "ok"|"partial"|"unavailable", items[], notes[], asOf }` so one failing
  source can never blank the rest. `docs/api-contracts.md` and `schemas` updated
  with each phase.
- Abel `check_route` summarizes the same sections (read tool; matrix row unchanged
  in authority — read-only).

## 5. UI (phone-first, parked-planning surface)

- Verdict stays glance-grade at the top; new sections are collapsible cards below:
  **Along the route** (states with mile ranges), **Fuel by region**, **Weather**,
  **State rules**, **Road work**. Each card header carries its freshness badge
  ("as of 4:12 PM ET", amber when aging, grey "unavailable"). Stale items are
  dimmed and prefixed "Old data:".
- Nothing here is used while rolling; Drive Mode shows none of it in v1 of this work.

## 6. Freshness table (code constants, shown on the page)

| Source | aging at | stale at | on stale |
|---|---|---|---|
| Regional diesel (EIA weekly) | 8 days | 10 days | labeled; not used to rank |
| NWS forecast | 1 h | 3 h | hidden, "unavailable" |
| NWS alerts | 10 min | 30 min | hidden, "unavailable" |
| WZDx events | 5 min | 15 min | hidden, "feed unavailable" |
| State rules table | — | 12 months since `verified_on` | shown with its age |

## 7. Build order and gates

1. Phase 1 (corridor + states + ETA-at-mile) — pure lib + tests, then response + UI.
2. Phase 2a regional fuel, 2b weather, 2c state rules (each its own gated commit).
3. Phase 3 feed registry + events (start with the states on his common lanes; others
   listed as "no data").
Each step: spec check → code → full gate → docs/state → push; King verifies live
(feeds are reachable from Fly? — each outbound host is checked once, like the FMCSA
lesson; an unreachable source is reported, not worked around).

## 8. Open questions for the owner

1. Corridor width: default 10 mi each side for fuel/food, 25 mi for weather points.
2. Which states' work-zone feeds first (his common lanes)?
3. Is "wind ≥ 35 mph" the right trigger for his trailer, or do you want it lower?
4. State rules: he or King supplies verified rows for his home/common states first;
   Claude will not populate legal facts from memory.
