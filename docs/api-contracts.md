# API Contracts

Phase 6 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`, covering the REST API described in `docs/architecture.md`, over the entities defined in `docs/schemas.md`. This is a contract: code conforms to it, not the reverse. Breaking changes require updating this document first.

## Conventions

- **Base path:** `/api/v1/...`. The `v1` prefix costs nothing to add now and avoids a painful breaking change later once this becomes a paid product used by more than one company — same reasoning as the `company_id` decision in `docs/architecture.md`.
- **Auth:** every route requires a valid Supabase session (cookie-based), with exactly one documented exception: `GET /api/v1/health` (see below), which exists specifically so deployment/monitoring health probes can reach it. Every other route has no exemption — unauthenticated requests get `401` before any handler logic runs, per the middleware requirement in `CLAUDE.md`.
- **Format:** JSON in, JSON out. `Content-Type: application/json`.
- **IDs:** UUIDs, as strings.
- **Money:** integers, in cents, over the wire — matches storage in `docs/schemas.md`. The frontend formats for display; the API never sends or accepts floating-point currency.
- **Timestamps:** ISO 8601 strings.
- **Soft delete:** `DELETE` sets `deleted_at` server-side (see `docs/schemas.md`); it never removes a row. List endpoints exclude deleted records by default.

### Standard list response

```json
{
  "data": [ /* array of resource objects */ ],
  "page": { "limit": 50, "offset": 0, "total": 123 }
}
```

### Standard error response

Per `CLAUDE.md`'s "centralized error handling that never leaks stack traces, internal paths, or credentials":

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "rate_cents must be a non-negative integer"
  }
}
```

