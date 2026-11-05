# Tenant integrity — three layers (Reliability Unit E, ruling D-03)

Status: built and verified on a clean scratch Postgres 16 build; **NOT applied to the live database** (owner/King step — see "Applying it" below).

## The three layers
1. **RLS — visibility.** Every tenant table's policy limits what a session can read or write by `company_id` (`private.current_company_id()`). Untouched by this unit. Tested by `tests/db/rls-isolation.sql`.
2. **Composite foreign keys — referential tenant integrity** (migration `00070`). Every foreign key between two tenant tables is `(company_id, child_fk) → parent (company_id, id)`, with `UNIQUE (company_id, id)` on each parent. The database itself refuses a row pointing at another company's record, **even for a role that bypasses RLS**. `ON DELETE` / `ON UPDATE` actions are preserved verbatim (all were `NO ACTION`).
3. **A trigger for the one reference no FK can express** (migration `00071`): `documents.related_entity_type/id`. Allowlist: truck, trailer, driver, load, company. The target must exist, belong to the document's company, and not be soft-deleted. Every rejection raises the **identical** error (`invalid document reference`, SQLSTATE 23514) so the trigger is not an oracle for whether another company's record exists. `SECURITY DEFINER` with a fixed `search_path`, returns no data.

The API turns either backstop into one uniform 422 (`"One of the records this refers to wasn't found in your account."`) — never the raw constraint error (`tenantIntegrityError` in `services/api/handler.ts`).

## The inventory (63 composite FKs)
Generated from the schema's own catalog (`pg_constraint`), not hand-listed. Not converted, with reasons: every `company_id → companies(id)` (the tenant key itself) and `user_profiles.id → auth.users(id)` (Supabase-owned table). `tests/db/tenant-fk.sql` re-derives the inventory on every run and fails if any single-column tenant FK remains or the count drifts from 63.

## Rule for every future feature
**Any new foreign key between two tenant tables must be composite from birth** — `foreign key (company_id, x_id) references x (company_id, id)` — and the parent must carry `unique (company_id, id)`. `tests/db/tenant-fk.sql` fails the run otherwise, so the defect class cannot regrow silently. A new polymorphic reference needs its own trigger and allowlist entry (a migration, not a code-only change).

## Applying it (pre-flight is built in)
`00070` begins with a **pre-flight audit**: it counts, per relationship, rows whose child `company_id` differs from the parent's. **Any hit aborts the migration** with the relationship names and counts (no row values), and nothing is repaired automatically — the next step is an owner ruling (design E.3.1). Verified on scratch: with one seeded cross-company expense the migration aborts and converts nothing; with clean data it converts all 63. Order: `00068`, `00069`, `00070`, `00071`. Constraints are added `NOT VALID` and validated in the same migration; on a large live table that validation scans once.
Rollback: restore the single-column FKs and drop the unique constraints and the trigger; no data or columns changed, so it is exact (during that window tenant integrity falls back to RLS + app checks).

## Known limits
- Exploitability of the original gap was never demonstrated (NV-3 live attack test still open); this closes the structural half.
- Soft-deleted parents still physically exist, so the FK cannot see them; restore keeps its application-level parent check.
- Bot/agent write tools ride the same tables, so they inherit both layers.
