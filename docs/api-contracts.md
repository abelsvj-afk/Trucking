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

**Reliability Unit A additions** (full contract: `docs/record-lifecycle.md`): a `PATCH` additionally validates the MERGED record (existing row + patch) against the create schema — a well-formed patch that would produce an invalid record is refused `422` with field-level errors in `error.fields`, and the database is untouched. `POST` accepts an optional `submission_id` (UUID) for idempotent creates: same token + same validated payload replays the original create (`200`, `deduplicated: true`); same token + different payload is `409` (`submission_token_reused_with_different_payload`).

## Resource endpoints

Every MVP entity in `docs/schemas.md` gets the same five endpoints, scoped automatically to the caller's `company_id` (never accepted as a request parameter — always derived from the authenticated session):

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/{resource}` | List, paginated, excludes soft-deleted rows; `?deleted=only` lists ONLY soft-deleted rows (the Deleted view) |
| GET | `/api/v1/{resource}/{id}` | Get one; `404` if missing or soft-deleted |
| POST | `/api/v1/{resource}` | Create (idempotent with `submission_id` — see Validation) |
| PATCH | `/api/v1/{resource}/{id}` | Partial update; the merged record is validated (`422` on failure) |
| DELETE | `/api/v1/{resource}/{id}` | Soft delete; `204` only when a row was actually deleted, else `404` |
| POST | `/api/v1/{resource}/{id}/restore` | Restore a soft-deleted record behind safeguard checks (create-schema validity, live FK parents); refusals are `422` naming the reason |

`{resource}` is one of: `trucks`, `trailers`, `drivers`, `customers`, `brokers`, `loads`, `expenses`, `fuel-purchases`, `maintenance-events`, `maintenance-schedules`, `equipment-checklist-items`, `pretrip-inspections`. **Not `documents`** — it has its own contract (see "Documents" below) because it doesn't fit this shape: creation is `multipart/form-data` not JSON, there's no `PATCH` (documents aren't edited in place, per `docs/schemas.md`), and `DELETE` is a retention delete (tombstone + retained file) rather than the generic soft delete. Applying this generic table to `documents` too would describe two incompatible APIs for the same resource.

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

Both are standard resources (the 5-endpoint table above) with the fields in `docs/schemas.md`, added per `docs/design/driver-mvp.md` §§3/5. `duty-logs` rows are duty-status starts. (Reliability Unit B update: the HOS *cycle* summary is now computed server-side and returned by the dedicated window endpoint below, from the carrier-anchored engine in `src/lib/hos-cycle.ts`; the short-term figures — 14-hour window, 11-hour driving, 30-minute break — are still computed client-side in `src/lib/hos.ts`, fed from the same window rows. The pre-Unit-B arrangement — summary computed from the capped, newest-first list response — is gone; see `docs/time-and-hos.md`.) `dispatch-exchanges` is written by the client only on the owner's explicit save, or by the owner's private Telegram bot (see the webhook contract below) — never automatically by `/api/v1/dispatch-suggest`.

### Paycheck picture — `GET /api/v1/pay-summary`

Read-only (owner order 2026-11-05, items 3–4). Returns `{ "data": PaySummary }`: `hasTerms`; `active` (the pick-active-load load with its expected pay line, `overdue`, and `hosCost` — the load's hours cost from the one HOS read); `completed` (completed loads, newest delivery first, each with a `line`: expected range priced by the pay-terms row in force on the delivery date, `receivedCents` from `load_pay` settlement lines, `status` paid / short / over / unpaid / unknown, `shortfallCents`); `weeks` (the same finished loads grouped by pay week with statement/payday dates, expected vs received — and, since migration 00079, each week's `advancesCents` and its net range `netLowCents`/`netHighCents` = expected − advances; a week with advances but no finished loads still appears); `paydays` (the pay weeks regrouped by PAYDAY, newest first, with per-load detail kept underneath: `expectedLow/HighCents`, `advancesCents`, `netLow/HighCents`, `receivedCents`, `stillOwedLow/HighCents` = net − received (≤ 0 means nothing more owed), `overdue`, `loads` — the one builder the Paychecks page and Abel's `paychecks_by_payday` both read); `totals` (unpaid count + expected low/high cents, short count + shortfall cents, `advancesCents`, and the unpaid net range `unpaidNetLowCents`/`unpaidNetHighCents`); `hos` (drive/window/break/cycle remaining, ms); `asOf`. If any input query fails — loads, pay terms, settlement lines or cash advances — the route returns an error rather than a figure computed from part of its inputs (advances used to degrade silently to none; fixed). Gross at his stated rate; his settlement is the final number. Planning only — not an ELD.

### `cash-advances` (migration 00079)

Standard resource (the 5-endpoint table above) with the fields in `docs/schemas.md`: money a worker took out of a pay period before payday, recorded when taken. `POST {amount_cents (int > 0), advance_date, driver_id?, note?}`. The netting math is in `src/lib/cash-advances.ts`; the design is `docs/design/employer-pay-profile.md` section 9.

### HOS window + carrier settings — Reliability Unit B additions

**`GET /api/v1/duty-logs/window`** — every non-deleted duty log in the HOS calculation window (from the carrier-anchored period `cycle periods + 2` before the current period through now), ordered by `started_at` ascending, plus the server-computed cycle summary and the window actually used:

```json
{
  "data": [ "…duty_logs rows, started_at ascending…" ],
  "hos": {
    "cycle": "70/8",
    "cycleLimitMinutes": 4200,
    "periodAnchor": "00:00",
    "restartEnabled": true,
    "carrierTimeZone": "America/New_York",
    "windowStart": "2026-01-08T05:00:00.000Z",
    "windowEnd": "2026-01-15T20:00:00.000Z",
    "currentPeriodStart": "2026-01-15T05:00:00.000Z",
    "onDutyMinutesInCycle": 3840,
    "restartApplied": null,
    "restartUnverified": false,
    "warnings": []
  }
}
```

`windowStart` is the counted span's start (the oldest counted period); the query itself opens two periods earlier (see `docs/time-and-hos.md`). If the window holds more than 5000 rows the endpoint fails `500 HOS_WINDOW_TOO_LARGE` rather than returning a partial window. `restartApplied: { "endedAt": "…" }` reports an observed, applied 34-hour restart; `restartUnverified: true` reports a qualifying-length interval that was deliberately NOT applied (its start is unobserved) — the total is then the conservative full-window count.

**`GET /api/v1/hos-settings`** — the company's carrier HOS configuration: `{ hos_cycle, hos_period_anchor, hos_restart_enabled, hos_carrier_timezone }`. Before migration `00042` is applied, reads return the labeled provisional defaults (`70/8`, `00:00`, `true`, `America/New_York`).

**`PATCH /api/v1/hos-settings`** — any subset of the same four fields. Values are validated (cycle enum, anchor `HH:MM` pattern, IANA timezone) and refused with `400 VALIDATION_ERROR` carrying field-named `fields[]`; unknown keys are refused. A write before migration `00042` fails `500 HOS_CONFIG_UNAVAILABLE` — never a silent no-save.

## Financial summary (read-only, computed)

**`GET /api/v1/financial-summary?from={date}&to={date}&tz={iana-zone}`**

Not backed by a table (see `docs/schemas.md`). The full money contract — recognition rule, the three measures, the labeling rule, the snapshot guarantee — lives in `docs/money-and-revenue.md`; this section is the wire shape.

Reliability Unit C (design C.2/C.3, ruling D-01): revenue is **operational load revenue recognized on delivery** — a load counts when it is `completed` AND has a `delivery_date`, in the viewer-local month of that date. There is no pickup-date fallback. `draft`/`confirmed` loads are **pipeline** (reported separately, never added to revenue or net); `completed` loads with no `delivery_date` are a named exception; `cancelled` loads are in neither figure. The client always sends the viewer's IANA timezone as `tz` (Unit B, B.2.1); absent/invalid falls back to `America/New_York`, reported in `timeZone`; the period bounds are computed in that zone (Unit C, C1). All figures come from ONE database snapshot taken inside a dedicated repeatable-read transaction (F-033) — if the snapshot cannot be verified, the response is `503 SUMMARY_UNVERIFIED` with no totals, never a partial or blended figure.

Response `200`:
```json
{
  "range": { "from": "2026-08-01", "to": "2026-08-31" },
  "timeZone": "America/New_York",
  "revenueConvention": "recognized_on_delivery",
  "revenue_cents": 1240000,
  "expenses_cents": 812000,
  "fuel_cents": 310000,
  "maintenance_cents": 95000,
  "net_cents": 23000,
  "components": {
    "revenue": { "total_cents": 1240000, "row_count": 7, "record_ids": ["…"] },
    "expenses": { "total_cents": 812000, "row_count": 21, "record_ids": ["…"] },
    "fuel": { "total_cents": 310000, "row_count": 9, "record_ids": ["…"] },
    "maintenance": { "total_cents": 95000, "row_count": 3, "record_ids": ["…"] }
  },
  "pipeline": { "total_cents": 450000, "row_count": 3, "record_ids": ["…"], "loadsWithoutRateCount": 1 },
  "exceptions": {
    "completedMissingDeliveryDate": { "count": 1, "record_ids": ["…"] }
  },
  "measures": {
    "recognizedRevenue": 1240000,
    "periodOperatingResult": 23000,
    "aggregateContributionMargin": 1050000
  }
}
```

`net_cents` is the period operating result under its legacy field name. If `from`/`to` are omitted, the range defaults to the current viewer-local month.

**`GET /api/v1/financial-summary/detail?component={revenue|expenses|fuel|maintenance}&from={date}&to={date}&tz={iana-zone}`**

The rows behind one component total (F-010), read under the same snapshot mechanism and reconciled against the component aggregate inside the transaction; a mismatch is `503 SUMMARY_UNVERIFIED`. Response `200`: `{ component, range, timeZone, total_cents, row_count, rows }` — `rows` are the full records, ordered `(created_at, id)`, and their amounts sum exactly to `total_cents`.

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

## Gaming System (Game Plan — `docs/design/gaming-system.md`)

A plan is a projection, never a promise, and nothing here moves money or executes anything. All generation runs through the governed pipeline (`services/game/run-game-plan.ts`): capability check (`game_plan`, ships OFF) → 4/day re-game cap counted from `game_plan_runs` → snapshot → deterministic engine → STABILIZE validity fence → narration honesty fence. Governance outcomes are returned, never swallowed.

**`GET /api/v1/game-targets`** — the company's targets, newest first: `{ "data": [GameTarget] }`. **`POST /api/v1/game-targets`** — body `{ metric, target_value_cents, target_date?, posture, posture_mix_pct?, notes? }`; deactivates the previous active target, inserts the new active one, and re-games (trigger `target_set`). Returns `201 { target, game }` where `game` is the run outcome (`{ status: "success", plan, material }` | `{ status: "skipped_disabled" }` | `{ status: "skipped_cap" }` | `{ status: "invalid_replaced", plan, violations }` | `{ status: "failure", detail }`) — the target saves even when the game is skipped. **`GET /api/v1/game-targets/{id}`** — one target. **`PATCH /api/v1/game-targets/{id}`** — partial edit; editing the ACTIVE target re-games (trigger `target_edit`), editing history does not; returns `{ target, game }`. **`DELETE /api/v1/game-targets/{id}`** — soft delete (also deactivates).

**`GET /api/v1/game-plan`** — computed aggregate for the More → Game Plan tab (read-only; all math happened at generation time and is frozen on the plan rows):

```json
{
  "capability_enabled": true,
  "target": { "id": "…", "metric": "monthly_net_cents", "target_value_cents": 1000000, "target_date": "2027-06-30", "posture": "conservative", "posture_mix_pct": 0, "notes": null, "is_active": true },
  "current_plan": { "id": "…", "version": 3, "status": "current", "trigger": "settlement", "snapshot": {}, "assumptions": [], "scenarios": {}, "narration": "…", "diff_summary": "Plan v3 (was v2). …", "data_sufficiency": { "completedLoads": 24, "weeksOfHistory": 12, "thinData": false } },
  "versions": [],
  "checkpoints": [],
  "side_income_candidates": [{ "sourceType": "briefing", "sourceId": "…", "label": "…" }],
  "usage": { "re_games_today": 1, "max_re_games_per_day": 4 }
}
```

`side_income_candidates` is read fresh (the §3.4 sources a lever may cite: latest research briefings + his recorded skills). Net-worth targets render partial (business-only) until accounts connect — the label is the UI's, the number is business value + hand-recorded personal snapshots.

**`POST /api/v1/game-plan/regame`** — body `{ trigger?: "manual" }`. Runs the pipeline against the active target. Governance skips return `200 { game }`; no target → `422 no_target`; a narration-fence failure → `422 game_failed` with the reason (the previous plan stands).

**`POST /api/v1/game-plan/what-if`** — body `{ overrides }` (strict schema: engine keys only; side levers must carry their §3.4 citation). Stores a `what_if` version; never touches real data, never replaces the current plan. A rule-breaking what-if returns `200` WITH its violations named in the stored plan's `scenarios.validity`. Same `422` shapes as regame.

**`POST /api/v1/game-plan/promote`** — body `{ plan_id }`. "Make that the plan": the ONLY promotion path. The what-if's frozen game becomes `current` as-is (nothing recomputed); the old current is superseded. Non-what-if or unknown ids → `400` with the reason.

## Health check

**`GET /api/v1/health`** — no auth required. Per the diagnostics requirement in `CLAUDE.md`, kept separate from business endpoints.

```json
{ "status": "ok" }
```

## Documents (file upload)

Documents differ from the other resources — creating one involves a file, not just JSON:

**`POST /api/v1/documents`** — `multipart/form-data`: the file, plus `related_entity_type`, `related_entity_id`, `file_name`. The server uploads to Supabase Storage and creates the corresponding row from `docs/schemas.md`. For image uploads (JPEG/PNG/WebP) it then produces the enhanced scan rendition (design `driver-mvp.md` §10) and, when the `document_extraction` AI capability is enabled, runs text extraction — both inside the same request, and neither can fail the upload: their outcomes land on the returned row as `scan_storage_path` / `extraction_status` (see the row shape below).

**`GET /api/v1/documents?related_entity_type={type}&related_entity_id={id}`** — list response, `data` containing document metadata plus a short-lived signed URL for downloading the file.

**Document row shape (list, search, and POST responses)** — every row carries, beyond the original columns: `scan_storage_path: string | null`, `scan_signed_url: string | null` (short-lived, same TTL as `signed_url`; null when no scan exists), `doc_type: "bol" | "rate_confirmation" | "scale_ticket" | "fuel_receipt" | "settlement" | "other" | null`, `extracted_text: string | null` (the document's full text, raw — the field an agent quotes from), `extracted_fields: Record<string, string | number | null> | null`, `extraction_status: "pending" | "done" | "failed" | "disabled" | "not_applicable"`, `extraction_error: string | null`, `extracted_at: string | null`.

**`GET /api/v1/documents?q={terms}`** — full-text search over every document's `extracted_text` + `file_name` (Postgres `websearch_to_tsquery` semantics), newest first, same row shape as the list. `related_entity_type` + `related_entity_id` may accompany `q` to scope the search to one record; without `q` they remain required together, exactly as before. **This is the agent's document read path**: the bot's document tooling searches with `q`, then answers from the returned rows' `extracted_text`/`extracted_fields` — no separate bot-only endpoint exists.

**`DELETE /api/v1/documents/{id}`** — **Reliability Unit A (F-007/D-05) changed this contract:** deletion is now a RETENTION delete. The row is tombstoned (`deleted_at` + `retention_status: "retained"`) and the underlying files are RETAINED — the endpoint never removes files; `204` only when a row was actually tombstoned, else `404`. The default list and search exclude tombstones; `GET /api/v1/documents?...&deleted=only` returns tombstones with retention status and no signed URLs. **`POST /api/v1/documents/{id}/restore`** clears the tombstone (refused `422` while the record the document is filed against is itself deleted). **`GET /api/v1/documents/cleanup-incidents`** lists open cleanup incidents (storage objects whose compensating removal failed) and **`POST /api/v1/documents/cleanup-incidents/{id}/retry`** retries the removal, closing the incident as `resolved` or `object_absent`. Full contract: `docs/record-lifecycle.md`.

## AI and integration endpoints

The general rule still holds: an AI capability gets its own contract added here when it's actually designed, never bolted onto an existing resource endpoint. One now exists, per `docs/automation.md`'s Phase 10 pass:

### `industry_briefings` (read-only from the client — nothing here is user-writable)

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/industry-briefings` | List, excludes dismissed, matches `docs/schemas.md`. Response also carries `service_status: { consecutive_failures: number, escalated: boolean, last_run_at: string \| null }`, computed from `industry_briefing_runs` — the escalation surface `docs/automation.md`'s Human escalation section requires ("several consecutive failures... surfaced to the owner rather than failing silently forever") |
| POST | `/api/v1/industry-briefings/{id}/dismiss` | Sets `dismissed_at`; the "delete" analog for this resource |

