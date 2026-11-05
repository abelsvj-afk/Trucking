# Wave 4 preparation — tenant-isolation and service-role test matrix (DESIGN ONLY)

Status: 2026-11-05, generated from `supabase/migrations/*.sql` and `tests/integration/rls-tenant-isolation.test.ts` on `main`. **Nothing here has been executed.** The existing suite needs a live Supabase project and cannot run from the Claude sandbox (documented network block to `*.supabase.co`); executing it is **owner decision D-3** (who runs it, against which project — King can run it from his lane). Migration live status per audit addendum §11.1.

## 1. Summary
- Tables created by migrations: **62**. All have RLS enabled and at least one policy (verified by script, no exceptions).
- Tables the existing integration suite exercises by name: **30**. Tables with **no** isolation test: **32** (listed below).
- Tables without `company_id` (global): companies, research_runner_heartbeat, research_watcher_state — need a *read-only-for-tenants* test, not an A/B isolation test.
- Tables with job-role `using (true)` policies (cross-company by design): the research family and industry briefing tables — need a test that **tenant roles cannot write** and that the job role is the only writer.

## 2. Per-table matrix

"Policy" = the policies found in migrations. "Test" = does the existing suite touch the table. "Needed" = the tests Wave 4 must add (A/B = company A cannot read/insert/update/delete company B's rows; anon = unauthenticated denied; svc = a service-role code path touches it, so a code-scoping test is also needed).

| Table | Created | Policies | Test now | Needed |
|---|---|---|---|---|
| `companies` | 00001 | read own company; update own company | yes | tenant read-only; anon denied |
| `user_profiles` | 00001 | read own profile | yes | already A/B; add anon-denied if missing |
| `trucks` | 00002 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `trailers` | 00002 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `drivers` | 00002 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `customers` | 00002 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `brokers` | 00002 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `loads` | 00003 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `expenses` | 00003 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `fuel_purchases` | 00003 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `maintenance_events` | 00003 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `documents` | 00004 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `industry_briefings` | 00005 | read own company's briefings; dismiss own company's briefings; industry_briefing_job full  | yes | already A/B; add anon-denied if missing; job-role-only writes |
| `industry_briefing_runs` | 00008 | read own company's run log; industry_briefing_job full access to its own write tables | yes | already A/B; add anon-denied if missing; job-role-only writes |
| `ai_capability_settings` | 00008 | manage own company's AI capability settings; industry_briefing_job reads capability settin | yes | already A/B; add anon-denied if missing; svc: code-scope test; job-role-only writes |
| `maintenance_schedules` | 00010 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `equipment_checklist_items` | 00010 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `pretrip_inspections` | 00010 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `duty_logs` | 00011 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `dispatch_exchanges` | 00012 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `telegram_messages` | 00013 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `bot_memories` | 00014 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `bot_pending_actions` | 00016 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `research_signals` | 00019 | read global and own research signals; research job full access to research_signals | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test; job-role-only writes |
| `research_watcher_state` | 00019 | read watcher health; research job full access to research_watcher_state | **no** | tenant read-only; anon denied |
| `research_runs` | 00019 | read own company's research runs; queue a manual research run for own company; research jo | yes | already A/B; add anon-denied if missing; svc: code-scope test; job-role-only writes |
| `research_briefings` | 00019 | read own company's research briefings; mark own company's research briefings read or dismi | yes | already A/B; add anon-denied if missing; svc: code-scope test; job-role-only writes |
| `fund_entries` | 00023 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `fund_settings` | 00023 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `business_ladder_steps` | 00023 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `account_snapshots` | 00023 | tenant isolation | yes | already A/B; add anon-denied if missing |
| `game_targets` | 00024 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `game_plans` | 00024 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `game_plan_runs` | 00024 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `game_checkpoints` | 00025 | tenant isolation | yes | already A/B; add anon-denied if missing; svc: code-scope test |
| `conversation_summaries` | 00032 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `consolidation_runs` | 00032 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `telegram_processed_updates` | 00033 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `research_runner_heartbeat` | 00040 | read runner heartbeat; research job full access to research_runner_heartbeat | **no** | tenant read-only; anon denied |
| `research_health_alerts` | 00040 | read own and global research health alerts; research job full access to research_health_al | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test; job-role-only writes |
| `research_corridor` | 00040 | read own company's research corridor; research job full access to research_corridor | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test; job-role-only writes |
| `research_requests` | 00040 | read own company's research requests; research job full access to research_requests; queue | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test; job-role-only writes |
| `cleanup_incidents` | 00041 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `vehicle_defects` | 00046 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `maintenance_watch_runs` | 00046 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `settlements` | 00048 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `settlement_lines` | 00048 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `settlement_load_links` | 00048 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `pay_report_runs` | 00048 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `forward_threads` | 00049 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `forward_thread_messages` | 00049 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `load_decisions` | 00050 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `detention_stamps` | 00052 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `facilities` | 00053 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `credentials` | 00054 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `load_invoices` | 00055 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `recurring_obligations` | 00056 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `broker_followups` | 00057 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |
| `driver_positions` | 00060 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `load_tasks` | 00061 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `load_stops` | 00062 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied; svc: code-scope test |
| `employer_pay_profiles` | 00063 | tenant isolation | **no** | A/B select+insert+update+delete; anon denied |

## 3. Service-role path tests (the part RLS cannot prove)

Each path below runs with RLS bypassed and scopes to a company only in code. For each, the test seeds two companies, runs the path configured for company A, and asserts no company-B row is read or written, and that an unconfigured company id fails closed:

1. Telegram webhook → `createTelegramStore` / brain store (history, memories, pending actions, exchanges, threads, positions, settlements, pay profile reads).
2. `services/game/scheduler` (service-role client).
3. Memory consolidation, pay-report, maintenance-watch, research delivery (all build the Telegram brain store).
4. `/api/internal/*` invokers: wrong/missing secret → 401, correct secret scoped to the configured company.
5. `financial-summary-pool` and `industry-briefing-pool` roles: least-privilege grants (list the exact grants; prove no write outside intended tables).
6. `driver_positions` upsert is keyed `(company_id, source)`; a second company never overwrites the first.

**Status (2026-11-05):** item 1 is covered at the *query* level by `tests/unit/services/bot/store-company-scope.test.ts` - a recording client drives every method of the brain store AND every bot tool and asserts each executed query is scoped to the configured company (reads/updates/deletes carry `company_id`, writes stamp it). Mutation check: removing one `.eq("company_id", ...)` from `loadMemories` fails it. It does not read a real database, so it proves no query *asks* for another company's rows, not that two seeded companies stay separate end to end; items 2-6 remain open.

## 4. Other Wave 4 gates to design (from the audit)

- E2E for critical journeys: dispatch→load→trip tasks; paper-log photo→review→save; Drive start→off-route→reroute; pay terms add/change.
- AI evals: grounding; language gate (English sender never gets a Spanish draft); proposal identity (bare yes targets last-shown); stale/multiple proposals; failed write retains proposal; cancel≠delete; forwarded-text injection (gap G3); memory.
- Safety acceptance SAF-1..4 (requirements addendum) as scripted tests.
- Drift checks: tools↔authority matrix, routes↔api-contracts, tables↔schemas.md, `LIVE_TABLES`↔publication.
- Accessibility (WCAG 2.1 AA already pinned by the contrast guard) and a phone-width performance budget (owner decision D-5).
- Reviewer sign-off on the exact candidate tree, with persisted gate logs.

> **Update 2026-11-05:** `tests/db/rls-isolation.sql` now exercises every table below as well as the 30 already covered by the API-level suite (see `tests/db/README.md`). The API-level suite remains for end-to-end checks.

## 5. Untested tables (no isolation test today)
`maintenance_schedules`, `equipment_checklist_items`, `pretrip_inspections`, `research_signals`, `research_watcher_state`, `conversation_summaries`, `consolidation_runs`, `telegram_processed_updates`, `research_runner_heartbeat`, `research_health_alerts`, `research_corridor`, `research_requests`, `cleanup_incidents`, `vehicle_defects`, `maintenance_watch_runs`, `settlements`, `settlement_lines`, `settlement_load_links`, `pay_report_runs`, `forward_threads`, `forward_thread_messages`, `load_decisions`, `detention_stamps`, `facilities`, `credentials`, `load_invoices`, `recurring_obligations`, `broker_followups`, `driver_positions`, `load_tasks`, `load_stops`, `employer_pay_profiles`

> Added after generation: `reminder_sends` (migration 00065, tenant isolation policy) — needs an A/B isolation test like the others; and the service-role reminder scheduler needs a code-scope test.
