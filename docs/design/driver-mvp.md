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
truck-legal route geometry (keyed provider); traffic; parking
availability; storing appointment windows on loads; learning
`avg_mpg` from fuel history; spoken Smart Path via the bot (§9g);
the personal preference layer learned from Telegram (§9b.5).

## 9. Truck Fund + money visibility (Wave D — vision doc §2 + §8)

Written 2026-10-31, ahead of code, per the spec-first workflow.
Implements the money-visibility half of the vision doc's Phase 2:
the Truck Fund tracker, the sweep suggestion, the business-finance
ladder (vision §8), and an honest seam where live Plaid will go
(vision §2). The standing law from both vision sections, restated
because it shapes every choice below: **the app reads, computes,
and suggests — it never moves money.** There is no transfer
capability in this design, not "disabled" — not built.

### 9.1 Fund ledger — one ledger, his existing buckets (migration 00023)

`fund_entries` is a single manual ledger for the buckets that
already exist in the owner's Finance Project architecture — the
app operationalizes those names, it does not invent parallel
ones:

- `fund_key`: `truck_fund` (his transportation/car fund, aimed at
  his own truck) | `business_credit` (the business-credit bucket)
  | `emergency_fund` (the stability bucket; its $10,000 target is
  a Finance Project rule shown as *context* on the surface — the
  app displays it, it does not enforce or re-decide it).
- `kind`: `deposit` | `withdrawal`; `amount_cents` is positive,
  the sign comes from `kind`.
- `entry_date` (date), `lane` (`business` | `personal` — his
  Phase-1 rule: every trucking dollar tagged from load one),
  `source` (`manual` | `sweep` — a sweep entry is one he recorded
  from a suggestion, §9.3), optional `note`, optional `load_id`.

A fund's balance is **computed on read** (deposits − withdrawals
over non-deleted rows), same reasoning as the financial summary:
no stored balance to drift from the ledger. "Last moved" is the
newest entry's date.

