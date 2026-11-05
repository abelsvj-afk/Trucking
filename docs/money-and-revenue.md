# Money and revenue — the contract

Reliability & Completion Program, Unit C (design `docs/reliability-wave1-design-package.md` §C; owner rulings D-01 and D-04, 2026-11-02). This document is the money truth the code implements: what "revenue" means, what the three measures are, how totals are guaranteed, and how fuel math works. If code and this document disagree, that is a defect — in one of them, on the record.

## Revenue recognition (D-01)

A load's rate becomes **recognized revenue** when, and only when:

- the load's status is `completed`, **and**
- it has a `delivery_date`,

recognized in the **viewer-local month of the delivery date**. Both signals are required — status alone can be marked carelessly, a date alone can be typed onto a draft. There is no pickup-date fallback (the pre-Unit-C behavior, and the F-008 defect).

Around that rule:

- **Pipeline** = `draft` + `confirmed` loads (sum of `rate_cents`). Shown separately, **never** added to revenue or to any net figure. A pipeline load with no rate contributes 0 and is counted in a "loads without a rate" note.
- **Exception, surfaced not dropped**: a `completed` load with no `delivery_date` is excluded from revenue and reported as a named count with its record IDs ("Completed loads missing a delivery date: N — excluded from revenue"), with a link from the Money summary.
- **Cancelled loads** (status value added under D-01; the DB column is unconstrained text, so no migration was needed) are excluded from recognized revenue **and** from pipeline, and are visually distinct in the loads list.
- **History** is recomputed under this convention — the old fallback was part of the defect — and the Money summary carries a one-time notice with this exact wording: *"Past months' operational revenue was restated to count loads when delivered. This changes how this app reports its own figures; it does not change any cash you received or any tax record."*
- The API returns `revenueConvention: "recognized_on_delivery"` and the UI renders its revenue label from that field — the label travels with the data and cannot drift from the logic.

## The labeling rule (binding everywhere the figure appears)

The load-rate figure is **operational load revenue, recognized on delivery**. It is **not** cash collected, **not** settled revenue, and **not** an accounting or tax result — this system contains no invoice or settlement records, so no figure in it may be worded as received, settled, or filed. Labels say so in plain language ("Operational revenue — loads delivered; not payments received").

## The three measures (never substituted for one another)

| Measure | Meaning | Date basis |
|---|---|---|
| Per-load contribution margin (Unit D's surface) | One load's recognized revenue − direct costs **assigned to that load** | Costs: assignment, over the load's whole life |
| **Period operating result** | Recognized revenue for period P − **all** costs incurred in P, assigned or not | Costs: incurred in P (expenses by `expense_date`, fuel by `purchased_at`, maintenance by `service_date`, viewer's local period) |
| **Aggregate contribution margin** (loads delivered in P) | Sum of per-load margins over loads delivered in P | Costs count **whenever incurred**, including earlier periods |

The bridge between the period measures must hold exactly, in integer cents (acceptance property C.7.4, implemented in `src/services/financial-summary/measures.ts`): a fuel purchase made in October and assigned to a load delivered in November is an **October** cost in the period operating result and a **November** margin cost in the aggregate margin. Fuel carries an optional `load_id` (migration 00068, Unit D): fuel the owner assigned to a load is a direct cost of that load (it enters the aggregate margin and, per load, the contribution margin on the load page); fuel assigned to none is shown as "Fuel not assigned to a load" and stays in the period result — never spread across loads. The summary reads this from migration 00069; against a database without 00069 all period fuel is read as unassigned, exactly as before.

## The snapshot guarantee (F-033)

A summary total is a true statement about **one** database state — complete and consistent. The summary and detail endpoints therefore read inside a dedicated direct-connection transaction whose **first statement** is `BEGIN ISOLATION LEVEL REPEATABLE READ`; totals are computed by SQL inside that snapshot (read logic: migration `00044`'s `financial_summary_snapshot` / `financial_summary_detail`, SECURITY INVOKER functions), and each component returns `{ total_cents, row_count, record_ids }` with an in-snapshot assertion that the count equals the number of IDs. Any failure — assertion, isolation probe, connection — returns the visible `503 SUMMARY_UNVERIFIED` state. Never a partial total, never a blend of states, no silent truncation.

Tenant security inside the transaction: the direct connection is privileged, so the transaction re-establishes the caller's context before any read — `SET LOCAL ROLE authenticated` (the database role; the app's business role is a claims value, never a role target) and the JWT claims set from the **verified server session's user ID only**. RLS then applies exactly as on the PostgREST path. The connection string is a server-only Fly secret named **`FINANCIAL_SUMMARY_DB_URL`** (name recorded here; the value is set by the owner at deploy time and never appears in code). The isolation change is scoped to these transactions only — no role default is altered; every other request stays at READ COMMITTED.

## Fuel math (D-04)

One true total, derived — never a free-typed third number:

- `base = round_half_up(gallons × price_per_gallon_cents)`, computed in integer milligallons (`src/lib/fuel-math.ts`) and equivalently as `round(gallons * price)` over `numeric(10,3)` in the database — the same function by construction. Tripwire: 2.675 gal × 100¢ = **268¢**.
- Gallons are accepted to **3 decimal places**; more precision is a 422, never a silent rounding.
- Genuine receipt differences (taxes, discounts, rebates) are an explicit **adjustment with a reason**: `total = base + adjustment_cents`. A nonzero adjustment without a reason is refused by the API (422) and by a DB CHECK.
- A client-supplied `total_cost_cents` is accepted only as the derived echo; disagreement is a field-level 422. The forms show the base live, take an optional adjustment + reason, and display the total read-only.
- **Legacy rows**: pre-F-053 rows whose stored total disagreed were backfilled by migration `00043` with the exact difference as a labeled adjustment — reason `Legacy variance (pre-F-053)` — so totals the owner already saw are preserved to the cent, the invariant holds for every row, and the reason renders wherever the legacy total is shown (fuel list row and detail view).

## Invariants at the database boundary (F-026)

Migration `00044` adds CHECK constraints mirroring the Zod rules (`loads.rate_cents >= 0`, `loads.miles >= 0`, `delivery_date >= pickup_date` when both present, `expenses.amount_cents >= 0`), added **NOT VALID** with a documented application procedure in the migration header: run the violator scans and report counts + IDs, correct through the app's edit UI (or except by owner decision), then `VALIDATE CONSTRAINT`. If a violator will not be corrected, the constraint stays NOT VALID and the finding stays open.
