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

`{resource}` is one of: `trucks`, `trailers`, `drivers`, `customers`, `brokers`, `loads`, `expenses`, `fuel-purchases`, `maintenance-events`. **Not `documents`** — it has its own contract (see "Documents" below) because it doesn't fit this shape: creation is `multipart/form-data` not JSON, there's no `PATCH` (documents aren't edited in place, per `docs/schemas.md`), and `DELETE` removes the row and file outright rather than soft-deleting. Applying this generic table to `documents` too would describe two incompatible APIs for the same resource.

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
| GET | `/api/v1/industry-briefings` | List, excludes dismissed, matches `docs/schemas.md` |
| POST | `/api/v1/industry-briefings/{id}/dismiss` | Sets `dismissed_at`; the "delete" analog for this resource |

There is no `POST /api/v1/industry-briefings` — the client never creates one directly. Rows are only ever written by the scheduled job described in `docs/automation.md`, using its own scoped service credential, not a user session. Every other AI-recommendation endpoint (decision engine, fuel intelligence, etc.) gets specified the same way, when it's actually designed.

---

*Exact UI screens consuming this API are Phase 7 (`docs/design/ui-ux.md`). This document is the boundary between frontend and backend — both must conform to it once implementation starts.*