There is no `POST /api/v1/industry-briefings` — the client never creates one directly. Rows are only ever written by the scheduled job described in `docs/automation.md`, using its own scoped service credential, not a user session. Every other AI-recommendation endpoint (decision engine, fuel intelligence, etc.) gets specified the same way, when it's actually designed.

### `research_briefings` + the Deep Research Engine (Stage 8, `docs/design/research-engine.md`)

The `deep_research` capability — the third entry in `KNOWN_CAPABILITIES`, kill-switched exactly like the others (global first, then per-capability; no row = off) and additionally bounded by hard run caps (`RESEARCH_MAX_RUNS_PER_DAY` / `RESEARCH_MAX_RUNS_PER_MONTH`, enforced from `research_runs` counts).

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/research-briefings` | The Research page's one read: `{ data: ResearchBriefing[] }` (excludes dismissed, newest first), `unread_count` (not dismissed, `read_at` null), `runs` (the 10 most recent `research_runs`, all statuses — the run log, caps/skips included), `watchers` (every `research_watcher_state` row — watcher health, failures visible), and `usage: { runs_today, runs_this_month, max_runs_per_day, max_runs_per_month }` (rolling 24h/30d counted statuses: queued/running/success/failure/insufficient_data), `signals` (the banner's Watching signals — unconsumed `research_signals` for the company, newest first; `[]` when the read fails), and `engine_enabled: boolean` (the fail-closed `deep_research` capability state the banner uses) |
| POST | `/api/v1/research-briefings/{id}/read` | Sets `read_at`; `404` when the briefing isn't the caller's (RLS makes cross-tenant indistinguishable from missing) |
| POST | `/api/v1/research-briefings/{id}/dismiss` | Sets `dismissed_at`; the "delete" analog for this resource |
| POST | `/api/v1/research-briefings/research-now` | Body: `{ topic: string (3-200 chars) }`. The owner's manual trigger and the ONLY client-side insert into the engine's tables: queues a `research_runs` row (`trigger_kind='manual'`, `status='queued'` — the exact shape migration `00019`'s RLS policy fences this insert to), returns `201` with the queued run. It never calls the AI provider itself; the engine's scheduler tick executes queued runs under the same caps and kill switch (a queued run whose capability is off is closed out as `skipped_disabled`) |
| GET | `/api/v1/research-briefings/{id}` | One briefing by id (Home News Banner deep-link fallback): returns the briefing INCLUDING dismissed ones through the owner's session; `404` when missing or another company's (RLS makes them indistinguishable) |
| POST | `/api/v1/research-briefings/check-wires` | The banner's light pull: polls every watcher once (free sources only, no AI call, no run-cap spend). Refuses plainly when `deep_research` is off; 30-minute cooldown from the newest watcher poll; takes the research tick's advisory lock non-blocking (a tick mid-run answers busy, never a double poll). Every outcome is an honest state in the body, including `unavailable` (HTTP 200) when the job database URL is unset. Response: `CheckWiresResult` |

Briefings themselves are never client-created: rows are written only by the engine (watchers → triggers → runner, `docs/design/research-engine.md`), running under the Stage-4 scoped job credential extended to the research tables by migration `00019`.

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
| POST | `/api/v1/smart-path/route-check` | Authenticated owner session. Body: `{ load_id: uuid, depart_at: ISO timestamp, pickup_window?: { start, end }, delivery_window?: { start, end }, food_mode?: "grocery" \| "fast_food" (default "grocery"), gallons_to_buy?: number }`. Returns `200` with `{ load, route: { provider, truckLegal, distanceMiles, providerDurationMinutes, geometry, originPoint, destinationPoint }, verdict: { status: on_time \| early \| late \| not_legal, assumedDriveMinutes, driveTimeBasis, legalLines, restedLines, paidLines, tradeoffLines, makeItDepartureAt }, plan: { arrivalAt, totalElapsedMinutes, breaks, rests } \| null, fuel: { assumptions, candidates (ranked by effective cost), unavailableReason }, food: { mode, groceryPlan, stops, suppressedByFast, lines, unavailableReason }, warnings }`. `truckLegal` (design §8.5) is `true` only when a truck-aware engine served the route — OpenRouteService `driving-hgv` (primary, when `ORS_API_KEY` is set) or Valhalla truck costing (keyless fallback) — with the load's truck dimensions passed in; it is `false` when the chain fell back to OSRM's car profile, in which case the v1 car-route warning returns verbatim in `warnings`. Provider skips/fallbacks are noted in `warnings`; `route.provider` names the engine that actually answered. Even `true` means checked against the restrictions recorded in OpenStreetMap data — coverage is incomplete, not a guarantee. Errors: `400 GEOCODE_MISS` (a load origin/destination couldn't be found on the map — the message says which), `502 ROUTING_UNAVAILABLE` / `GEOCODING_UNAVAILABLE` (provider down; no distance is estimated instead), `404` for another tenant's load (RLS). Food stops whose arrival falls inside the owner's 8pm–8am Eastern fast are suppressed and named in `suppressedByFast`. **Drive Mode D1 (additive, optional fields):** `route.maneuvers?` and `deadhead.maneuvers?` carry normalized turn-by-turn maneuvers `[{ instruction, distanceMiles, atFraction }]` when the serving engine returns them (Valhalla's verbal instruction fields preferred; OpenRouteService requested with `instructions: true`; OSRM with `steps=true`) — an engine without steps omits the field rather than fabricating one. `clocks?` carries the duty-clock state the simulation projected from (`ClockState`), the basis for Drive Mode's projected HOS warnings — planning-grade, labeled as such; the ELD remains the legal record. |

`trucks` create/update bodies additionally accept the Smart Path profile fields from `docs/schemas.md` (`height_in`, `length_in`, `weight_lbs`, `governed_speed_mph`, `tank_capacity_gallons`, `avg_mpg`, `appliances`, `appliance_notes`) — all optional; the Fleet → Truck profile page is the editor.

### `assistant/chat` (Bot intelligence v2, `docs/design/driver-mvp.md` §8)

The web chat window onto the **same bot brain** as the Telegram bot — same store (`src/services/bot/store.ts`, channel `web`), same shared `telegram_messages` timeline, same `bot_memories`, same snapshot and standing instructions, same agent loop. Conversational turns are governed by the `bot_chat` capability (global switch first, then per-capability, no row = off); with it off the reply itself says chat is turned off (the endpoint still returns `200` — the "reply" is the product surface here, unlike `dispatch-suggest`'s `403`). Messages that route to dispatch help additionally honor the `dispatch_helper` capability; with that off they fall through to the assistant instead of erroring.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/assistant/chat` | Authenticated owner session. Returns `200` with `{ data: [{ role: "user" \| "assistant", text }] , pending_summary: string \| null }` — the recent shared conversation timeline across BOTH channels (oldest first) plus the summary of any bot-proposed write still awaiting his yes. When a **dump batch** is pending (design §9), `pending_summary` is the consolidated numbered batch list instead of a single summary — the Assistant page's existing banner renders it unchanged. |
| POST | `/api/v1/assistant/chat` | Authenticated owner session. Body: `{ message: string (1-8000 chars) }`. Routes exactly like the Telegram bot: `remember:`/`instruction:` capture writes a `bot_memories` row with no AI call; a pending proposal + a plain yes/no resolves it in code (execute or drop — proposals expire after 2 hours); dispatch-style messages get the dispatch helper when its capability is on; everything else runs the agent loop (tools over his own records; bot-proposed writes are stored in `bot_pending_actions`, never executed without his yes). Both turns are persisted to the shared timeline. Returns `200` with `{ reply: string, pending_summary: string \| null }`. Nothing is ever sent to any third party from this endpoint. |

