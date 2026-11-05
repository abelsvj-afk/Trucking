# Database tests (SQL)

`rls-isolation.sql` — tenant isolation across **every** table that has a `company_id` (60 today). One transaction, rolls back, leaves nothing. For each table it builds a **complete** row (every NOT NULL column filled), so a refusal can only be the row-level-security refusal (SQLSTATE 42501), never a constraint failure that fired first. As company A's logged-in user it proves:
1. a cross-company INSERT (`company_id` = B) is refused by RLS;
2. an own-company INSERT is allowed where the table is tenant-writable and refused where it is read-only for tenants (research family, `user_profiles`; `research_runs` / `research_requests` also fence the row's shape);
3. **anon** cannot write — same complete row, login claim **cleared**, and anon's INSERT privilege granted *inside the transaction* when migration 00067 has revoked it, so the refusal that is counted is the RLS one;
4. where a company-B row could be seeded, A reads 0 / updates 0 / deletes 0 of them and anon reads 0.
Probes stopped by a constraint before RLS could decide are listed as **UNPROVEN** — not violations, and not counted as passes. The run prints the proven counts (scratch run: 60/60 cross-company refusals and 60/60 anon refusals proven by RLS, 0 unproven, 0 violations).

`anon-privileges.sql` — check 5: `anon` holds no write privilege on any public table (migration 00067). Empty result = pass. (Before 00067 on scratch it listed 378 grants; after, 0; tables created later also get none.)

**What the earlier "four anonymous-write tables" were.** The first version of this test set company A's login claim and never cleared it before the anon probe, so "anon" was really A's user; only the four tables whose bare `company_id` row is already complete (`consolidation_runs`, `forward_threads`, `fund_settings`, `maintenance_watch_runs`) could finish the insert. Reproduced on scratch with Supabase-like grants (anon: full privileges) — the same four accepted until the claim was cleared, then all 60 refused. I cannot prove the live run had the same cause (King's patched copy may differ), which is why migration 00067 removes anonymous write privileges outright and the re-run uses this corrected file. Mutation check: replacing `trucks`' policy with `using (true)` is reported as 6 violations (cross-company insert, read, update, delete, anon insert, anon read); restoring it returns 0.

**Scratch setup order:** Supabase stub -> `tests/db/scratch-supabase-defaults.sql` (grants like Supabase: anon/authenticated start with full privileges, so RLS is what's tested) -> all migrations -> `tests/db/scratch-auth-shim.sql` -> the tests.
```
psql -d scratch -f tests/db/scratch-auth-shim.sql -f tests/db/rls-isolation.sql
psql -d scratch -f tests/db/anon-privileges.sql
```
**Live run** (King; owner decision D-3): paste `rls-isolation.sql`, then `anon-privileges.sql`, into the Supabase SQL editor. The first rolls back. Seeding needs `session_replication_role`; where the project forbids touching it, seeding and its reset are skipped without aborting (the reset is wrapped) and checks 1-3 still run. Do NOT run the two `scratch-*.sql` files on the live project.

What this does NOT cover: service-role code paths (the webhook, schedulers, internal invokers scope by company in code — `docs/reconciliation/wave-4-test-matrix.md` §3), storage-bucket policies, and Realtime delivery.

`tenant-fk.sql` — Unit E (migration 00070): completeness (no single-column tenant FK remains; 63 composite `(company_id, fk) → (company_id, id)` FKs, all validated) and behavior (cross-company references refused with 23503 under a role that bypasses RLS; same-company accepted). Run as a privileged role. `documents-trigger.sql` — Unit E (migration 00071): bad document references rejected with byte-identical errors (no oracle), good ones accepted. Scratch results: 63/63 conversion, 7/7 refusals, 4/4 identical rejections; mutation check (reverting one FK to single-column) fails the completeness test; seeding one cross-company row makes `00070` abort in its pre-flight.
