# Record lifecycle — delete, restore, idempotent create, merged validation

Reliability & Completion Program, Unit A (design:
`docs/reliability-wave1-design-package.md`, Unit A + Unit F; rulings
D-01/D-05). This is the contract every standard resource now follows.
Migration: `supabase/migrations/00041_record_lifecycle.sql`.

## Delete is a state, and it is truthful

- `DELETE /api/v1/{resource}/{id}` soft-deletes (sets `deleted_at`).
  It returns `204` only when a row was actually affected. Deleting a
  nonexistent, already-deleted, or other-company record returns
  `404` — the API never reports a deletion that didn't happen.
- A deleted record disappears from lists, detail fetches, pickers,
  and every total computed from live rows. Its children are NOT
  deleted with it (no cascade, in either direction, ever).
- Every list screen has a **Deleted** view (`GET ?deleted=only`)
  listing tombstones with a Restore action. The post-delete message
  on a detail screen links to that view ("View deleted record") —
  there is deliberately no "Undo": restore is a real, safeguarded
  operation, not a pretend reversal.

## Restore is safeguarded

`POST /api/v1/{resource}/{id}/restore`:

- Missing record → `404`. Record not deleted → `200` with its current
  state (no transition is faked).
- Otherwise three checks, each refusing with a `422` that NAMES the
  reason:
  1. The record still validates against its create schema (stored-
     record validation, below).
  2. Every FK parent it references still exists and is not itself
     soft-deleted — otherwise the refusal names the parent ("Cannot
     restore: its truck was deleted — restore the truck first"). The
     parent registry lives in `src/services/api/entity-registry.ts`.
  3. No uniqueness conflict results (no natural unique indexes exist
     on these tables today; the update's own constraint error is
     translated to a named `422`, never surfaced raw).
- Restore changes only the record itself — never its children, never
  its parents.

## Idempotent creates (submission tokens)

Create forms generate one UUID per form opening (`submission_id`,
`src/lib/use-submission-id.ts`) and send it with the payload. The
server stores it plus a SHA-256 fingerprint of the *validated*
payload (canonical key-sorted serialization), under a per-table
partial unique index `{table}_submission_idempotency` on
`(company_id, submission_id) WHERE submission_id IS NOT NULL`:

- Same token + same fingerprint → the original create replays:
  `200` with the original row plus `deduplicated: true`.
- Same token + different fingerprint → `409` with error code
  `submission_token_reused_with_different_payload`. Nothing is
  created; the original is never presented as this request's result.
- A violation of any OTHER unique constraint keeps that constraint's
  own error — only the named index enters the dedup path.
- No token → the original create path, unchanged (bot/API writes get
  no dedup guarantee). Identical field values under a NEW token
  always create a second record — dedup keys on the token, never on
  fuzzy field matching.

## Merged-record validation (updates)

`PATCH` no longer validates the patch in isolation. The shared update
path shape-checks the patch (`400`, as before), loads the existing
row under RLS (`404` before any validation detail can leak), merges
patch over row, and validates the FULL record against the create
schema. Failure → `422` with field-level errors (`error.fields`);
the database is never touched. Only the patched fields are written.

**Stored-record validation, two passes.** Storage and payloads
disagree about "empty": the database stores NULL for every unset
optional column, while most create schemas declare those fields
`.optional()` (absent-or-value), not `.nullable()`. Validation
therefore runs twice — the record as stored, then with null-valued
keys removed (null reads as absent) — and a record is invalid only
if both fail. Cross-field rules (pretrip's exactly-one-vehicle,
loads' date order, maintenance schedules' exactly-one-vehicle and
at-least-one-interval) fail both passes, because removing nulls
cannot manufacture a value a rule needs.

### Legacy-state sweep (Unit F, task F2)

Measured 2026-11-02 by parsing a maximally-null stored row against
every entity's create schema:

- **Null/optional mismatch (handled by two-pass validation):**
  trucks (vin, make, model, year, current_mileage, truck_type,
  height_in, length_in, weight_lbs, governed_speed_mph,
  tank_capacity_gallons, avg_mpg, appliance_notes), trailers (vin,
  trailer_type), drivers (phone, role, cdl_number, cdl_expires_on),
  brokers (mc_number, contact_email, contact_phone, notes),
  customers (contact_email, contact_phone, notes), loads
  (pickup_date, delivery_date, rate_cents, miles, notes), expenses
  (description), fuel_purchases (location).
- **Null-clean schemas (fields declared nullable):** duty_logs,
  maintenance_events, pretrip_inspections, account_snapshots,
  dispatch_exchanges, fund_entries.
- **Genuine cross-field legacy risk:** a maintenance_schedule with
  neither truck nor trailer, or with neither interval, and an
  equipment_checklist_item with neither truck nor trailer, fail
  validation in ANY state — such a row (creatable only before these
  rules existed) blocks PATCH and restore with a `422` naming the
  rule until a PATCH supplies the missing values (the edit forms
  submit the full corrected record, which passes). Whether any such
  rows exist in the live database is a live-verification question,
  not answerable from the repository.

## Load status transitions

On the load's own screen (server-enforced on the merged record):

- **Confirm** (`→ confirmed`) requires rate, pickup date, and
  delivery date — the draft-completeness checklist. A refusal is a
  `422` naming each missing field.
- **Complete** (`→ completed`) requires a delivery date.
- **Cancel** (`→ cancelled`) is a status, never a delete (D-01).
  `cancelled` is a first-class `loads.status` value (the column is
  unconstrained text; no migration was needed).
- All other transitions are allowed. Note: the create form's status
  selector still permits creating a load directly as
  confirmed/completed; the completeness rules bind transitions on
  existing records. (Flagged for the program's review.)

## Documents: retention delete + cleanup incidents

Documents do NOT follow the generic lifecycle above (D-05):

- `DELETE /api/v1/documents/{id}` tombstones the row
  (`deleted_at`, `retention_status = 'retained'`) and **never calls
  `storage.remove()`** — the file is retained and restore is always
  available. Zero affected rows → `404`, as everywhere.
- The default list and text search exclude tombstones.
  `GET /api/v1/documents?...&deleted=only` serves tombstones with
  their retention status and **no signed URLs**.
- `POST /api/v1/documents/{id}/restore` clears the tombstone, with
  the same parent safeguard as generic restore (a document filed
  against a deleted truck restores only after the truck).
- Purge (`retention_status` → `purge_pending`/`purged`/`purge_failed`,
  `purged_at`) is a specified state machine only — no purge is
  implemented; it awaits an owner-approved retention policy.
- **Cleanup incidents** (`cleanup_incidents`, migration 00041): when
  an upload's row insert fails, the compensating `storage.remove()`
  result is now CHECKED. If the object is not confirmed gone, an
  incident is recorded and the error says cleanup may have failed.
  `GET /api/v1/documents/cleanup-incidents` lists open incidents;
  `POST /api/v1/documents/cleanup-incidents/{id}/retry` re-checks
  presence — absent closes as `object_absent`, a successful removal
  closes as `resolved`, a failed removal stays `open` with the
  failure appended. The Documents page surfaces open incidents with
  the retry inline. This closes F-038's record shape only; the
  finding itself (live orphan sweep) remains open.
