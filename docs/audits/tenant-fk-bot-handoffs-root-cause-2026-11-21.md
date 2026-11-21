# Tenant FK straggler: bot_handoffs.parent_id — root cause (2026-11-21)

**Symptom.** Migration 00116 applied cleanly to production and converted its two
stragglers — but the same live run of `tests/db/tenant-fk.sql` (2026-11-21) then failed
its completeness sweep on one more foreign key left in single-column form:

- `bot_handoffs.parent_id -> bot_handoffs` (a self-reference)

**Where the table and the FK live.** `bot_handoffs` is created by **00113**
(`00113_bot_tracker.sql`, the Tracker lane's migration — the team-room handoff queue).
Line 86 defines the self-reference in original single-column form:
`parent_id uuid references bot_handoffs(id) on delete set null`. 00113 adds no
`bot_handoffs (company_id, id)` unique key (its only unique constraint is
`(company_id, idempotency_key)`). A grep over `supabase/migrations/` confirms 00113 is
the **only** migration that mentions `bot_handoffs` at all: no migration — not 00111,
not 00116 — has ever converted this FK. Unlike the 00116 pair, there is no conversion
sitting in an unapplied migration; the conversion was never written.

**Why scratch passed.** Not because scratch had the conversion — it does not. The
scratch gate that cleared PR #113 was built from tree `b37e3ec6`, whose migrations stop
at **00112**. `bot_handoffs` is not in that chain at all, so `tenant-fk.sql`'s
completeness sweep — which enumerates `pg_constraint` in whatever database it runs
against — never saw the table. The gate was chain-complete for a chain that predated
the Tracker landing. (The full current chain, 00113 included, reproduces the live
failure exactly; see Gate evidence.)

**Why 00111 missed it.** 00111's header says its inventory of single-column FKs came
from running `tenant-fk.sql` on the scratch chain of its day, and it converts a fixed
list of eight with no completeness sweep of its own. That inventory was frozen before
00113 existed. The Tracker lane then landed 00113 through PR #111 in parallel,
creating a **new** single-column tenant FK after the audit's list was closed. Nothing
in 00111 or 00113 is internally wrong; the gap is between lanes — a later migration
reintroduced the pattern the audit had just eliminated, and no gate then in use
re-ran the completeness sweep over the union chain. 00111 and 00113 both stay frozen,
like every applied migration.

**Why production differs.** Production applied 00113 live on 2026-11-20 (final apply
batch: 00105, 00107, 00113, 00114, 00115 — each "Success. No rows returned"), so the
single-column FK is in effect there. This is not the 00090 pattern (a conversion that
exists but never ran); it is a table whose conversion never existed, gated by a chain
that never contained the table.

**The fix.** `00118_tenant_fk_bot_handoffs.sql` performs the conversion for the first
time, in the established form: the same pre-flight (abort on cross-company rows, count
only, no repair), the guarded add of the parent key `bot_handoffs (company_id, id)`,
and the composite FK `(company_id, parent_id) -> bot_handoffs (company_id, id)`. One
refinement over a plain copy of 00116's shape: the original FK is
`ON DELETE SET NULL`, and a plain composite `SET NULL` would null `company_id` too
(NOT NULL), making parent deletes fail. Following 00111's F-008 precedent for
`business_credit_events`, the conversion uses the PostgreSQL 15+ column-list form
`ON DELETE SET NULL (parent_id)` — a deleted parent nulls only the reference, never
the tenant key. The migration is state-aware like 00116: it converts where the
original FK is present, no-ops where the tenant FK already exists, and aborts loudly
in any third state. `tests/db/tenant-fk.sql` is updated in the same branch: the
composite-FK inventory goes 78 -> 79 (+1 from 00118) and a behavior case proves a
company-A handoff cannot point at a company-B parent (23503) while a same-company
parent link is accepted.

**Gate evidence** (scratch PostgreSQL 17.6 + pgvector 0.8.0, repo harness
`tests/db/build-scratch.sh`, 2026-11-21):

- **Full chain:** built from all 106 migrations (through 00116, plus 00118); the
  tests/db suite passes **10/10** — tenant-fk, rls-isolation, anon-privileges,
  outbound-call-claim, bot-spend-reservation, business-credit-owner-only,
  driver-positions, documents-trigger, pool-role-grants, email-tables.
- **Production-shaped reproduction:** a database built from the 105-migration chain
  through 00116 (production's current form — 00113 present, no conversion) fails
  main's `tenant-fk.sql` with the live message verbatim:
  `UNCONVERTED single-column tenant FK(s): bot_handoffs.parent_id -> bot_handoffs`.
  After applying 00118, the branch's check passes (completeness: 0 unconverted,
  79 composite FKs; behavior: 11/11 cross-company references refused, same-company
  accepted). The converted constraint reads
  `FOREIGN KEY (company_id, parent_id) REFERENCES bot_handoffs(company_id, id) ON DELETE SET NULL (parent_id)`,
  with the new `bot_handoffs_company_id_id_key` unique key beside it.
- **State-awareness:** re-running 00118 on the converted database succeeds and
  leaves the constraint state identical (no-op). With a cross-company parent row
  seeded (a company-A handoff pointing at a company-B parent — insertable precisely
  because the single-column FK permits it), 00118 aborts with
  `00118 aborted: bot_handoffs.parent_id -> bot_handoffs: 1 cross-company row(s)`
  and the schema is unchanged; after the row is removed, 00118 converts cleanly and
  the check passes.
- **Delete behavior:** deleting a parent handoff nulls only the child's
  `parent_id`; the child row and its `company_id` survive — 00113's original
  `ON DELETE SET NULL` intent, preserved by the column-list form.