Standard HTTP status codes: `400` invalid input, `401` not authenticated, `403` authenticated but not permitted by role (reserved for once more than one role exists, per `docs/governance.md` — not used for tenant isolation), `404` not found, soft-deleted, **or belonging to another company** (see `docs/service-specs.md`'s `services/db` spec — a cross-tenant row is always indistinguishable from a missing one, never revealed via `403`), `409` conflict, `500` unexpected server error (message is always generic — never the raw exception).

### Validation

Every write (`POST`/`PATCH`) is validated against the corresponding schema in `docs/schemas.md` before touching the database — reject invalid input with `400`, never silently coerce or drop bad fields, per `CLAUDE.md`.

## Resource endpoints

Every MVP entity in `docs/schemas.md` gets the same five endpoints, scoped automatically to the caller's `company_id` (never accepted as a request parameter — always derived from the authenticated session):

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/{resource}` | List, paginated, excludes soft-deleted rows |
| GET | `/api/v1/{resource}/{id}` | Get one; `404` if missing or soft-deleted |
| POST | `/api/v1/{resource}` | Create |
| PATCH | `/api/v1/{resource}/{id}` | Partial update |
| DELETE | `/api/v1/{resource}/{id}` | Soft delete |

`{resource}` is one of: `trucks`, `trailers`, `drivers`, `customers`, `brokers`, `loads`, `expenses`, `fuel-purchases`, `maintenance-events`, `maintenance-schedules`, `equipment-checklist-items`, `pretrip-inspections`. **Not `documents`** — it has its own contract (see "Documents" below) because it doesn't fit this shape: creation is `multipart/form-data` not JSON, there's no `PATCH` (documents aren't edited in place, per `docs/schemas.md`), and `DELETE` removes the row and file outright rather than soft-deleting. Applying this generic table to `documents` too would describe two incompatible APIs for the same resource.

### Worked example — `trucks`

**`POST /api/v1/trucks`**

Request:
```json
{
  "unit_number": "Truck #1",
  "vin": "1FUJGHDV8CLBP1234",
  "make": "Freightliner",
  "model": "Cascadia",
  "year": 2019,
  "status": "active",
  "current_mileage": 487321
}
```

Response `201`:
```json
{
  "id": "b3f1...",
  "company_id": "a1c2...",
  "unit_number": "Truck #1",
  "vin": "1FUJGHDV8CLBP1234",
  "make": "Freightliner",
  "model": "Cascadia",
  "year": 2019,
  "status": "active",
  "current_mileage": 487321,
  "created_at": "2026-08-20T12:00:00Z",
  "updated_at": "2026-08-20T12:00:00Z",
  "deleted_at": null
}
```

**`GET /api/v1/trucks`** → standard list response, `data` containing objects shaped as above.

**`PATCH /api/v1/trucks/{id}`** — request body is any subset of the writable fields (`company_id`, `id`, `created_at`, `updated_at`, `deleted_at` are never client-writable); response is the full updated object.

**`DELETE /api/v1/trucks/{id}`** → `204 No Content`, sets `deleted_at`.

Every other resource in the table above follows this exact shape, substituting its own fields from `docs/schemas.md`. They aren't spelled out individually here to keep this document proportionate — the pattern is fixed, only the field list changes per resource.

### `loads` — one addition

`loads` supports filtering the list endpoint by `status` (`GET /api/v1/loads?status=confirmed`), since `docs/schemas.md`'s `draft` status exists specifically so incomplete loads don't pollute financial calculations — the frontend needs to be able to separate them out.

### `maintenance-schedules`, `equipment-checklist-items`, `pretrip-inspections` — one addition each

All three support filtering the list endpoint by `truck_id` and by `trailer_id` (e.g. `GET /api/v1/maintenance-schedules?truck_id=...`), matching `maintenance-events`' existing `?truck_id=` filter — needed so a truck or trailer's own screen can show just its items. `maintenance-schedules`' response fields are exactly `docs/schemas.md`'s stored columns; "next due"/"overdue" are computed client-side from `interval_miles`/`interval_days`/`last_done_*` plus the linked truck's `current_mileage`, not returned by the API — see `src/lib/maintenance-schedule.ts`.

### `duty-logs`, `dispatch-exchanges` — Driver MVP additions

Both are standard resources (the 5-endpoint table above) with the fields in `docs/schemas.md`, added per `docs/design/driver-mvp.md` §§3/5. `duty-logs` rows are duty-status starts (warn-only HOS summaries are computed client-side in `src/lib/hos.ts`, never returned by the API — same pattern as `maintenance-schedules`' due status). `dispatch-exchanges` is written by the client only on the owner's explicit save, or by the owner's private Telegram bot (see the webhook contract below) — never automatically by `/api/v1/dispatch-suggest`.

## Financial summary (read-only, computed)

**`GET /api/v1/financial-summary?from={date}&to={date}`**

Not backed by a table (see `docs/schemas.md`). Computes revenue from `confirmed`/`completed` loads and total expenses (`expenses` + `fuel_purchases` + `maintenance_events`) within the given date range.

A load is placed within the range by its `delivery_date` (when the freight actually moved), falling back to `pickup_date` if `delivery_date` isn't set yet. A `confirmed`/`completed` load with neither date set has no date to place it at and is excluded from every date-scoped query — an edge case `docs/schemas.md`'s nullable `pickup_date`/`delivery_date` allows in principle, but one a load would realistically not still be in by the time it's confirmed.

Response `200`:
```json
{
  "range": { "from": "2026-08-01", "to": "2026-08-31" },
  "revenue_cents": 1240000,
  "expenses_cents": 812000,
  "fuel_cents": 310000,
  "maintenance_cents": 95000,
  "net_cents": 23000
}
```

If `from`/`to` are omitted, defaults to the current calendar month.

## Health check

**`GET /api/v1/health`** — no auth required. Per the diagnostics requirement in `CLAUDE.md`, kept separate from business endpoints.

```json
{ "status": "ok" }
```

## Documents (file upload)

Documents differ from the other resources — creating one involves a file, not just JSON:

**`POST /api/v1/documents`** — `multipart/form-data`: the file, plus `related_entity_type`, `related_entity_id`, `file_name`. The server uploads to Supabase Storage and creates the corresponding row from `docs/schemas.md`.

**`GET /api/v1/documents?related_entity_type={type}&related_entity_id={id}`** — list response, `data` containing document metadata plus a short-lived signed URL for downloading the file.

**`DELETE /api/v1/documents/{id}`** — per `docs/schemas.md`, documents don't soft-delete like other resources; this removes the row and the underlying file.

## AI and integration endpoints

The general rule still holds: an AI capability gets its own contract added here when it's actually designed, never bolted onto an existing resource endpoint. One now exists, per `docs/automation.md`'s Phase 10 pass:

### `industry_briefings` (read-only from the client — nothing here is user-writable)

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/industry-briefings` | List, excludes dismissed, matches `docs/schemas.md`. Response also carries `service_status: { consecutive_failures: number, escalated: boolean, last_run_at: string \| null }`, computed from `industry_briefing_runs` — the escalation surface `docs/automation.md`'s Human escalation section requires ("several consecutive failures... surfaced to the owner rather than failing silently forever") |
| POST | `/api/v1/industry-briefings/{id}/dismiss` | Sets `dismissed_at`; the "delete" analog for this resource |

There is no `POST /api/v1/industry-briefings` — the client never creates one directly. Rows are only ever written by the scheduled job described in `docs/automation.md`, using its own scoped service credential, not a user session. Every other AI-recommendation endpoint (decision engine, fuel intelligence, etc.) gets specified the same way, when it's actually designed.

### AI settings (the kill switches from `docs/governance.md`)

Read/write from a normal authenticated owner session — this is the one thing about AI capabilities the client *does* write directly, since flipping a switch is the owner's own action, not something the AI recommends.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/ai-settings` | Returns `{ globally_disabled: boolean, capabilities: { [name]: boolean } }` — the global switch plus every known capability's current on/off state (missing capability = `false`, per `docs/schemas.md`'s fail-closed default) |
| PATCH | `/api/v1/ai-settings` | Body is any subset of `{ globally_disabled, capabilities: { [name]: boolean } }`; upserts the changed rows. Takes effect for the *next* scheduled run only, per `docs/governance.md` — never interrupts a run already in progress |

Both fields for one capability's kill switch — `globally_disabled` and `capabilities.industry_intelligence`, for example — are independent per `docs/governance.md`'s "no cooperation required" and "turning one off must never require touching... any other capability" rules; the scheduler checks both before every run, in that order.

### `dispatch-suggest` (Driver MVP, `docs/design/driver-mvp.md` §2)

The `dispatch_helper` capability — the second entry in `KNOWN_CAPABILITIES`, kill-switched exactly like `industry_intelligence` (global first, then per-capability; no row = off).

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/v1/dispatch-suggest` | Authenticated owner session. Body: `{ message: string (1-8000 chars), context?: string }` — a pasted dispatch message (Spanish or English) plus optional context. Stateless: stores nothing. Returns `200` with `{ translation_en, whats_being_asked, likely_sender_role: owner \| dispatcher \| broker \| shipper \| receiver \| unknown, sender_reasoning, suggested_reply_en, suggested_reply_es }`. Returns `403 AI_CAPABILITY_DISABLED` when the global switch is on or the capability is off. The pasted message is untrusted third-party text, treated as data to translate — never as instructions. The endpoint drafts replies; it never sends anything. |

### `smart-path` route check (Smart Path v1, `docs/design/driver-mvp.md` §8)

A computed endpoint, not a resource — nothing is stored; the check is recomputed from current records on every call. The verdict is deterministic computation (`src/lib/smart-path.ts`), **not** an AI capability: no provider call, no kill switch. External data (routing/geocoding/places) comes from keyless providers behind interfaces in `src/services/integrations/` and is treated as untrusted input; a provider failure returns an honest error or an `unavailableReason` on that section — never an estimated figure.

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/v1/smart-path/route-check` | Authenticated owner session. Body: `{ load_id: uuid, depart_at: ISO timestamp, pickup_window?: { start, end }, delivery_window?: { start, end }, food_mode?: "grocery" \| "fast_food" (default "grocery"), gallons_to_buy?: number }`. Returns `200` with `{ load, route: { provider, truckLegal, distanceMiles, providerDurationMinutes, geometry, originPoint, destinationPoint }, verdict: { status: on_time \| early \| late \| not_legal, assumedDriveMinutes, driveTimeBasis, legalLines, restedLines, paidLines, tradeoffLines, makeItDepartureAt }, plan: { arrivalAt, totalElapsedMinutes, breaks, rests } \| null, fuel: { assumptions, candidates (ranked by effective cost), unavailableReason }, food: { mode, groceryPlan, stops, suppressedByFast, lines, unavailableReason }, warnings }`. `truckLegal` (design §8.5) is `true` only when a truck-aware engine served the route — OpenRouteService `driving-hgv` (primary, when `ORS_API_KEY` is set) or Valhalla truck costing (keyless fallback) — with the load's truck dimensions passed in; it is `false` when the chain fell back to OSRM's car profile, in which case the v1 car-route warning returns verbatim in `warnings`. Provider skips/fallbacks are noted in `warnings`; `route.provider` names the engine that actually answered. Even `true` means checked against the restrictions recorded in OpenStreetMap data — coverage is incomplete, not a guarantee. Errors: `400 GEOCODE_MISS` (a load origin/destination couldn't be found on the map — the message says which), `502 ROUTING_UNAVAILABLE` / `GEOCODING_UNAVAILABLE` (provider down; no distance is estimated instead), `404` for another tenant's load (RLS). Food stops whose arrival falls inside the owner's 8pm–8am Eastern fast are suppressed and named in `suppressedByFast`. |

`trucks` create/update bodies additionally accept the Smart Path profile fields from `docs/schemas.md` (`height_in`, `length_in`, `weight_lbs`, `governed_speed_mph`, `tank_capacity_gallons`, `avg_mpg`, `appliances`, `appliance_notes`) — all optional; the Fleet → Truck profile page is the editor.

### `assistant/chat` (Bot intelligence v2, `docs/design/driver-mvp.md` §8)

The web chat window onto the **same bot brain** as the Telegram bot — same store (`src/services/bot/store.ts`, channel `web`), same shared `telegram_messages` timeline, same `bot_memories`, same snapshot and standing instructions, same agent loop. Conversational turns are governed by the `bot_chat` capability (global switch first, then per-capability, no row = off); with it off the reply itself says chat is turned off (the endpoint still returns `200` — the "reply" is the product surface here, unlike `dispatch-suggest`'s `403`). Messages that route to dispatch help additionally honor the `dispatch_helper` capability; with that off they fall through to the assistant instead of erroring.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/assistant/chat` | Authenticated owner session. Returns `200` with `{ data: [{ role: "user" \| "assistant", text }] , pending_summary: string \| null }` — the recent shared conversation timeline across BOTH channels (oldest first) plus the summary of any bot-proposed write still awaiting his yes. When a **dump batch** is pending (design §9), `pending_summary` is the consolidated numbered batch list instead of a single summary — the Assistant page's existing banner renders it unchanged. |
| POST | `/api/v1/assistant/chat` | Authenticated owner session. Body: `{ message: string (1-8000 chars) }`. Routes exactly like the Telegram bot: `remember:`/`instruction:` capture writes a `bot_memories` row with no AI call; a pending proposal + a plain yes/no resolves it in code (execute or drop — proposals expire after 2 hours); dispatch-style messages get the dispatch helper when its capability is on; everything else runs the agent loop (tools over his own records; bot-proposed writes are stored in `bot_pending_actions`, never executed without his yes). Both turns are persisted to the shared timeline. Returns `200` with `{ reply: string, pending_summary: string \| null }`. Nothing is ever sent to any third party from this endpoint. |

**Agent omnipresence (design §9)** widens what the loop behind this endpoint (and the Telegram webhook) can do, without changing the endpoint's shape: read tools cover every business entity in `docs/schemas.md` (documents including their `extracted_text` content when the scan migration has landed); write tools cover create/update across the same entities under the §8 standing rule; deletes go through a `delete_record` tool that is **always** staged as a proposal, even when directly ordered. A pasted **dump** (dispatch thread, rate con, brain-dump) is extracted by the model into one `stage_dump_items` call; code validates each item (target tool's Zod schema, verbatim `source_quote`, numeric grounding against the message) before storing the accepted items as one numbered batch in `bot_pending_actions` (migration `00021`). Batch replies resolve in code: a plain yes approves all, "approve 1, 3" approves exactly those (the rest stay pending), "drop the rest" clears the remainder, and a correction is applied to the stored proposal via `revise_pending_item` and still needs his yes before anything is recorded. The web surface takes dumps as pasted text only — file upload stays in More → Documents, after which the agent reads the document back through its tools.

### Telegram webhook (Driver MVP, `docs/design/driver-mvp.md` §4)

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/telegram/webhook` | Telegram Bot API webhook for the owner's **private** bot. No user session exists for this caller (listed public in `src/proxy.ts`, like `/api/internal`); the route enforces its own checks, in order: `TELEGRAM_BOT_TOKEN` unset → `503` (disabled); `TELEGRAM_WEBHOOK_SECRET` set → the `x-telegram-bot-api-secret-token` header must match, else `401`; non-private chats → ignored; chat id ≠ `TELEGRAM_ALLOWED_CHAT_ID` → ignored; allowlist unset → bootstrap mode, replies with only that chat's id and runs no AI. Allowlisted private text runs through the same dispatch-helper service as `/api/v1/dispatch-suggest` and the reply is sent back in that same private chat only. The bot never joins, reads, or sends to any group and never messages any third party. Accepted updates return `200 { ok: true }` even when deliberately ignored, so Telegram doesn't retry-storm. Note: this surface has no session, so it cannot check the in-app kill switches — its revocation is its own env surface (unset the token/allowlist), a deliberate boundary recorded in the design. **Bot intelligence (design §6):** the same webhook also carries plain conversation — every turn's prompt is assembled in code with persisted history (`telegram_messages`), a live company snapshot, the owner's standing instructions, and retrieved memories (`bot_memories`, both standard resources in `docs/schemas.md` written via the bot's documented service-role path, not through this API). Routing and capture rules are design §6, not API surface. |

---

*Exact UI screens consuming this API are Phase 7 (`docs/design/ui-ux.md`). This document is the boundary between frontend and backend — both must conform to it once implementation starts.*
