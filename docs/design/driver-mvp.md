# Driver MVP — checklists, dispatch helper, duty log, Telegram private bot, dispatch exchanges

Written 2026-10-31, ahead of code, per this repo's spec-first workflow
(`CLAUDE.md`). Owner-authorized the same day for a real first run on
2026-11-01 (driving another owner-operator's truck, Melbourne FL →
Georgia pickup, dispatch coordination in Spanish over Telegram). Short
by design — this closes the "no spec exists for this area" gap for
exactly these five pieces and nothing more.

## 1. Checklists (static UI, no data)

A phone-readable page under Fleet: coupling, uncoupling, docking/
backing, and at-the-shipper/receiver paperwork steps. Static content in
the page component, same treatment as the pre-trip checklist prompts
(`docs/schemas.md`'s `pretrip_inspections` note: standardized practice
is rendered in the UI, not modeled as data). The pre-trip form's
`CHECKLIST_ITEMS` grows the coupling-specific prompts it was missing
(landing gear, glad hands/air lines, tug test, kingpin visual check).

## 2. Dispatch helper (AI capability: `dispatch_helper`)

One stateless capability, two surfaces, one shared service
(`src/services/ai/dispatch.ts`):

- **Operating fact (owner-confirmed 2026-10-31):** Steven is
  **leased on to another carrier** — his own MC doesn't have enough
  history/accounts to get loads directly — so the truck runs under
  that carrier's authority. Consequence for this helper: dispatch
  messages may come from the *carrier's* dispatch, not just Steven,
  which is exactly why the sender-read (owner / dispatcher / broker /
  shipper / receiver) must stay honest about uncertainty instead of
  assuming every message is Steven.
- **Input:** a pasted dispatch message (Spanish or English) + optional
  free-text context. The message is *untrusted external content*
  (broker/dispatch text) — the system prompt treats it strictly as text
  to translate and explain, never as instructions, per `CLAUDE.md`.
- **Output (validated Zod contract, same discipline as
  `output-contract.ts`):** English translation, a plain-language read
  of what is being asked, who the sender most likely is
  (owner / dispatcher / broker / shipper / receiver / unknown) with the
  reasoning, and a suggested reply in English **and** Spanish. The AI
  drafts; the human sends. Nothing is ever sent by the app.
- **Governance:** a real capability under `docs/governance.md` — added
  to `KNOWN_CAPABILITIES`, off by default, checked (global switch
  first, then per-capability) before any provider call in the
  authenticated web/API path. The provider is the existing
  `OpenAiProvider` behind the `AiProvider` interface; the response
  format is JSON (the provider's existing `json_object` mode).
- **Endpoint:** `POST /api/v1/dispatch-suggest` (authenticated,
  `createApiHandler`, validated body, no persistence in this endpoint
  itself — persistence is the separate exchanges resource, §5).

## 3. Duty log / HOS helper (`duty_logs`)

A manual, warn-only paper-log helper. **It is not an ELD and not a
system of record for HOS compliance** — the truck's ELD (or official
paper logs) remains the legal record, consistent with
`docs/requirements.md`'s existing non-goal. Standard CRUD resource
following the brokers pattern exactly:

- One row per duty-status start: `driver_id`, `load_id` (both
  nullable), `duty_status` (`off_duty | sleeper | driving | on_duty`),
  `started_at`, `location`, `odometer`, `notes`, plus global
  conventions (`company_id`, timestamps, soft delete, tenant RLS).
- `src/lib/hos.ts` computes warn-only summaries from the rows: driving
  time in the current 14-hour window (window restarts after a
  continuous ≥10-hour off/sleeper rest), driving since the last
  ≥30-minute break of any non-driving status, and on-duty time in the
  last 8 days vs the 70-hour limit. It warns; it never blocks, edits,
  or certifies anything. Segments are derived: a row runs until the
  next row's `started_at` (or "now" for the latest row).

## 4. Telegram private bot v1 (`POST /api/telegram/webhook`)

A personal assistant surface for the owner only — **not** a group
integration, in v1 or by extension:

- The bot serves exactly one private 1:1 chat: the owner's. It never
  joins, reads, or sends to any group, and never sends anything to any
  third party. Incoming text (typed, pasted, or forwarded into that
  private chat) runs through the same dispatch-helper service (§2) and
  the bot replies in that same private chat with the translation,
  sender read, and suggested replies.
- **Fail-closed, in order:** (1) `TELEGRAM_BOT_TOKEN` unset → route
  disabled (503, no processing). (2) If `TELEGRAM_WEBHOOK_SECRET` is
  set, the `x-telegram-bot-api-secret-token` header must match or the
  request is rejected. (3) Non-private chats are always ignored.
  (4) Allowlist: `TELEGRAM_ALLOWED_CHAT_ID` set → any other chat id is
  silently ignored. Allowlist unset → **bootstrap mode only**: the bot
  replies (in a private chat only) with that chat's id and setup
  instructions, and runs *no* AI processing. This exists solely so the
  owner can learn his chat id; it must be replaced by the real
  allowlist immediately after setup.
- The webhook has no user session, so it cannot check the in-app AI
  kill switches (they are per-company session data). Its revocation is
  its own env surface: unset the token or the allowlist and it stops.
  That boundary is deliberate and recorded here, not discovered later.
- `src/proxy.ts` lists `/api/telegram` as public for the same reason
  `/api/internal` is: no browser session exists for this caller; the
  route enforces its own checks above.