`fund_settings` is the per-company singleton holding the sweep
rule and the target: `sweep_mode` (`off` | `percent` | `flat`,
**default `off`** — no rule exists until he sets one, and no
suggestion is ever computed without a rule), `sweep_percent`
(1–100, used by `percent`), `sweep_flat_cents` (used by `flat`),
`target_band` (`budget` | `mid` | `upper`), and `target_cents`
(an optional custom override; the effective target is
`target_cents` when set, else the chosen band's top).

### 9.2 Truck Fund progress — against the vision's price bands

The bands are the vision doc §2's **estimates**, labeled as such
on the surface: budget $20,000–$40,000, mid $40,000–$75,000,
upper $75,000–$120,000+. Progress is the fund balance against the
effective target, plus where the balance sits inside the chosen
band's range (below it / inside it / past its top). The vision's
warning rides along in the UI copy: a real target is *truck +
repair reserve + startup filings*, not just a sticker price —
that's what `target_cents` is for.

### 9.3 Earned toward the fund + the sweep suggestion

Two computed views over data the app already holds, both in
`src/lib/truck-fund.ts` (pure, unit-tested) and served by
`GET /api/v1/truck-fund`:

- **Earned toward the fund (never called a balance):** for the
  current week (Mon–Sun, UTC — the same convention the financial
  summary uses) and the current month: *settled income* = gross
  `rate_cents` of loads with status `completed`, placed in the
  period by `delivery_date` falling back to `pickup_date` (the
  financial summary's placement rule), and *settled net* =
  settled income − the period's `expenses` + `fuel_purchases` +
  `maintenance_events` (the financial summary's cost formula).
  `completed` is the app's only honest proxy for "the work is
  done and the money is earned" — there is no payment-received
  flag in the schema, and the design does not pretend otherwise.
  Draft/confirmed loads never count (STABILIZE: real income
  only).
- **The suggestion:** when a sweep rule exists and the period's
  settled net is positive, the app suggests moving
  `rule(net) − already-swept-this-period` to the Truck Fund
  (percent → floor of net × percent; flat → the flat amount).
  Sweep entries already recorded in the period are subtracted so
  recording a suggestion never re-suggests the same dollars.
  The card says what it is: *"$X settled this week. Your rule
  sends $Y to the Truck Fund."* **Record it** writes one
  `fund_entries` row (`source: sweep`, kind `deposit`) — a
  *record* of a move he makes himself in his bank's app. The
  surface says, in words, that the app does not move money.

### 9.4 Business finance ladder (vision §8) — guided order, owner state

`business_ladder_steps` stores only state: (`company_id`,
`step_key`) → `state` (`not_started` | `in_progress` | `done`) +
optional `note`. The knowledge is static, in
`src/lib/truck-fund.ts` — the six rungs in the vision's order,
each with a one-line *what it is* and a *next action*:

1. `ein` — EIN on file for the LLC.
2. `business_bank` — a business bank account in the LLC's name,
   separate from personal money.
3. `duns` — DUNS number, with company details matching exactly
   everywhere.
4. `tradelines` — starter tradelines that report (vendor net-30,
   a secured/starter business card).
5. `paydex` — payment history feeding the Paydex score (80+ is
   the conventional "good" zone; estimate/rule-of-thumb, labeled).
6. `real_credit` — first real business credit line in the
   company's name.

The ladder *walks the boxes in order*: the view computes which
rungs are unlocked (all previous rungs `done`). Marking a rung
done ahead of an unfinished earlier rung is **allowed but
flagged** ("out of order") rather than hard-blocked — he may
already hold an EIN from before the app existed, and a checklist
that refuses reality teaches nothing. No external calls; the
⚠️ VERIFY items from the vision (vendor programs change, Paydex
details) stay labeled as verify-before-relying in the copy.

### 9.5 Plaid — the seam, and what live actually requires

**Why a seam and not wiring:** live in-app Plaid needs *the
app's own* Plaid developer credentials and a Link flow served by
the app itself. The Plaid access King uses in chat is a separate
connector pipe into the assistant's environment — the Fly-hosted
app cannot call it, and pretending otherwise would be fake
wiring. So v1 builds the read seam honestly:

- `src/services/fund/account-visibility.ts` defines
  `AccountVisibilityProvider` — one method, `listAccounts`,
  returning account views shaped the way a Plaid `/accounts`
  response would be normalized (institution, name, mask/last-4,
  balance, lane) plus a `source` tag and an `as_of` date.
- The v1 implementation, `ManualSnapshotAccountVisibility`,
  reads `account_snapshots` — manual snapshots (institution,
  account name, last-4, balance, lane, **as-of date**) entered by
  the owner or by King. A snapshot is real data *as of its date*,
  displayed with that date and a staleness label computed in
  `lib/truck-fund.ts`: **current** (≤7 days), **aging** (≤30),
  **stale** (>30 — "may be out of date," the same honesty the
  Plaid connector itself applies to lagged balances). Nothing
  anywhere calls a snapshot a live balance or a sync.

**What a live build requires (the named follow-up):**

1. His own Plaid developer account (dashboard.plaid.com) —
   production access is an approval Plaid grants, not a signup
   formality.
2. `PLAID_CLIENT_ID` + `PLAID_SECRET` + `PLAID_ENV` as **Fly
   secrets** (placeholders documented in `.env.example`; never
   committed, never in the client bundle — secret is server-only).
3. The Link flow: server creates a `link_token`
   (`/link/token/create`), the app opens Plaid Link, the returned
   `public_token` is exchanged server-side (`/item/public_token/
   exchange`) for an `access_token` stored **server-side only**,
   per company, never sent to the client.
4. Products: **read-only only** — `transactions` and `auth`
   (account/routing verification) plus balance reads via
   `/accounts/balance/get`. The transfer/payment products are
   never requested, keeping §9's law at the credential level,
   not just the UI level.
5. A token-refresh/webhook path (`ITEM_LOGIN_REQUIRED` →
   re-link surface) and a new `plaid_items` table — its own
   migration and design pass when the follow-up is authorized.

### 9.6 Surfaces

- API: `GET /api/v1/truck-fund` (aggregate tab state),
  `PATCH /api/v1/truck-fund/settings`, standard CRUD at
  `/api/v1/fund-entries` and `/api/v1/account-snapshots`,
  `GET /api/v1/business-ladder` + `PATCH
  /api/v1/business-ladder/{step_key}` (state upsert).
- UI: Money → **Truck Fund** (`/money/truck-fund`), linked from
  the Money index: Truck Fund progress + target picker, the
  suggestion card with one-tap **Record it**, earned-this-week /
  this-month, the two context buckets, account snapshots with
  as-of labels, the ladder, and the fund log with an add-entry
  form (fund, kind, dollars, date, lane, note).

## Out of scope for this pass

Certified ELD anything; the bot joining or reading any group; a
userbot / logged-in-as-the-owner client (a separate, riskier design
needing its own pass); per-load P&L; role-typed contacts; load
detail/edit screens; any Plaid or research-engine work.
