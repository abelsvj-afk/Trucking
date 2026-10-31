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

## Truck Fund (Wave D — `docs/design/driver-mvp.md` §9)

The app never moves money (§9's law): every endpoint below reads, computes, or *records* a move the owner made himself in his bank's app.

**`GET /api/v1/truck-fund`** — computed aggregate for the Money → Truck Fund tab, not backed by a single table. Response `200`:

```json
{
  "funds": {
    "truck_fund": { "balance_cents": 125000, "last_entry_date": "2026-10-30" },
    "business_credit": { "balance_cents": 0, "last_entry_date": null },
    "emergency_fund": { "balance_cents": 320000, "last_entry_date": "2026-10-12" }
  },
  "truck_fund_progress": {
    "balance_cents": 125000,
    "band": "mid",
    "band_low_cents": 4000000,
    "band_high_cents": 7500000,
    "target_cents": 7500000,
    "percent_of_target": 1.7,
    "remaining_cents": 7375000,
    "position": "below_band"
  },
  "settings": { "sweep_mode": "off", "sweep_percent": null, "sweep_flat_cents": null, "target_band": null, "target_cents": null },
  "periods": {
    "week": { "from": "2026-10-26", "to": "2026-11-01", "settled_income_cents": 210000, "costs_cents": 146000, "settled_net_cents": 64000 },
    "month": { "from": "2026-10-01", "to": "2026-10-31", "settled_income_cents": 0, "costs_cents": 0, "settled_net_cents": 0 }
  },
  "suggestion": null,
  "entries": [],
  "ladder": [],
  "accounts": []
}
```

- Fund balances are ledger sums (`fund_entries`: deposits − withdrawals, non-deleted). `position` is `below_band` | `in_band` | `past_band` against the chosen band (null band → progress is computed against `target_cents` alone, `position: null`).
- `periods` use the §9.3 definitions: settled income = `completed` loads only (placed by `delivery_date`, falling back to `pickup_date`); costs = the period's expenses + fuel + maintenance; week is Mon–Sun UTC, matching the financial summary's UTC convention. Earned figures are **never** a fund balance.
- `suggestion` is `null` unless a sweep rule exists, the week's settled net is positive, and rule(net) exceeds sweep entries already recorded this week. When present: `{ "amount_cents": 32000, "period": "week", "text": "$640.00 settled this week. Your rule sends $320.00 to the Truck Fund." }`.
- `ladder` is the §9.4 view: the six canonical steps in order, each `{ step_key, title, what_it_is, next_action, state, note, unlocked, out_of_order }` — knowledge static in code, state from `business_ladder_steps` (absent row = `not_started`).
- `accounts` comes through the §9.5 account-visibility seam (v1: manual snapshots): each `{ id, institution, account_name, last4, balance_cents, lane, as_of_date, source: "manual_snapshot", staleness: { level, age_days, label } }`.

**`PATCH /api/v1/truck-fund/settings`** — upserts the `fund_settings` singleton. Body: `{ sweep_mode, sweep_percent?, sweep_flat_cents?, target_band?, target_cents? }` — `sweep_percent` (1–100) is required when `sweep_mode` is `percent`, `sweep_flat_cents` (> 0) when `flat`. Returns the stored settings.

**`fund-entries`** — standard 5 routes (see the generic resource contract) over `fund_entries`; list accepts `?fund_key=` as an exact-match filter.

**`account-snapshots`** — standard 5 routes over `account_snapshots`.

**`GET /api/v1/business-ladder`** — just the `ladder` array from the aggregate above. **`PATCH /api/v1/business-ladder/{step_key}`** — upserts one step's state: body `{ state, note? }`; `step_key` must be one of the six canonical keys (404 otherwise).

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
| POST | `/api/v1/smart-path/route-check` | Authenticated owner session. Body: `{ load_id: uuid, depart_at: ISO timestamp, pickup_window?: { start, end }, delivery_window?: { start, end }, food_mode?: "grocery" \| "fast_food" (default "grocery"), gallons_to_buy?: number }`. Returns `200` with `{ load, route: { provider, truckLegal: false, distanceMiles, providerDurationMinutes, geometry, originPoint, destinationPoint }, verdict: { status: on_time \| early \| late \| not_legal, assumedDriveMinutes, driveTimeBasis, legalLines, restedLines, paidLines, tradeoffLines, makeItDepartureAt }, plan: { arrivalAt, totalElapsedMinutes, breaks, rests } \| null, fuel: { assumptions, candidates (ranked by effective cost), unavailableReason }, food: { mode, groceryPlan, stops, suppressedByFast, lines, unavailableReason }, warnings }`. `truckLegal` is literally `false` in v1 — geometry is OSRM's car profile (design §8.1). Errors: `400 GEOCODE_MISS` (a load origin/destination couldn't be found on the map — the message says which), `502 ROUTING_UNAVAILABLE` / `GEOCODING_UNAVAILABLE` (provider down; no distance is estimated instead), `404` for another tenant's load (RLS). Food stops whose arrival falls inside the owner's 8pm–8am Eastern fast are suppressed and named in `suppressedByFast`. |

`trucks` create/update bodies additionally accept the Smart Path profile fields from `docs/schemas.md` (`height_in`, `length_in`, `weight_lbs`, `governed_speed_mph`, `tank_capacity_gallons`, `avg_mpg`, `appliances`, `appliance_notes`) — all optional; the Fleet → Truck profile page is the editor.

### Telegram webhook (Driver MVP, `docs/design/driver-mvp.md` §4)

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/telegram/webhook` | Telegram Bot API webhook for the owner's **private** bot. No user session exists for this caller (listed public in `src/proxy.ts`, like `/api/internal`); the route enforces its own checks, in order: `TELEGRAM_BOT_TOKEN` unset → `503` (disabled); `TELEGRAM_WEBHOOK_SECRET` set → the `x-telegram-bot-api-secret-token` header must match, else `401`; non-private chats → ignored; chat id ≠ `TELEGRAM_ALLOWED_CHAT_ID` → ignored; allowlist unset → bootstrap mode, replies with only that chat's id and runs no AI. Allowlisted private text runs through the same dispatch-helper service as `/api/v1/dispatch-suggest` and the reply is sent back in that same private chat only. The bot never joins, reads, or sends to any group and never messages any third party. Accepted updates return `200 { ok: true }` even when deliberately ignored, so Telegram doesn't retry-storm. Note: this surface has no session, so it cannot check the in-app kill switches — its revocation is its own env surface (unset the token/allowlist), a deliberate boundary recorded in the design. **Bot intelligence (design §6):** the same webhook also carries plain conversation — every turn's prompt is assembled in code with persisted history (`telegram_messages`), a live company snapshot, the owner's standing instructions, and retrieved memories (`bot_memories`, both standard resources in `docs/schemas.md` written via the bot's documented service-role path, not through this API). Routing and capture rules are design §6, not API surface. |

---

*Exact UI screens consuming this API are Phase 7 (`docs/design/ui-ux.md`). This document is the boundary between frontend and backend — both must conform to it once implementation starts.*