- **Setup (owner steps, in order):** (1) Create a bot with @BotFather
  (`/newbot`), keep the token private. (2) `fly secrets set
  TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=<a random string he
  generates>`. (3) Redeploy, then message the bot privately once —
  bootstrap mode replies with his chat id. (4) `fly secrets set
  TELEGRAM_ALLOWED_CHAT_ID=<that id>` and redeploy. (5) Register the
  webhook: `curl https://api.telegram.org/bot<TOKEN>/setWebhook
  -d url=https://trucking.fly.dev/api/telegram/webhook
  -d secret_token=<the same TELEGRAM_WEBHOOK_SECRET>`.
  No real token is ever committed or handled in the repo.

## 5. Dispatch exchanges (`dispatch_exchanges`) — learning his voice

The raw material for teaching the app how the owner actually writes:
every helped exchange can be stored with what came in, what the AI
produced, and — the valuable part — **what he actually sent**.

- Columns: `company_id` + tenant RLS like every other table,
  `incoming_message`, `ai_translation`, `ai_suggested_reply_en`,
  `ai_suggested_reply_es`, `actual_reply_sent` (nullable),
  `source` (`web | telegram`), `created_at`/`updated_at`/`deleted_at`.
- Standard CRUD resource (`/api/v1/dispatch-exchanges`) so the web
  page can save an exchange and later work can list/edit them
  (back-filling `actual_reply_sent` on a telegram row included).
- **Web:** after a suggestion renders, an optional "What I actually
  sent" field + save button stores the full exchange (`source: web`).
  Saving is always the owner's explicit tap — the suggest endpoint
  itself stays stateless (§2).
- **Telegram:** when the bot replies, it stores the exchange
  (`source: telegram`, `actual_reply_sent: null`). The bot cannot see
  what the owner later sends in the *other* app (the dispatch group),
  so actual-reply capture for telegram rows is later work (manual
  back-fill via the CRUD resource, or a future "reply to the bot with
  what you sent" flow). The bot's storage needs a tenant to write to:
  it uses the server-only `SUPABASE_SERVICE_ROLE_KEY` scoped by the
  `TELEGRAM_COMPANY_ID` env var — if either is unset, the bot still
  replies and simply skips storage. This is a recorded, deliberate
  exception to the "service role is admin tooling only" note in
  `.env.example`: single-tenant bot, one fixed company id from env,
  never user-supplied input. Owner step: `fly secrets set
  TELEGRAM_COMPANY_ID=<his company uuid>` (visible in his
  `user_profiles` row) to enable it.

## 6. Bot intelligence (added same day, owner's explicit bar)

The owner raised the bar mid-build: the bot should be a real
conversational agent, "as smart as the bot I'm building for my second
brain" — not a dispatch-only responder. His Soumaya bot's documented
failures are the requirements here, named so they can't recur quietly:

- **Guaranteed context, not model-elected.** Every AI turn builds its
  prompt in code (`services/telegram/store.ts` + `context.ts`):
  (a) **conversation history** — persisted per turn in
  `telegram_messages` (migration `00013`), the recent 20 turns loaded
  and injected. A bot answering with empty history is the exact bug
  he already lived through; (b) **a live company snapshot** — active
  loads, current duty status + HOS figures from `src/lib/hos.ts`,
  last-7-days expense/fuel totals, contacts with real counts and
  names, all from real queries, formatted by
  `formatCompanySnapshot`. A number in an answer traces to a line in
  that block or it isn't said; (c) **his standing instructions** —
  `bot_memories` rows of kind `instruction` (migration `00014`),
  injected **in full on every prompt**, both dispatch and chat. This
  store doubles as the bot's profile/settings store (chosen over a
  separate settings table: one durable store, one retrieval path);
  (d) **retrieved memories** — keyword match + recency over
  `bot_memories` (v1 retrieval, stated plainly: no embeddings yet).
