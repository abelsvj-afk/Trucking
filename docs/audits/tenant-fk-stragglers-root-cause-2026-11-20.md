# Tenant FK stragglers — root cause (2026-11-20)

**Symptom.** Migration 00111 applied cleanly to production, and `tests/db/tenant-fk.sql`
passed on a scratch database built from the full migration chain — but the same check,
run against the live database, failed its completeness sweep on exactly two foreign keys
left in single-column form:

- `research_learning_topics.research_run_id -> research_runs`
- `duty_log_edits.duty_log_id -> duty_logs`

**Where the conversion lives.** These are the only two tenant FKs whose conversion sits in
migration **00090** (`00090_tenant_fk_duty_log_edits_and_learning_topics.sql`). Both were
created single-column — `00084` line 77 (`research_run_id uuid references research_runs (id)`)
and `00088` line 36 (`duty_log_id uuid not null references duty_logs (id)`) — and a grep over
`supabase/migrations/` confirms 00090 is the sole migration that converts them (it adds
`research_learning_topics_research_run_id_tenant_fkey` and
`duty_log_edits_duty_log_id_tenant_fkey`). Parent keys: `research_runs (company_id, id)`
exists from 00070; `duty_logs (company_id, id)` was 00090's to add if missing.

**Why scratch passed.** `tests/db/build-scratch.sh` replays *every* migration in filename
order, 00090 included, so on scratch both FKs have been composite since 00090 ran.
`tenant-fk.sql`'s own inventory comment credits "+2 from 00090" toward its expected 78
composite tenant FKs. The check is state-based — section 1a enumerates `pg_constraint` in
whatever database it runs against — so it passes wherever 00090 has run and fails wherever
it has not.

**Why 00111 missed them.** 00111's header says its inventory of single-column FKs came from
running `tenant-fk.sql` on that same scratch chain. In that state the two stragglers were
already converted by 00090, so they never appeared in the inventory. 00111 converts a fixed
list of eight and has no completeness sweep of its own; its pre-flight covers only its eight.
Nothing in 00111 is wrong on a database where 00090 ran — it is simply chain-complete, not
production-complete. 00111 stays frozen, like every applied migration.

**Why production differs.** Production still holds both FKs in their original single-column
form. Since 00090 is the only migration that converts them, 00090 is not in effect in
production — it was never applied there. (Its live status had been recorded as unknown: the
2026-11-19/20 apply batches ran 00101, the corrected 00103, 00104, 00106 and 00108–00112 —
never 00090. 00090's own header even flags the apply risk: "if another branch has claimed
it, renumber this file before applying.") Neighboring evidence says this was a single skip,
not a missing era: 00111's eight conversions are in effect live, and the live
business-credit check read the owner's real seeded vendor rows, so 00087's data is present.
A full applied-migration inventory of production is still an open item for King's lane;
this note proves the gap for 00090 only.

**The fix.** `00116_tenant_fk_stragglers.sql` re-issues 00090's conversion for production,
with the same pre-flight (abort on cross-company rows, count only, no repair), the same
constraint names, and the same guarded parent-key add for `duty_logs`. It is deliberately
state-aware: on a database where 00090 already ran it no-ops, so the full chain (and the
scratch gate) still replays cleanly; on production it performs the conversion; in any third
state it aborts loudly instead of skipping silently. After 00116, production reaches the
same 78 composite tenant FKs the check expects.

**Companion fixes in the same branch.** Two sibling checks proved scratch-shaped rather
than live-safe on their first live run, and are fixed in place (assertions unchanged):

- `tests/db/outbound-call-claim.sql` — its fixture used fixed company/user ids and assumed
  an empty database; the live run died in setup against the populated database. Fixture ids
  are now generated per run, every row the check depends on is created by the fixture
  itself, and the ids travel in transaction-local settings. Still one transaction, still
  rolls back, still asserts: cross-company claim refused (42501), own-company claim works,
  service role claims for any company, search_path pinned.
- `tests/db/business-credit-owner-only.sql` — its counts covered the whole table
  ("owner reads 7 rows, expected 1" live: the owner's real vendor rows). Both counts are
  now scoped to the fixture company the check itself creates. Still asserts a driver in the
  same company reads 0 and cannot write, and the owner reads and writes.
