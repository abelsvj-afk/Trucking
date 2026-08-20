# Data Model Design

Phase 7 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. `docs/schemas.md` defines the columns; this defines the relationships, ownership, validation, lifecycle, and state behavior around them.

## Relationships

```
companies 1──N user_profiles
companies 1──N (every other table, via company_id)

trucks 1──N drivers (assigned_truck_id)
trucks 1──N loads, expenses, fuel_purchases, maintenance_events

drivers 1──N loads, expenses
brokers 1──N loads
customers 1──N loads
loads 1──N expenses (optional link)

documents N──1 (truck | trailer | driver | load), via related_entity_type/related_entity_id
```

Every relationship is optional except `company_id` (never optional) — a load can exist without a broker assigned yet, an expense without a specific truck, etc., because real data entry is often incremental (this is exactly what the `draft` load status and the "alternative workflow" in `docs/user-stories.md` already assume).

## Ownership

Every row belongs to exactly one `company_id`. There is no cross-company sharing, no "shared" record, at MVP — a customer or broker used by more than one company would be two separate rows, one per company. This is intentionally simple: real shared-entity modeling (e.g. a broker directory shared across companies) is a future-product feature, not something to speculatively design now.

## Validation

Two layers:

- **Type/shape validation** (required fields, types, formats) — enforced at the API boundary per `docs/api-contracts.md`, rejecting bad input with `400` before it reaches the database.
- **Business-rule validation** — rules that aren't expressible as a column type, enforced in `services/db` (per `docs/architecture.md`'s service boundaries), not scattered into UI code:
  - A load's `delivery_date` must not be before its `pickup_date`, when both are set.
  - `rate_cents`, `amount_cents`, `cost_cents`, `total_cost_cents` must be non-negative.
  - `gallons` must be positive.
  - A load only counts toward the financial summary when its `status` is `confirmed` or `completed` — `draft` loads are excluded, per `docs/schemas.md`.

## Lifecycle

- **Create → edit → soft-delete.** Every entity except `documents` follows this lifecycle (see `docs/schemas.md`'s soft-delete convention). Nothing is ever hard-deleted by a user action — `deleted_at` is set, the row stays.
- **`loads.status`** moves `draft → confirmed → completed`. This isn't a strictly enforced one-way state machine at MVP — the owner can move a load backward (e.g. `confirmed → draft` to fix a mistake) since there's exactly one trusted user and no approval workflow gating it yet. Building a strict transition-guard system now would be unnecessary complexity for a problem that doesn't exist yet; revisit if/when multiple users make that assumption unsafe.
- **`trucks`/`trailers`/`drivers`.`status`** (`active`/`maintenance`/`inactive`) are simple flags the owner sets directly — not a workflow with triggers or side effects at MVP.

## Retention

No automatic data expiry or purge job. Financial and maintenance history is exactly the kind of data this system exists to preserve (per `docs/idea.md`'s core problem), so indefinite retention is the deliberate default — soft-deleted records stay in the database, excluded from normal views, until/unless a real reason to purge them shows up. This isn't a regulatory retention schedule (per the non-goal in `docs/vision.md`, this system doesn't aim to be the authoritative compliance record) — it's just "don't throw away the owner's own business data."

---

*This document assumes the entities and columns in `docs/schemas.md` as given — if the schema changes, check this document for now-incorrect relationship or validation claims rather than assuming it's still accurate.*