- **Free-form intake + long-term memory.** Routing is code, and
  predictable (`classifyTelegramText`): forwards → dispatch flow;
  Spanish-looking text → dispatch flow; `remember:` → captured as a
  memory (expense-flavored dictation → kind `expense_hint`, and the
  acknowledgement says out loud it was **captured for review, not
  booked**); `instruction:`/`always …` → standing instruction;
  everything else → conversation (`services/ai/bot-chat.ts`), which
  answers business questions from the snapshot ("how much have I
  spent on fuel this week?", "when does my 14 run out?") and can
  itself surface a dictated fact in its output's `memory` field,
  which the bot then stores. Coaching rule for the chat prompt: how-
  do-I-handle-this answers use his actual load/hours, not generics.
- **What shipped vs what's next, honestly.** Shipped tonight:
  dispatch + persisted history + snapshot + instructions + memory
  capture/retrieval, one completion per turn. **Not** shipped: a
  tool-calling agent loop. The named next increment ("Bot
  intelligence v2 — agent loop"): (1) expose the existing CRUD API
  as bot tools via a `services/telegram/tools.ts` that calls the same
  service layer with the bot's company scope; (2) a bounded loop in
  `services/ai/bot-chat.ts` (max N tool rounds, every call logged);
  (3) write tools (create expense, log duty status) behind an
  explicit confirm step in chat — the bot proposes, the owner taps
  yes — per `docs/governance.md`'s approval boundaries; (4) swap
  keyword retrieval for embeddings once `bot_memories` volume makes
  keyword matching visibly weak. Also outstanding: the task 5.1 RLS
  suite's table list needs `telegram_messages` + `bot_memories` too
  (recorded as task 7.6's scope).
  **Update 2026-10-31:** that increment shipped as §8 below (branch
  `bot-intelligence-v2`) — with two honest deltas from the sketch
  above: the tools live in `services/bot/tools.ts` and query through
  the shared bot store rather than the HTTP CRUD layer (same company
  scope, no self-HTTP hop), and item (4), embeddings, remains
  designed-only. Task 7.6's RLS coverage shipped with it.

## 8. Bot intelligence v2 — agent loop + web chat (tasks 7.8/7.10, shipped on branch `bot-intelligence-v2`)

Built 2026-10-31 under the owner's standing order ("whatever it
takes to get this completely built"). This section is the spec for
what §6 named as the next increment; §6's history stays as written.

- **Agent loop (`src/services/ai/agent-loop.ts`).** The chat path is
  no longer one completion per turn. The provider interface gains a
  tool-calling turn (`runToolTurn` on `AgentCapableProvider`, §6's
  provider pattern extended, not replaced — `complete()` is untouched
  and dispatch/briefing behavior is unchanged). The loop is bounded
  at **6 provider rounds**; every tool call is logged (name, access,
  outcome) and exhaustion returns an honest "I ran out of steps"
  reply instead of a fabricated completion. Guaranteed context is
  unchanged and non-negotiable: history + snapshot + standing
  instructions + retrieved memories are assembled in code and ride
  every turn whether or not the model calls a tool.
- **Grounding guard, now in code, not just prompt.** Dollar figures
  in the final reply are extracted and checked against the grounding
  corpus (the context blocks, the owner's own message, and this
  turn's tool results). A figure that traces to none of them is
  replaced by an honest refusal-to-quote reply. Tool errors surface
  in the reply as errors — a failed query is said out loud, never
  papered over with an invented number.
- **Tools (`src/services/bot/tools.ts`).** Read tools act freely —
  it is his data: `list_loads`, `hos_summary` (reuses `lib/hos.ts`),
  `money_summary` (expenses/fuel totals, per-load expenses when a
  load id is given — fuel is not load-linked in the schema and the
  tool says so), `list_contacts`, `list_documents`,
  `search_memories`, `search_dispatch_exchanges`. Write tools —
  `create_expense`, `create_fuel_purchase`, `log_duty_status`,
  `save_memory`, `add_load_note` — carry a required `confirmation`
  argument with the owner's standing rule behind it: `execute` only
  when the owner directly ordered the write in this message (it runs
  immediately and confirms back with the real recorded result);
  anything the bot itself proposes is `propose` — **not executed**.
  A proposal is stored in `bot_pending_actions` and the reply asks
  for his yes. A bare yes/no as his next message resolves the oldest
  pending proposal in code (before any model call); proposals
  **expire after 2 hours** so a stale "yes" can never write a
  time-wrong duty log days later. Write arguments are Zod-validated
  in the tool, not trusted from the model.
- **Kill switch.** New capability `bot_chat` under the same
  `ai_capability_settings` pattern, governed like the others:
  global switch first, then per-capability, no row = off (fails
  closed). With the capability off, conversational turns reply that
  the assistant chat is turned off and where to enable it; dispatch
  help, `remember:`/`instruction:` capture, and the v1 reduced mode
  (no store configured) are unaffected. Note the behavior change
  from v1, stated plainly: once this lands, the conversational bot
  needs "Bot chat" enabled in More → Account & settings (the
  Telegram store reads the same settings rows through its
  service-role path — the §4 env-revocation boundary still exists
  on top of this).
- **One brain, two windows (`src/services/bot/store.ts`).** The
  store is channel-parameterized (`telegram | web`) over one
  Supabase client + company scope. `telegram_messages` gains a
  `channel` column (migration `00015`; `chat_id` becomes nullable —
  it is Telegram-only provenance) and history is loaded
  **company-wide**: web and Telegram turns interleave in a single
  timeline, each row tagged with its channel. There is no second
  history, memory, or snapshot for the web surface to diverge into.
  The web chat is `POST/GET /api/v1/assistant/chat` (owner session,
  `createApiHandler`) + More → Assistant. On the web surface the
  dispatch intent additionally honors the `dispatch_helper` kill
  switch (the session exists there, unlike the webhook).
- **Still not in this increment:** embeddings retrieval (keyword +
  recency remains, per §6's sequencing); Smart Path (§7); the bot
  reading or joining any group; a userbot. Migration `00016`
  (`bot_pending_actions`) joins `00011`–`00015` as committed, **not
  applied** — same owner step as before.

## 7. Future increments (designed, deliberately not built tonight)

- **Smart Path — mapping & smart lanes.** A mapping section built on
  lane intelligence learned from his own loads: rate-per-mile by
  lane, deadhead distance, reload probability out of a destination —
  computed from the `loads` table he already fills in, so it gets
  smarter from his real history instead of generic market data (the
  grown-up form of `My idea`'s "Florida trap"/positioning thinking).
  The map itself is **native in the app**: a real, responsive map
  view rendered via an embedded maps SDK — he opens his app and the
  map is there; switching to Google Maps must never be necessary
  (an optional "open in…" handoff is fine, and a maps engine under
  the hood is fine — the trucking intelligence is this app's layer,
  not a rebuilt maps engine). One route, governed by *everything at
  once*, in his priority order — legal first, rested second, paid
  third: appointment windows for the load; his HOS clocks (from
  `duty_logs` / the ELD picture); planned sleep; the truck profile
  (speed, size/weight-legal roads); and his personal driving
  preferences, including preferences the bot learns from their
  Telegram conversations (times and ways he doesn't want to drive),
  with tradeoffs spoken to him via Telegram rather than silently
  made. Two route overlays ride on the same computation:
  **best-fuel routing** — fuel stops chosen on *effective* cost
  (price vs the detour/deadhead to reach it), not headline price;
  and **food routing** in two modes — fast food when time is short,
  and cheap grocery stops (Walmart-type) for cooking in the truck,
  keyed to an **appliance inventory on the truck profile** (what he
  can actually cook with decides what groceries make sense; flag
  for the Smart Path build: `trucks` needs an `appliances`
  field/list — deliberately *no* schema change tonight — first
  capture is Steven's truck's setup, on the first run). Food
  routing respects his standing 8pm–8am fast: inside that window
  it suppresses food suggestions entirely. Governing design law
  for the whole surface:
  **phone-away while driving** — voice in, voice out, audio alerts
  only; nothing that asks him to read or type at the wheel; the
  Telegram bot is Smart Path's voice. Open unknown, to be discovered
  on the first run: the leased-on carrier's ELD may already bundle
  navigation, which would shrink this to lane intelligence + alerts
  only.
- **Web chat window — second window, same brain.** The app will get
  an in-app chat, but it is a *window onto this same bot*, never a
  second chat with its own memory: it must read/write the same
  `telegram_messages` history, the same `bot_memories`, and the same
  code-assembled snapshot context (§6), so Telegram and web can never
  diverge into two brains that know different things. Decided by the
  owner 2026-10-31 (decision delegated and ruled): **Telegram is the
  primary channel; the web chat ships after Telegram v1 proves out.**

Context every prompt carries, in one list: system rules → standing
instructions (full) → company snapshot (chat; also dispatch context)
→ retrieved memories → recent conversation history (chat) → the new
message. Dispatch calls carry instructions + snapshot + memories as
their `context` argument.

## 8. Smart Path v1 (built 2026-10-31, Wave C — expands §7's sketch)

The owner's full Smart Map spec lives in the product vision doc
(§9 "Smart lanes & mapping"). This section is the v1 increment's
contract: what ships, what is honestly stubbed, and what stays
designed-only. Priority order is fixed by the owner and is the
verdict's structure: **legal first, rested second, paid third.**

### 8.1 Stack choices (and their limits, stated now)

- **Map rendering: MapLibre GL JS over OpenStreetMap raster tiles.**
  Keyless, open, actively maintained — the engine the vision doc
  names as the leading open option. The map is native in the app
  (`/smart-path`): pan/zoom, route line, origin/destination, sleep
  stop and stop-candidate markers. An "open in Google Maps" handoff
  link exists as an escape hatch only, per spec.
  **Limits:** OSM's tile policy is fair-use for light volume — fine
  at one-truck scale, not a production tile plan for a fleet; a paid
  tile provider is the later swap (the style is isolated in one
  component constant so the swap is one place). Raster tiles, no
  traffic layer, **no offline corridor caching in v1** (designed in
  the vision doc, not built here).
- **Routing: provider interface, OSRM public demo implementation.**
  `src/services/integrations/routing.ts` defines `RoutingProvider`
  (`getRoute(from, to)` → distance, duration, GeoJSON geometry);
  the only implementation is `OsrmRoutingProvider` against
  `router.project-osrm.org`. Keyless. **Limits, never hidden in the
  UI copy:** OSRM's public server is a demo service (fair-use, can
  rate-limit), and its driving profile is a **car** profile —
  **v1 route geometry is NOT truck-legal**: it does not enforce
  height/weight restrictions or truck-prohibited roads. The truck
  profile (§8.2) governs the plan's speed assumption and the
  verdict's warnings; it does not reshape the geometry. A truck
  routing provider (HERE/PTV-class, keyed) drops in behind the same
  interface later. If the provider is unreachable, the endpoint
  fails honestly — no estimated distance is ever fabricated.
- **Geocoding: provider interface, Nominatim implementation.**
  `src/services/integrations/geocoding.ts`; load origin/destination
  free text → coordinates, cached in-process per query string.
  Keyless, low volume only (Nominatim fair-use: ≤1 req/s, which a
  single-owner route check respects by construction).
- **Places (fuel/food candidates): provider interface, Overpass
  implementation.** `src/services/integrations/places.ts` queries
  OpenStreetMap (Overpass API, keyless) for `amenity=fuel`,
  `amenity=fast_food`, `shop=supermarket` near sampled points along
  the route geometry. **Limits:** OSM coverage of truck parking /
  truck-access at a given exit is spotty — a candidate is a place
  that exists on the map, not a promise a 53' trailer fits; the UI
  says so. Overpass failure degrades that section to "unavailable",
  never to invented stops.

### 8.2 Truck profile (migration 00017)

`trucks` gains the Smart Path profile — the design in §7 flagged
this exact schema change ("`trucks` needs an `appliances`
field/list — deliberately no schema change tonight") and v1 is
when it lands:

- Dimensions: `height_in`, `length_in`, `weight_lbs` (integers,
  nullable — unknown until captured).
- Running profile: `governed_speed_mph` (caps the plan's assumed
  average speed), `tank_capacity_gallons`, `avg_mpg` (seeded by
  hand; sharpened later from `fuel_purchases`, not auto-computed
  in v1).
- **Appliance inventory:** `appliances text[]` (known values:
  `fridge`, `cooler`, `microwave`, `air_fryer`, `hot_plate`,
  `coffee_maker`, `inverter`, `none`) + `appliance_notes` free
  text (inverter watts, cooler size — the detail the vision doc
  asks for). `none` is exclusive: it means "nothing in the cab"
  and cannot combine with other values (enforced in the Zod
  schema, not the DB).
- **UI:** the New Truck form gains the full (optional) profile,
  and Fleet gains a **Truck profile** page (`/fleet/truck-profile`)
  to view/edit any truck's profile via the existing
  `PATCH /api/v1/trucks/[id]` — this is the page the owner uses to
  capture Steven's truck on the first run. Nothing is seeded: the
  first real profile is Steven's truck, captured by the owner.
- No new table → the RLS suite's table list is unchanged.

### 8.3 Route check (`POST /api/v1/smart-path/route-check`)

Authenticated, validated (Zod), computed — not a CRUD resource.
No AI provider is involved: the verdict is deterministic
computation in `src/lib/smart-path.ts`, unit-tested without any
network. Orchestration in `src/services/smart-path/route-check.ts`.

- **Input:** `load_id` (origin/destination/rate/miles/truck come
  from the load), `depart_at` (planned departure from the pickup,
  loaded — the deadhead leg to the pickup is not routed in v1,
  stated in the response), optional `pickup_window` /
  `delivery_window` (`{start, end}` ISO timestamps; the page
  defaults them from the load's pickup/delivery dates and the
  owner adjusts — **storing windows on the load is a later
  increment**, deliberately no `loads` columns in v1), `food_mode`
  (`grocery` | `fast_food`), optional `gallons_to_buy`.
- **Clocks:** the driver's `duty_logs` (last 8 days) through the
  existing `summarizeHos` — remaining drive (11h), remaining
  window (14h), driving-until-break (30-min rule), remaining
  8-day on-duty (70h). No logs → the plan runs against fresh
  clocks and the response says so out loud (assumption, not fact).
  Warn-only, same standing as §3: the ELD is the legal record.
- **Simulation:** drive the route against the clocks in wall-clock
  order — insert a 30-minute break when the break clock runs out,
  a 10-hour rest when the drive or window clock runs out (rest
  resets both), and stop as **not legal** if the 70-hour clock
  can't cover the drive (a rest doesn't fix that; a 34-hour reset
  or roll-off does, and the verdict says which). The sleep stop's
  position is interpolated along the route geometry for the map.
- **Verdict, in the owner's priority order:**
  - *Legal:* `on_time` / `early` / `late` / `not_legal`, with the
    rest/break plan that makes it legal, or the clock that makes
    it impossible.
  - *Rested:* where the planned sleep lands (Eastern time) —
    a rest forced into midday is flagged as a bad sleep, not
    silently accepted; a rest inside his normal night hours is
    confirmed in words.
  - *Paid:* rate per mile and load gross from the load's own
    `rate_cents`/`miles`, when present.
  - *Tradeoff lines in plain words,* e.g. "Leaving at 7:00 AM
    gets you there 1h 20m after the window closes. Leaving by
    5:40 AM makes it, with the same rest plan." — computed
    (`latestDeparture` / `neededDeparture`), never templated
    guesses.
  - Pickup window, when given, is a warning line (planned
    departure outside it), not a legality gate — loading time
    isn't modeled in v1.
- **Fuel candidates:** his own `fuel_purchases` locations (grouped,
  average price) that geocode within a corridor of the route,
  plus Overpass `amenity=fuel` along the route, ranked by
  **effective cost** (`src/lib/smart-path.ts`): pump cost for the
  planned gallons + detour fuel + detour time priced at a stated
  value-of-time + a fixed stop/idle allowance. Constants are named
  in code and shown in the response, not buried. History is the
  price source where it exists; Overpass candidates carry no price
  (OSM rarely has one) and rank on detour alone, labeled as such.
- **Food candidates:** Overpass near the route, by `food_mode`.
  Grocery stops are filtered/explained by the truck's appliance
  inventory (full cook plan needs a cooking appliance + cold
  storage; cooler-only = cold/sandwich plan; no storage and no
  cooking appliance = grocery mode reported not workable, with
  the reason — the stop isn't dressed up as a plan it can't be).
  **Fast window:** any food suggestion whose arrival time falls
  inside **8pm–8am America/New_York** is suppressed entirely,
  and the response says food was suppressed and why (§7's rule).
- **Phone-away law (vision §9):** v1's surface is the *parked*
  planning surface — but the verdict block is glance-grade by
  design: the status and the one tradeoff line in large type at
  the top, detail below. Voice in/out via the Telegram bot is
  the bot's increment, not this page's; nothing on this page is
  needed while rolling.

### 8.4 Designed-only after v1 (not built, not stubbed silently)

Lane intelligence from load history (rate/mile by lane, deadhead,
reload probability — §7/§9c); offline corridor tile caching;
traffic; parking availability; storing appointment windows on
loads; learning `avg_mpg` from fuel history; spoken Smart Path via
the bot (§9g); the personal preference layer learned from Telegram
(§9b.5). (Truck-legal route geometry was on this list in v1; §8.5
is the increment that lands it.)

### 8.5 Truck-legal routing (built 2026-10-31, Wave C follow-up — task 7.13)

The owner ruled the v1 gap unacceptable and set the budget law for
closing it: **free first — everything free; only if no free option
exists, the cheapest possible.** Two free truck-aware stacks were
evaluated against the `RoutingProvider` interface; both route on
OpenStreetMap data and take the truck's real dimensions
(height/width/length in meters, weight in metric tons):

| | OpenRouteService `driving-hgv` | Valhalla `truck` costing (public endpoint) |
|---|---|---|
| Dimension/restriction support | `options.profile_params.restrictions` (length/width/height m, weight/axleload t, hazmat) under the HGV profile; HGV road-access filtering is in the routing graph itself | `costing_options.truck` (height/width/length m, weight t, axle_load, hazmat); truck costing checks truck access + height/width/weight limits |
| Cost / free tier | Free Standard plan: **2,000 directions/day, 40/min**, published on the plans page; needs a free API key (`ORS_API_KEY`) | Keyless. Public FOSSGIS endpoint (`valhalla1.openstreetmap.de`) is a community demo service — fair use, **no published quota or SLA** |
| Fit for this app | A handful of route checks/day is ~0.1% of the free quota; a hosted, maintained service (HeiGIT) is the one to depend on | Same dimension support, zero setup — but a demo endpoint is not a thing to build the primary path on |
| Escape hatch | Open source — self-hostable later (same posture as ORS's own docs suggest past the free tier) | Open source — self-hostable later; `VALHALLA_URL` already points the client at any instance |

**Choice: OpenRouteService is primary; Valhalla is the keyless
fallback; OSRM car remains the last resort.** The chain
(`defaultRoutingProvider()` in `src/services/integrations/routing.ts`)
is: ORS (only when `ORS_API_KEY` is set) → Valhalla → OSRM. Route
checks pass the load's truck profile (§8.2: `height_in`,
`length_in`, `weight_lbs`, converted to meters/tons) into every
truck-aware request. The profile has no width column, so width is
never sent — the engines apply their HGV defaults; adding a width
capture is a §8.2 schema change for a later increment, not an
assumption to invent here.

**What `truckLegal` means now — the honest version.** `RouteResult`
carries `truckLegal` from the provider that actually served the
route: `true` only when ORS-HGV or Valhalla-truck produced the
geometry, `false` for OSRM. If the chain falls back to OSRM, the
v1 car-route warning returns **verbatim** — a fallback never
upgrades the claim silently. Even when `truckLegal` is `true`,
the word has a boundary the UI states: the engines respect the
restrictions **recorded in OpenStreetMap data** (maxheight /
maxweight / maxwidth / hgv access tags). OSM's restriction
coverage is incomplete, especially off the interstates — a road
with no recorded limit is treated as passable. So: truck-checked
against the map data that exists, **not** a guarantee, and the
truck's own nav/ELD remains the final word. The response keeps a
provider attribution (`route.provider`) and merges the chain's
notes (e.g. "ORS not configured — skipped", "Valhalla
unreachable — fell back") into `warnings`, so which engine
answered, and what was skipped or degraded, is never hidden.

**Config (`.env.example`):** `ORS_API_KEY` (server-only; absent =
ORS skipped in the chain, noted in the result), `VALHALLA_URL`
(optional; full route-endpoint URL, defaults to the public
FOSSGIS endpoint). **Owner setup, once the free ORS key exists:**
`fly secrets set ORS_API_KEY=<key> -a trucking` and redeploy —
no code change; the key drops into the env the chain already
reads. Until the key lands, Valhalla carries truck-legal routing
keylessly, which is exactly why it is in the chain ahead of OSRM.

**Failure posture is unchanged from v1:** every provider response
is Zod-validated; a provider failure degrades to the next in the
chain with a note; if the whole chain fails the endpoint returns
the honest 502 — no geometry, distance, or duration is ever
fabricated. Written from the providers' documented API shapes and
fixture-tested, **not live-verified from this sandbox** (egress
blocked, same caveat as §8.1/EIA) — verify after deploy.

## 9. Agent omnipresence — full tool coverage + dump intake (task 7.12, stacked on §8)

Owner's requirement, 2026-10-31: the agent must know everything it
needs to know and have the tools to interact with and do ANYTHING
based on a conversation — it can fill in ANY of the app's tabs on
its own, from conversation and from info/document dumps he hands
it. §8 shipped 7 read + 5 write tools; that is partial coverage of
the schema in `docs/schemas.md`. This section closes the gap. All
§8 invariants carry over unchanged: guaranteed code-assembled
context, the grounding guard, tool-call logging, the `bot_chat`
kill switch, one shared brain across Telegram and web, and the
standing write rule (his direct imperative executes and confirms;
anything the bot proposes waits for his yes; proposals expire
after 2 hours).

- **Full read coverage.** Every business entity in
  `docs/schemas.md` is queryable in conversation: loads, expenses
  (line items, not just §8's totals), fuel purchases, brokers,
  customers, drivers (detail incl. assigned truck; CDL reported as
  on-file yes/no, never quoted in chat), trucks, trailers,
  pretrip inspections (incl. pass/fail and defects), equipment
  checklist items, maintenance events, maintenance schedules
  (with due status computed by `lib/maintenance-schedule.ts`),
  duty logs (raw entries alongside §8's HOS summary), documents
  (metadata **and content** — see the extracted-text contract
  below), bot memories, dispatch exchanges, and industry
  briefings (read-only; generation stays with that capability's
  own scheduler). There is **no invoices/settlements table** in
  the schema — settlements exist as documents and as load rates;
  the agent says so rather than inventing a ledger.
- **Full write coverage.** Create + update tools for loads
  (including status changes), expenses, fuel purchases, brokers,
  customers, drivers, trucks, trailers, maintenance events,
  maintenance schedules (incl. mark-done), checklist items (incl.
  mark-checked), pretrip inspections (logging a completed
  inspection), duty entries (§8's `log_duty_status` gains explicit
  start time/odometer/load), document attach-to-load (re-pointing
  a document's related entity — the file itself still arrives via
  More → Documents), and §8's memory/note tools. Bot-facing
  arguments use driver units (dollars, not cents) exactly as §8
  established; before any insert/update runs, the built row is
  validated against the **same Zod schemas the UI/API use**
  (`src/data/schemas/*`) — the tool layer may translate units, it
  may not weaken validation.
- **Deletes always confirm.** One `delete_record` tool (soft
  delete, per the global convention; `documents` excluded — that
  table hard-deletes by design and the bot does not delete files).
  The loop gains an `alwaysPropose` tool flag: a delete is staged
  as a proposal **even when the owner orders it directly** —
  `confirmation: "execute"` cannot run it. His yes (the §8 code
  path) is the only execution route. Destructive is the one place
  the direct-imperative rule does not apply, by design.
- **Dump intake (the centerpiece).** A dump is any message
  carrying several recordable facts at once — a forwarded dispatch
  thread, a rate con pasted as text, a settlement, a brain-dump
  paragraph. The model extracts candidates and calls ONE staging
  tool, `stage_dump_items`, carrying every item in a single call:
  `{ tool_name, args, source_quote, confidence }` per item.
  Staging never writes (dumps are agent-proposed by definition,
  even if he says "record all that"). Before anything is stored,
  **code validates every item** (`services/bot/dump-intake.ts`):
  (1) the target is a real write tool and its args pass that
  tool's Zod validation; (2) `source_quote` is a verbatim span of
  his message; (3) numeric grounding — every number in the item's
  values (amounts, codes like a gate code, counts) must appear in
  his message text; a value that appears nowhere is **rejected**,
  named in the reply with its reason, and never staged. Unknown
  fields stay absent — the model is instructed to omit, never
  guess, and updates must reference records it actually read
  (ids come from read tools, not from the dump). Accepted items
  are stored as individual `bot_pending_actions` rows sharing a
  `batch_id` with stable item numbers (migration `00021`), and
  the reply is ONE consolidated, numbered proposal: each item in
  plain words with its values, its source quote, and its
  confidence. His replies, resolved **in code** before any model
  call: a plain yes / "approve all" executes every item in order;
  "approve 1, 3" executes exactly those and leaves the rest
  pending under their original numbers; "drop the rest" / a plain
  no clears what remains; a correction ("3 is wrong, it's 4417")
  goes to the model with the batch in context and one job — call
  `revise_pending_item`, which re-validates the patched args
  against the target tool's schema, re-summarizes, and updates
  the stored proposal (a revision writes nothing to the books;
  only his later yes does). The 2-hour expiry applies to the
  batch as a whole. **Step budget:** the §8 6-step cap is NOT
  raised. A dump turn spends its steps as: optional read calls to
  resolve referenced records → one `stage_dump_items` call → the
  closing text. The staging call carries all items at once
  precisely so extraction never needs a step per record.
- **Documents: the extracted-text contract.** The document-scan
  work (its own branch) adds OCR text to documents. The agreed
  field is **`documents.extracted_text`** (nullable text; null =
  not yet extracted). This branch codes against that name with
  graceful absence: document tools first try selecting it, and on
  a missing-column error retry without it and say plainly that no
  extracted text is available yet — so the agent answers questions
  about a document's content the moment the scan branch lands,
  and degrades honestly before it. (Found while building this:
  §8's `list_documents` filtered on `documents.deleted_at`, a
  column that table does not have — documents hard-delete by
  design, `docs/schemas.md`. Fixed here; document tools never
  filter on it.)
- **Truck profile: the Smart Path contract.** The truck profile
  fields (migration `00017`, Smart Path branch: `height_in`,
  `length_in`, `weight_lbs`, `governed_speed_mph`,
  `tank_capacity_gallons`, `avg_mpg`, `appliances text[]`,
  `appliance_notes`) are read/written by the truck tools under
  the same graceful-absence rule as extracted text: this branch
  stacks on §8, where `00017` does not exist yet, so until both
  branches are merged and the migration applied, profile reads
  report "not captured yet" and profile writes surface the
  missing-column error honestly instead of pretending to save.
- **Deliberately not covered.** `companies` / `user_profiles`
  (identity, not business records), `ai_capability_settings`
  (the agent never touches its own kill switches — Settings is
  the only hand on those), briefing generation, and document
  file upload from chat: on the web surface a dump is pasted
  text (files go through More → Documents, then the agent reads
  them back via the document tools); on Telegram a photo's
  extracted text reaches the agent the same way once the scan
  branch lands. Dump intake is otherwise identical on both
  channels — same staging, same validation, same batch grammar.
- **Migration `00021`** adds the batch columns to
  `bot_pending_actions` (`batch_id`, `item_number`,
  `source_quote`, `confidence` — all nullable; single §8
  proposals are untouched). The store reads them with the same
  graceful-absence fallback, so §8 behavior survives even before
  `00021` is applied; batching activates when the columns exist.

## 10. Forwarded-conversation handling — the owner's correction (branch `abel-forward-fix`)

The owner used the live dispatch helper on 2026-10-31 and corrected
its behavior in substance: he did NOT ask for translation. The
dispatch feature's original §2 shape — translate first, draft
second — is **superseded** by this section for both surfaces
(Telegram bot and web More → Dispatch, which share
`services/ai/dispatch.ts`):

- **No translation of content already in English.** Language is
  classified in code (`detectMessageLanguage`: Spanish/English
  lexicon scoring plus accent and ¿¡ signals; genuinely mixed
  two-language threads are `mixed`, broken or imperfect English is
  `en` — his circle's typed English is imperfect and he understands
  it fine). `enforceLanguageGate` then strips any `translation_en`
  the model produced anyway for an English message — the rule is
  enforced by code on the parsed result, tested with fixtures,
  never left to the prompt. Only genuinely Spanish (or mixed)
  content earns a translation.
- **Workup first, draft last.** The suggestion schema leads with
  the work: `likely_sender_role` (who is speaking), what's being
  asked/told, plain facts, and `meaning_notes` — a brief "what they
  mean" interpretation, present ONLY where imperfect wording makes
  the meaning genuinely unclear. One reply draft, in the language
  the other side is using, only when a reply is evidently needed;
  dual EN+ES drafts only on his explicit request (the old
  always-both behavior is gone).
- **Recordable facts become proposals.** Load-shaped facts in a
  forward (lane, rate, dates) are extracted as `recordable_items`
  and staged through the §9 dump-intake validator
  (`validateDumpItems`: real write tool, verbatim `source_quote`,
  every number present in his message) into `bot_pending_actions`
  as a numbered batch (`services/bot/stage-recordables.ts`). The
  dispatch reply appends the batch proposal text; his yes/no —
  given in the assistant chat, resolved in code — is the only path
  that records them. If another proposal is already waiting,
  staging holds off and says so rather than stacking batches.
- Standing instructions, the grounding guard, and the `bot_chat`
  toggle semantics are unchanged. Saved dispatch exchanges store
  the single draft in the column matching its language; the other
  stays null.

## 11. Abel Job Brain — coaching, people, and pay (branch `abel-forward-fix`)

The owner's mandate (2026-10-31): Abel is his JOB BRAIN — from
conversations it teaches him the job, learns the people and the
business, and advises on pay. Three pieces, all built on the
existing brain (no new tables except the memory-kind widening):

- **Job knowledge** (`services/ai/job-knowledge.ts`): a curated,
  static module injected into the agent's system prompt (and the
  no-tools fallback prompt) — the load lifecycle end to end;
  paperwork guides (BOL, rate confirmation, scale ticket, lumper
  receipt, settlement: what each is, what to check before signing,
  what to photograph, what goes wrong); facility/dock problem
  responses (detention, refused freight, seal mismatch, lumper
  fees, late arrival — steps plus the words to say); and how driver
  pay is structured. Market bands for a new-CDL driver in an
  owner-operator's second truck live in the exported `PAY_BANDS`
  constants — labeled estimates with an as-of date — and the brief
  is RENDERED from those constants, so coaching and math cannot
  drift apart.
- **People & business learning** (`services/bot/people.ts`):
  durable knowledge about people he works with and how his
  operation runs, stored in `bot_memories` under two new kinds —
  `person_profile` and `business_fact` (migration `00028` widens
  the kind check; nothing else changes). Content is one structured
  line (`PERSON — <Name> | role: <role> | <facts…>` /
  `BUSINESS — <subject> | <fact>`) written only through the
  `save_memory` propose→yes path; a correction re-proposes the
  whole updated line (one current profile per person). Retrieval
  is the existing memory machinery — profiles surface in the
  remembered-facts block by name. Nothing about any real person
  is seeded in code; profiles start empty and fill from his
  actual forwards and corrections. Until `00028` is applied, the
  new kinds fail loudly at the database constraint and the bot
  reports the failure instead of pretending to save.
- **Pay advisor** (`services/bot/pay-advisor.ts`): a read tool,
  `evaluate_pay_offer`, where CODE does all the math — the model
  supplies the structure and the numbers from his words, never a
  computed figure. It converts any offer shape (CPM loaded-only or
  all-miles, percentage of gross or net, flat per load/day) into
  total load pay, effective CPM on ALL miles, a weekly projection,
  the percentage-of-gross equivalent, and the W2↔1099
  payroll-tax adjustment (SE tax 15.3% on 92.35% ≈ 14.13%
  effective vs 7.65% employee FICA — taxes only; lost protections
  are surfaced as a question, not a number), grades the result
  strong/fair/weak against `PAY_BANDS`, and returns the questions
  whose answers would change the verdict (who pays fuel, net
  deductions, detention terms, pay timing). The grounding guard
  applies as everywhere: figures in the reply trace to the tool's
  output.

## Out of scope for this pass

Certified ELD anything; the bot joining or reading any group; a
userbot / logged-in-as-the-owner client (a separate, riskier design
needing its own pass); per-load P&L; role-typed contacts; load
detail/edit screens; any Plaid or research-engine work.
