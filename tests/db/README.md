# Database tests (SQL)

`rls-isolation.sql` — tenant isolation across **every** table that has a `company_id` (60 today). One transaction, rolls back, leaves nothing. For each table it proves, as company A's logged-in user:
1. a cross-company INSERT (`company_id` = B) is refused by RLS (SQLSTATE 42501);
2. an own-company INSERT is allowed by RLS where the table is tenant-writable, and refused where it is read-only for tenants (the research family, `user_profiles`) — `research_runs` / `research_requests` are exempted from the "allowed" half because their policy also fences the row's shape;
3. `anon` cannot write;
4. where a company-B row could be seeded (56 of 60 on the scratch run; `equipment_checklist_items`, `maintenance_schedules`, `pretrip_inspections`, `vehicle_defects` have multi-column constraints the generic seeder can't satisfy), A's user reads 0, updates 0 and deletes 0 of B's rows.

It prints one line per table and raises on any violation. Its power was checked by mutation: replacing `trucks`' policy with `using (true)` made it report 4 violations (cross-company insert, read, update, delete); restoring the policy returned 0.

**Scratch run** (any Postgres with all migrations applied + the Supabase stub):
```
psql -d scratch -f tests/db/scratch-auth-shim.sql -f tests/db/rls-isolation.sql
```
**Live run** (King; owner decision D-3): paste `rls-isolation.sql` into the Supabase SQL editor. It rolls back. Step 4's seeding needs superuser (`session_replication_role`); on a managed project that step reports "seed skipped" and checks 1–3 still run. Do NOT run `scratch-auth-shim.sql` on the live project.

What this does NOT cover: service-role code paths (the Telegram webhook, schedulers, internal invokers scope by company in code — separate tests, `docs/reconciliation/wave-4-test-matrix.md` §3), storage-bucket policies, and Realtime delivery.