**Agent omnipresence (design §9)** widens what the loop behind this endpoint (and the Telegram webhook) can do, without changing the endpoint's shape: read tools cover every business entity in `docs/schemas.md` (documents including their `extracted_text` content when the scan migration has landed); write tools cover create/update across the same entities under the §8 standing rule; deletes go through a `delete_record` tool that is **always** staged as a proposal, even when directly ordered. A pasted **dump** (dispatch thread, rate con, brain-dump) is extracted by the model into one `stage_dump_items` call; code validates each item (target tool's Zod schema, verbatim `source_quote`, numeric grounding against the message) before storing the accepted items as one numbered batch in `bot_pending_actions` (migration `00021`). Batch replies resolve in code: a plain yes approves all, "approve 1, 3" approves exactly those (the rest stay pending), "drop the rest" clears the remainder, and a correction is applied to the stored proposal via `revise_pending_item` and still needs his yes before anything is recorded. The web surface takes dumps as pasted text only — file upload stays in More → Documents, after which the agent reads the document back through its tools.

**Abel intake & routing (design §13)** adds one read tool and one Telegram behavior, without changing any endpoint's shape: the `check_route` read tool runs the Smart Path engine (`POST /api/v1/smart-path/route-check`'s own computation) over a recorded load — arguments `{ load_id: uuid, depart_at?: ISO timestamp, pickup_window?: { start, end }, delivery_window?: { start, end }, food_mode?: "grocery" | "fast_food", gallons_to_buy?: number }`, Zod-validated with the endpoint's window schema — and returns the engine's verdict (ON TIME / EARLY / LATE / NOT LEGAL), leave-by, inserted breaks/rests, engine + `truckLegal`, and fuel/food notes as grounding text. Origin, destination, truck profile, and duty clocks come from his records (the engine's design), never from tool parameters. On the Telegram surface the engine's reads are additionally filtered by company id in code (its client is service-role); the endpoint's RLS-scoped call is unchanged. Separately, Telegram photo messages file documents through the shared storage pipeline `services/documents/store-document.ts` — the same helper `POST /api/v1/documents` now stores through — under `related_entity_type "company"` (see the webhook row below).

### Telegram webhook (Driver MVP, `docs/design/driver-mvp.md` §4)

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/telegram/webhook` | Telegram Bot API webhook for the owner's **private** bot. No user session exists for this caller (listed public in `src/proxy.ts`, like `/api/internal`); the route enforces its own checks, in order: `TELEGRAM_BOT_TOKEN` unset → `503` (disabled); `TELEGRAM_WEBHOOK_SECRET` set → the `x-telegram-bot-api-secret-token` header must match, else `401`; non-private chats → ignored; chat id ≠ `TELEGRAM_ALLOWED_CHAT_ID` → ignored; allowlist unset → bootstrap mode, replies with only that chat's id and runs no AI. Allowlisted private text runs through the same dispatch-helper service as `/api/v1/dispatch-suggest` and the reply is sent back in that same private chat only. The bot never joins, reads, or sends to any group and never messages any third party. Accepted updates return `200 { ok: true }` even when deliberately ignored, so Telegram doesn't retry-storm. Note: this surface has no session, so it cannot check the in-app kill switches — its revocation is its own env surface (unset the token/allowlist), a deliberate boundary recorded in the design. **Bot intelligence (design §6):** the same webhook also carries plain conversation — every turn's prompt is assembled in code with persisted history (`telegram_messages`), a live company snapshot, the owner's standing instructions, and retrieved memories (`bot_memories`, both standard resources in `docs/schemas.md` written via the bot's documented service-role path, not through this API). Routing and capture rules are design §6, not API surface. **Photo intake (design §13):** an allowlisted private photo message (with optional caption) is document intake, not conversation — the largest rendition is downloaded via the Bot API and stored through the shared documents pipeline (see "Documents" above), filed under the company itself (`related_entity_type "company"`, `related_entity_id` = the company id), and the reply states what was stored plus the extraction state via the seam reader; oversize/download/store failures reply honestly that nothing was stored. No new ingress: photos arrive under the already-registered `["message"]` updates, behind the same secret + allowlist checks. |

---

*Exact UI screens consuming this API are Phase 7 (`docs/design/ui-ux.md`). This document is the boundary between frontend and backend — both must conform to it once implementation starts.*

### Fresh-Eyes GAP endpoints (GAP-02…GAP-16, union wave 2 — UH-11 fix)

All routes below require the standard authenticated owner session (see Auth above); tenant isolation is RLS + `company_id` scoping, as everywhere. The five register resources are standard resources (the 5-endpoint table above applies: list/get-one/create/PATCH/DELETE-soft-delete) over the tables named, with fields per `docs/schemas.md` and the entity types in `src/types/entities.ts`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/credentials` | List credentials (GAP-11, migration 00054) |
| POST | `/api/v1/credentials` | Create a credential |
| GET | `/api/v1/credentials/{id}` | Get one credential |
| PATCH | `/api/v1/credentials/{id}` | Partial update |
| DELETE | `/api/v1/credentials/{id}` | Soft delete |
| GET | `/api/v1/facilities` | List facilities (GAP-03, migration 00053) |
| POST | `/api/v1/facilities` | Create a facility |
| GET | `/api/v1/facilities/{id}` | Get one facility |
| PATCH | `/api/v1/facilities/{id}` | Partial update |
| DELETE | `/api/v1/facilities/{id}` | Soft delete |
| GET | `/api/v1/load-invoices` | List load invoices (GAP-12, migration 00055) |
| POST | `/api/v1/load-invoices` | Create a load invoice |
| GET | `/api/v1/load-invoices/{id}` | Get one load invoice |
| PATCH | `/api/v1/load-invoices/{id}` | Partial update |
| DELETE | `/api/v1/load-invoices/{id}` | Soft delete |
| GET | `/api/v1/recurring-obligations` | List recurring obligations (GAP-13, migration 00056) |
| POST | `/api/v1/recurring-obligations` | Create a recurring obligation |
| GET | `/api/v1/recurring-obligations/{id}` | Get one recurring obligation |
| PATCH | `/api/v1/recurring-obligations/{id}` | Partial update |
| DELETE | `/api/v1/recurring-obligations/{id}` | Soft delete |
| GET | `/api/v1/broker-followups` | List broker follow-ups (GAP-14, migration 00057) |
| POST | `/api/v1/broker-followups` | Create a broker follow-up |
| GET | `/api/v1/broker-followups/{id}` | Get one broker follow-up |
| PATCH | `/api/v1/broker-followups/{id}` | Partial update |
| DELETE | `/api/v1/broker-followups/{id}` | Soft delete |
| GET | `/api/v1/brokers/{id}/scorecard` | GAP-14: the broker's computed scorecard (loads run, days-to-pay, detention raised, outstanding); `404` when the broker isn't the caller's. Response: `{ data: BrokerScorecard }` |
| GET | `/api/v1/detention-stamps` | List detention stamps (GAP-04, migration 00052) |
| POST | `/api/v1/detention-stamps` | Create a detention stamp |
| GET | `/api/v1/detention-stamps/{id}` | Get one detention stamp |
| PATCH | `/api/v1/detention-stamps/{id}` | Partial update |
| DELETE | `/api/v1/detention-stamps/{id}` | Soft delete |
| GET | `/api/v1/loads/{id}/detention-stamps` | The load's stamps plus the computed detention summary (`{ data: { stamps, summary } }`); `404` for a missing/other-tenant load |
| POST | `/api/v1/loads/{id}/detention-stamps` | Stamp the load's facility clock; body names the stamp type, `occurred_at` defaults to now |
| GET | `/api/v1/loads/{id}/paperwork` | GAP-05: the load's paperwork state — required vs attached, computed by `src/lib/paperwork.ts`; `404` for a missing/other-tenant load |
| GET | `/api/v1/day-wrap` | GAP-08: one reconciliation pass over a day's records. Query: `?date=YYYY-MM-DD` (America/New_York; defaults to today ET). Response: `{ data: { date, items: DayWrapItem[] } }` |
| GET | `/api/v1/inbox` | Company inbox, rung 1 READ-ONLY (docs/design/company-inbox.md): each mailbox's honest status (dispatch, owner) plus the messages Abel has read. Query: `?q=` (sender/subject/summary), `?classification=`, `?mailbox=dispatch|owner`, or `?id=<uuid>` for one message in full with its UNSENT drafts. Response: `{ data: { statuses, messages } }` or `{ data: { statuses, message, drafts } }`. Session auth; GET only - nothing sends or changes mail; bodies are untrusted outside content. |
| GET | `/api/v1/ifta` | GAP-15: the IFTA worksheet for a quarter. Query: `?quarter=YYYYQn` (defaults to the current quarter, ET). Response: `{ data: IftaWorksheet }` — gallons by state exact; interstate miles reported unallocated; odometer miles pass the sanity gate (implausible readings excluded and flagged in `anomalies`, count in `excludedOdometerReadings`) |
| GET | `/api/v1/tax-packet` | GAP-16: the year-end tax packet. Query: `?year=YYYY` (defaults to the current year, ET). Response: `{ data: TaxPacket }` — per-diem count at the labeled rate, fuel totals, expenses by category, load revenue, and settlement income (`settlementIncomeCents`, `settlementsCount`) joined from Abel Phase D's `settlements` table (driver pay, periods ending in the year; zero when the table is absent) |

**`POST /api/v1/documents` response addition (GAP-01, UH-11 fix)** — when document text extraction completes and record proposals are staged from the read, the response also carries `proposals_staged: number` (how many record proposals were staged for the owner's approval; the proposals themselves ride the standard pending-proposal flow, never a silent write).

### Vehicle defects (Image Intelligence §5.5, migration 00046 — UH-11 fix)

Standard resource semantics (the 5-endpoint table above) over the `vehicle_defects` table; authenticated owner session, RLS tenant isolation.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/vehicle-defects` | List vehicle defects |
| POST | `/api/v1/vehicle-defects` | Create a vehicle defect |
| GET | `/api/v1/vehicle-defects/{id}` | Get one vehicle defect |
| PATCH | `/api/v1/vehicle-defects/{id}` | Partial update |
| DELETE | `/api/v1/vehicle-defects/{id}` | Soft delete |

### Paper-log review (docs/design/driver-hud.md §6) — added 2026-11-04

Authenticated owner session; company-scoped; reading never writes a duty row.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/paper-logs` | The photographed sheets (documents with `photo_purpose = 'paper_log'`): `{ data: PaperLogListItem[] }` — `log_date`, `read` (a stored read exists), `saved` (rows from this sheet are in the log) |
| POST | `/api/v1/paper-logs` | Body `{ document_id }`. Reads the stored sheet's grid now (gated by the `photo_intelligence` capability: `403 CAPABILITY_OFF` when off; `502 READ_FAILED` when the photo can't be read — the sheet stays stored), stores the read on the document (`extracted_fields.paper_log_read`, re-validated on every load), returns `{ data: PaperLogReview }` |
| GET | `/api/v1/paper-logs/{documentId}` | `{ data: PaperLogReview }`: signed photo URLs, the editable day (`draft` — every minute 00:00–24:00 present; unreadable spans have `status: null`, under-floor reads are `origin: "low"`), the reader's cross-check `problems`, the sheet's `written_totals`, `conflicts` (rows from other sources starting inside the day) and `saved_rows` (from this sheet). `404` for a missing/other-company sheet |
| POST | `/api/v1/paper-logs/{documentId}/save` | Body `{ log_date, segments: [{ status, start_min, end_min }], replace_ids }`. Re-validates that the segments tile 00:00–24:00 with a status each (`422` otherwise), then calls `save_paper_log_day` (migration 00059) in one transaction: refuses with `409 PAPER_LOG_CONFLICT` if any entry inside the day isn't in `replace_ids`; soft-deletes this sheet's earlier rows and the acknowledged entries; inserts the rows (`source = 'paper_photo'`, times placed in the carrier time zone); retires any Telegram proposal batch for the sheet. Response `{ data: { inserted } }` |


---

## Reconciliation appendix — complete route inventory (generated 2026-11-05 from `src/app/api/**/route.ts` on `main`)

115 route files. "Generic CRUD" routes follow the contract in the sections above (standard list/error envelopes, Zod validation, soft-delete + `/restore` where the Unit A lifecycle applies). Every `/api/v1/*` route except `health` runs through `createApiHandler` (session auth, company scope, centralized error mapping). A drift check that fails when a route is not in this table is proposed for Wave 4.

| Route | Methods | Kind / auth |
|---|---|---|
| `/api/internal/industry-briefing/run` | POST | internal invoker — secret header, no user session |
| `/api/internal/research/run` | POST | internal invoker — secret header, no user session |
| `/api/telegram/webhook` | POST | Telegram webhook — secret token + chat allowlist, fails closed |
| `/api/v1/account-snapshots/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/account-snapshots/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/account-snapshots` | GET,POST | generic CRUD (contract above) |
| `/api/v1/ai-settings` | GET,PATCH | custom (see section / design doc) |
| `/api/v1/assistant/chat` | GET,POST | custom (see section / design doc) |
| `/api/v1/broker-followups/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/broker-followups` | GET,POST | generic CRUD (contract above) |
| `/api/v1/brokers/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/brokers/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/brokers/[id]/scorecard` | GET | custom (see section / design doc) |
| `/api/v1/brokers` | GET,POST | generic CRUD (contract above) |
| `/api/v1/business-ladder/[step_key]` | PATCH | custom (see section / design doc) |
| `/api/v1/business-ladder` | GET | custom (see section / design doc) |
| `/api/v1/cash-advances/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/cash-advances/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/cash-advances` | GET,POST | generic CRUD (contract above) |
| `/api/v1/credentials/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/credentials` | GET,POST | generic CRUD (contract above) |
| `/api/v1/customers/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/customers/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/customers` | GET,POST | generic CRUD (contract above) |
| `/api/v1/day-wrap` | GET | custom (see section / design doc) |
| `/api/v1/inbox` | GET | custom (see section / design doc) |
| `/api/v1/detention-stamps/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/detention-stamps` | GET | generic CRUD (contract above) |
| `/api/v1/dispatch-exchanges/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/dispatch-exchanges/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/dispatch-exchanges` | GET,POST | generic CRUD (contract above) |
| `/api/v1/dispatch-suggest` | POST | custom (see section / design doc) |
| `/api/v1/documents/[id]/restore` | POST | custom (see section / design doc) |
| `/api/v1/documents/[id]` | DELETE | custom (see section / design doc) |
| `/api/v1/documents/cleanup-incidents/[id]/retry` | POST | custom (see section / design doc) |
| `/api/v1/documents/cleanup-incidents` | GET | custom (see section / design doc) |
| `/api/v1/documents` | GET,POST | generic CRUD (contract above) |
| `/api/v1/drivers/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/drivers/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/drivers` | GET,POST | generic CRUD (contract above) |
| `/api/v1/duty-logs/auto-motion` | POST | custom (see section / design doc) |
| `/api/v1/device-tokens/[id]` | DELETE | custom (see section / design doc) |
| `/api/v1/device-tokens` | GET,POST | custom (see section / design doc) |
| `/api/v1/telegram-webhook` | GET,POST | custom (see section / design doc) |
| `/api/v1/position/feed` | POST | custom (see section / design doc) |
| `/api/v1/duty-logs/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/duty-logs/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/duty-logs` | GET,POST | generic CRUD (contract above) |
| `/api/v1/duty-logs/window` | GET | custom (see section / design doc) |
| `/api/v1/equipment-checklist-items/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/equipment-checklist-items/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/equipment-checklist-items` | GET,POST | generic CRUD (contract above) |
| `/api/v1/expenses/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/expenses/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/expenses` | GET,POST | generic CRUD (contract above) |
| `/api/v1/facilities/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/facilities` | GET,POST | generic CRUD (contract above) |
| `/api/v1/financial-summary/detail` | GET | custom (see section / design doc) |
| `/api/v1/financial-summary` | GET | custom (see section / design doc) |
| `/api/v1/fuel-purchases/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/fuel-purchases/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/fuel-purchases` | GET,POST | generic CRUD (contract above) |
| `/api/v1/fund-entries/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/fund-entries/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/fund-entries` | GET,POST | generic CRUD (contract above) |
| `/api/v1/game-plan/promote` | POST | custom (see section / design doc) |
| `/api/v1/game-plan/regame` | POST | custom (see section / design doc) |
| `/api/v1/game-plan` | GET | custom (see section / design doc) |
| `/api/v1/game-plan/what-if` | POST | custom (see section / design doc) |
| `/api/v1/game-targets/[id]` | DELETE,GET,PATCH | custom (see section / design doc) |
| `/api/v1/game-targets` | GET,POST | custom (see section / design doc) |
| `/api/v1/health` | GET | health (public, no sensitive data) |
| `/api/v1/hos-settings` | GET,PATCH | custom (see section / design doc) |
| `/api/v1/ifta` | GET | custom (see section / design doc) |
| `/api/v1/industry-briefings/[id]/dismiss` | POST | custom (see section / design doc) |
| `/api/v1/industry-briefings` | GET | generic CRUD (contract above) |
| `/api/v1/load-invoices/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/load-invoices` | GET,POST | generic CRUD (contract above) |
| `/api/v1/load-stops/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/load-stops` | GET,POST | generic CRUD (contract above) |
| `/api/v1/load-tasks/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/load-tasks` | GET,POST | generic CRUD (contract above) |
| `/api/v1/loads/[id]/detention-stamps` | GET,POST | custom (see section / design doc) |
| `/api/v1/loads/[id]/paperwork` | GET | custom (see section / design doc) |
| `/api/v1/loads/[id]/economics` | GET | custom (see section / design doc) |
| `/api/v1/loads/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/loads/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/loads` | GET,POST | generic CRUD (contract above) |
| `/api/v1/maintenance-events/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/maintenance-events/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/maintenance-events` | GET,POST | generic CRUD (contract above) |
| `/api/v1/maintenance-schedules/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/maintenance-schedules/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/maintenance-schedules` | GET,POST | generic CRUD (contract above) |
| `/api/v1/memories` | DELETE,GET,PATCH | custom (see section / design doc) |
| `/api/v1/map/speed-limit` | GET | custom (see section / design doc) |
| `/api/v1/briefing-image` | GET | custom (see section / design doc) |
| `/api/v1/news-image` | GET | custom (see section / design doc) |
| `/api/v1/paper-logs/[id]` | GET | custom (see section / design doc) |
| `/api/v1/paper-logs/[id]/save` | POST | custom (see section / design doc) |
| `/api/v1/paper-logs` | GET,POST | custom (see section / design doc) |
| `/api/v1/pay-profiles/[id]` | GET,PATCH | generic CRUD (contract above) |
| `/api/v1/pay-profiles` | GET,POST | generic CRUD (contract above) |
| `/api/v1/pay-summary` | GET | custom (see section / design doc) |
| `/api/v1/position` | GET | custom (see section / design doc) |
| `/api/v1/pretrip-inspections/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/pretrip-inspections/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/pretrip-inspections` | GET,POST | generic CRUD (contract above) |
| `/api/v1/recurring-obligations/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/recurring-obligations` | GET,POST | generic CRUD (contract above) |
| `/api/v1/research-briefings/[id]/dismiss` | POST | custom (see section / design doc) |
| `/api/v1/research-briefings/[id]/read` | POST | custom (see section / design doc) |
| `/api/v1/research-briefings/[id]` | GET | custom (see section / design doc) |
| `/api/v1/research-briefings/check-wires` | POST | custom (see section / design doc) |
| `/api/v1/research-briefings/research-now` | POST | custom (see section / design doc) |
| `/api/v1/research-briefings` | GET | custom (see section / design doc) |
| `/api/v1/smart-path/route-check` | POST | custom (see section / design doc) |
| `/api/v1/tax-packet` | GET | custom (see section / design doc) |
| `/api/v1/trailers/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/trailers/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/trailers` | GET,POST | generic CRUD (contract above) |
| `/api/v1/truck-fund` | GET | custom (see section / design doc) |
| `/api/v1/truck-fund/settings` | PATCH | custom (see section / design doc) |
| `/api/v1/trucks/[id]/restore` | POST | generic CRUD (contract above) |
| `/api/v1/trucks/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/trucks` | GET,POST | generic CRUD (contract above) |
| `/api/v1/vehicle-defects/[id]` | DELETE,GET,PATCH | generic CRUD (contract above) |
| `/api/v1/vehicle-defects` | GET,POST | generic CRUD (contract above) |


## Reconciliation appendix — contracts added since this document was last updated

All below: auth = session; company scope by RLS; errors use the standard envelope with no stack/path leakage.

### `load-tasks` (migration 00061)
`GET /api/v1/load-tasks?load_id=<uuid>` list · `POST` create `{load_id (uuid), text (non-empty), stop_kind? (pickup|delivery|every_stop|null), sort_order? (int)}` · `PATCH /{id}` `{text?, done_at? (ISO or null)}` · `DELETE /{id}` soft-delete. `done_at` is set only by the owner's tick; no endpoint infers completion.

### `load-stops` (migration 00062)
`GET /api/v1/load-stops?load_id=` · `POST {load_id, seq (int ≥ 1), kind? (pickup|delivery|other), name?, address?, appointment_at? (ISO instant), appointment_tz? (IANA)}` · `PATCH /{id} {arrived_at?, departed_at?, approved_at?, notes?}` (each ISO or null to clear a mis-tap) · `DELETE /{id}`. Progress fields are owner taps only; `approved_at` means "the dispatcher approved leaving", recorded by the owner, never assumed.

### `pay-profiles` (migration 00063; 00074 adds percent / pay week / payday - **unapplied live**)
`GET /api/v1/pay-profiles[?employer_name=]` · `POST {employer_name, rate_cents_per_mile (int ≥ 0), mile_basis? (loaded|all|practical|null), worker_type? (w2|1099|null), fuel_paid_by? (employer|driver|null), percent_of_load_bps? (int 0-10000; 8500 = 85%; null = none), pay_week_ends_on? / statement_weekday? / payday_weekday? (int 0=Sunday..6=Saturday; null = unset), effective_from?, notes?}` · `PATCH /{id}` (corrections, or `effective_to` to close terms). A second open-ended row for the same employer is refused by the database (partial unique index). `null` basis/worker/fuel means UNSET and nothing is computed from it. No DELETE route; history is kept.

### `news-image`
`GET /api/v1/news-image?signal=<uuid>&i=<0-9>` → `image/jpeg` (re-encoded, ≤ 640 px edge, metadata stripped; `Cache-Control: private, max-age=86400`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`). The caller names a stored signal and an index, never a URL. Failures are a **bare status** with no body: 404 (no such signal/image), 502 (lookup/fetch/decode failed), 503 (too many concurrent fetches). The server fetches through an SSRF-guarded fetcher (public IPs only, re-checked at connection time, ≤ 2 redirects, size/time caps, magic-bytes must match jpeg/png/webp).

### `briefing-image` (2026-11-07)
`GET /api/v1/briefing-image?briefing=<uuid>&i=<0-19>` → the same re-encoded `image/jpeg` contract as `news-image`. The caller names a stored research briefing and a finding index, never a URL. The server reads that finding's cited article URL (RLS-scoped), fetches the article page through the same SSRF-guarded fetcher (HTML capped at 512 KB, only mined for its `og:image`/`twitter:image` meta URL - never rendered), re-validates that image URL, and serves the publisher's own preview image for that exact article through the news-image pipeline. Any step that cannot produce the article's own image is a **bare 404** (no image, lookup miss, page/image unfetchable): the Research page renders that finding imageless - never a substitute or stock image. 502/503 as `news-image`. Both image routes are gated on the `deep_research` capability: off means no outbound fetch at all.

### `position` (migration 00060)
`GET /api/v1/position` → `{ position: null }` or `{ position: { lat, lng, accuracyM, headingDeg, speedMph, recordedAt, ageSeconds } }`, `Cache-Control: no-store`. The caller must treat a fix older than its own freshness bound as absent (Drive uses 45 s). Table absent (pre-00060) → `{ position: null }`.

### Changed existing contracts
- `loads` (create/update, API and bot tool): adds `trip_number`, `broker_reference`, `deadhead_miles`, `loaded_miles` (numeric, 2 dp), `pickup_tz`, `delivery_tz`; `miles` remains the integer total. The bot `create_load` additionally accepts `tasks[]` and `stops[]` saved in the same confirmation (see `docs/design/trip-intake.md`).
- `smart-path/route-check`: request adds `already_picked_up?: boolean`; with `start_point` it routes from the truck's position with no pickup geocode and no deadhead (reroute).
- `smart-path/route-check` response adds optional `corridor` (intelligence Phase 1, `docs/design/smart-path-intelligence.md`): `{ totalMiles, spacingMiles, points: [{ mile, lat, lng, etaAt (ISO | null when the plan cannot be timed) }] }` along the loaded route, or `{ unavailableReason }`; deadhead miles are accounted for in `etaAt`. Also `corridor.states` (`[{ state, enterMile, exitMile, padd }]`, approximate borders from bundled coarse outlines) and `fuel.regional` (`[{ paddCode, regionName, cents, label, period, freshness }]` — EIA weekly diesel average per PADD region where a map fuel candidate was priced; `stale` ones are shown, never ranked on). Map fuel candidates are priced by their region, falling back to the national average. `weather?` (Phase 2b): `{ status: ok|partial|unavailable, items: [{ mile, endMile, etaAt, kind, severe, text, source: "NWS" }], notes[], asOf }` — NWS forecast/alerts read at the time he reaches each of ≤12 sampled spots; advisory only; a spot that could not be checked is named in `notes`, never reported as clear. `stateRules?` (Phase 2c): `[{ state, kind: exceeds|info|no_rule_on_file, text, sourceUrl, verifiedOn, old }]` from the verified table `src/data/state-truck-rules.ts` (empty until rows are verified and added — then every state reads "no rule on file"). `roadWork?` (Phase 3): `{ status, items: [{ mile, etaAt, text, exceedsTruck, startsAt, endsAt }], notes[], asOf }` from the WZDx feed registry `services/integrations/wzdx-feeds.ts` (EMPTY until a feed is verified reachable and allowed — until then each crossed state is named "No work-zone data for <state>").
- `telegram` webhook: also accepts `edited_message` / `message.location` (Live Location fixes; processed after the allowlist + dedup claim, never answered in chat).

### Trailer assignment and trip documents (2026-11-05)
- `drivers` create/update accept `assigned_trailer_id` (uuid or null); `loads` create/update accept `trailer_id` (uuid or null) — migration 00066 (**unapplied until King applies it**; the UI sends these fields only when the owner changes them, and Abel's `create_load` folds `trailer_id` into notes if the column is missing).
- Trip documents use the existing `GET /api/v1/documents?related_entity_type=load&related_entity_id=<load>` and `POST /api/v1/documents` (multipart with `related_entity_type=load`). Photos he sends Abel are filed against the load only once linked (a BOL proposal he approves links it); an unlinked Telegram photo stays filed under the company until then.

### Unit D — fuel ↔ load link and per-load economics (migrations 00068, 00069)
- `fuel-purchases` create/update accept optional `load_id` (uuid | null): the ONE load the fuel was for, set only by the owner (the forms offer a picker and a "same truck, same day — assign it?" suggestion that never assigns by itself). Null = not assigned.
- `GET /api/v1/loads/[id]/economics` → `{ data: { revenueCents, directExpensesCents, directFuelCents, contributionMarginCents, provisional, excluded, caveat } }`. Margin = load rate − expenses carrying this load's id − fuel carrying this load's id; `provisional` until the load is completed with a delivery date; `excluded` always names what it leaves out (truck overhead, unassigned fuel); never called "profit". 404 for another company's load (RLS).
- `GET /api/v1/financial-summary` `measures.fuelNotAssigned` (cents): the period's fuel assigned to no load. The aggregate contribution margin now includes load-assigned fuel; the C.3 bridge still holds exactly.

### Block A — automatic switch to Driving (`POST /api/v1/duty-logs/auto-motion`, migration 00072)
Body `{ detected_at: ISO, submission_id: uuid }`. The app calls it when the truck has been detected moving (≥ 5 mph for 60 s, then a 30 s grace) while the log's latest status is not Driving. Returns `{ data: { switched: true, startedAt } }` after adding ONE Driving row (`started_at` = `detected_at`, `source: "auto_motion"`, a note stating it was automatic) and sending the owner a Telegram notice; or `{ data: { switched: false, reason } }` with `reason` ∈ `no_status | already_driving | manual_change_won | detection_in_future | detection_too_old | bad_time` — it never edits or deletes an existing row, so earlier segments cannot be rewritten. Replays of the same `submission_id` return `switched: true, deduplicated: true`. Against a database without 00072 the row is saved with `source: "app"` and the note carries the provenance.

### Block C — posted speed limit (`GET /api/v1/map/speed-limit?lat=&lng=&heading=`)
Authenticated. Returns `{ data: { limitMph: number | null, roadName: string | null, unavailable: boolean, source: "OpenStreetMap" } }`. `limitMph` is set ONLY when a way within ~25 m of the point (and, when `heading` is given, running the same direction ±35°) carries a plain numeric OSM `maxspeed` ("55 mph", or a unitless km/h number converted). Any other tag value, no nearby way, or an Overpass failure (`unavailable: true`) returns `limitMph: null` — the app then shows no badge and never estimates one. Cached server-side 10 minutes per ~55 m cell and 45° heading bucket.

### Background tracking — device tokens and the position feed (migration 00073; `docs/design/background-tracking.md`)
- `POST /api/v1/device-tokens` `{ label }` (session) → `201 { data: { id, label, created_at, token } }`. **`token` is returned once and never again** (only its SHA-256 is stored). Max 10 active. `GET /api/v1/device-tokens` → `{ data: [{ id, label, created_at, last_used_at }] }` (never the secret). `DELETE /api/v1/device-tokens/[id]` revokes (a timestamp; the feed refuses it immediately).
- `POST /api/v1/position/feed` — **not session-authenticated** (the native shell has no cookie; `proxy.ts` lists this one path as public): `Authorization: Bearer tdv_…`, body `{ fixes: [{ lat, lng, accuracy_m?, heading_deg?, at (epoch ms or ISO) }] }`, 1–60 fixes. Missing/malformed/unknown/revoked token → `401` (one generic body); more than 30 requests/min per token → `429`; bad body → `400`. Fixes older than 24 h or more than 60 s in the future are dropped (counted). Returns `{ data: { accepted, dropped } }` (or `reason: "switched_off"` when `live_location` is off). Each fix runs the same detection as Telegram Live Location (latest position in `driver_positions` with `source "device"`, movement episodes, the automatic switch to Driving, the stopped-5-minutes proposal), all scoped to the token's company in code.
- `GET /api/v1/position` now returns the NEWEST of the Telegram and device positions.
