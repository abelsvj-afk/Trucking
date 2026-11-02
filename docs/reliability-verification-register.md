# Trucking — Pre-Flight Reconciliation + Independent Verification Register (ALL 53)

**Program:** Trucking Reliability & Completion Program · **Checklist:** Trucking-Audit-Fix-Checklist.md
**Date:** 2026-10-31 · **Method:** read-only. No code edited, no merge/push/deploy, no GitHub Actions, full test suite NOT run (per orders).
**Evidence base:** `git fetch` 2026-10-31 + `git archive origin/main` extracted and branch trees via `git show/grep`. All file:line are **origin/main @ 7e03ed3** unless a branch is named. Audit severities retained — **no severity changes** (one watch-note on F-036).

---

## 1. Inventory — P-01 (branches / merged vs branch-only)

**Current main:** `7e03ed3eb011f3ff3c34d6b6e5291b97dbb0a2d4` — "Merge PR #4 from smart-path-v1" (2026-10-31 18:22 ET). Local clone was stale at `fcf4b6a`; origin/main is 3 commits ahead (PR #3 merge `deb222d`, smart-path `f6a7d3a`, PR #4 merge).
**Live deploy (P-02):** cannot be established from the repo — **but** a MEMORY.md update recorded mid-pass records Fly release **v15 = main @ 7e03ed3**, server-verified (both machines on `trucking:manual-7e03ed3`, `/forgot-password` 200). Treat P-02 as settled-by-that-record, pending ChatGPT accepting it; it post-dates ChatGPT's audit snapshot.

| Remote branch | HEAD | vs main | Status |
|---|---|---|---|
| `driver-mvp-telegram` | `6df1e2e` | ancestor of main | **MERGED** (PR #3, `deb222d`) |
| `smart-path-v1` | `f6a7d3a` | ancestor of main | **MERGED** (PR #4, `7e03ed3`) |
| `bot-intelligence-v2` | `dd872169` | base `deb222d`; 1 commit not in main; main has 2 it lacks | **BRANCH-ONLY** |
| `agent-omnipresence` | `66e00604` | stacked on v2 (`dd87216`+`66e0060`); base `deb222d` | **BRANCH-ONLY** (merge order: v2 first) |
| `smart-path-truck-routing` | `fcedc4e2` | base `f6a7d3a`; 1 commit not in main; only main commit it lacks is the PR#4 merge commit itself | **BRANCH-ONLY** — cleanest next merge (content diff = routing only) |
| `research-engine` | `3b952cc1` | base `deb222d`; 1 commit not in main | **BRANCH-ONLY** |
| `document-scan` | `e55c96c0` | base `6df1e2e` (pre-PR#3-merge); 1 commit not in main | **BRANCH-ONLY** — oldest base; expect rebase/cherry-pick care |
| `claude/claude-md-docs-6sd2wz` | `e6763a58` | Aug 23 | Legacy, not part of 2026-10-31 program |
| `flyio-new-files` | `b355e3ed` | Aug 21 | Legacy scaffold |

## 2. True migration map — P-03

| Migration | main | v2 | omnipresence | research | doc-scan | truck-routing | Live DB* |
|---|---|---|---|---|---|---|---|
| 00001–00014 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (00011–14 applied 2026-10-31) |
| 00015 `conversation_channel`, 00016 `bot_pending_actions` | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ applied |
| 00017 `truck_profile` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ applied |
| **00018** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **Exists in NO branch tree.** research 00019 header says "00017/00018 reserved for Smart Path" — only 00017 was ever written. Gap is a reservation, not a lost migration (repo-side proof). |
| 00019 `research_engine` | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ applied |
| **00020** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **Exists in NO branch tree** — same reservation-gap pattern. "Live through 00022" = highest number, **not contiguous**. |
| 00021 `pending_action_batches` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ applied |
| 00022 `document_scan_and_extraction` | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ applied |

**ERRATUM (Challenge Round 1, 2026-10-31):** the table above incorrectly marks migration 00022 as present on agent-omnipresence. Direct re-check: agent-omnipresence contains NO 00022 file (its highest migration is 00021); `00022_document_scan_and_extraction.sql` exists only on document-scan (sha256 `5bf74123ecd33a9c…`). There is no duplicated 00022. All other cells stand as reported.

\*Live column = recorded fact in memory (Supabase SQL Editor runs 2026-10-31, all "Success"), not independently verifiable from repo. **Consequence:** live DB is a superset of every branch; no single branch tree matches live schema. Each branch merge is individually safe (its migration is already live), but inter-branch migration sets are disjoint — union on final main must be 00001–00017 + 00019 + 00021 + 00022.

## 3. RE-VERIFY findings — what already exists on branches

- **F-018 (OCR/extraction) — CHANGED on branch, not a rebuild.** `document-scan@e55c96c`: migration 00022 adds `scan_storage_path, doc_type (bol/rate_confirmation/scale_ticket/fuel_receipt/settlement/other), extracted_text, extracted_fields, extraction_status, extracted_tsv` (generated tsvector + GIN index). Extraction is Settings-gated (ships off), scan rendition keeps original. **Remains:** merge (oldest base — rebase care) + gate + live verification with one real BOL photo (vision path never live-verified; PDFs get no scan/extraction, HEIC gets no scan — documented bounds, not defects).
- **F-020 (industry-briefing scheduler) — CANNOT VERIFY FROM REPO; research-engine does NOT close it.** Main's original engine remains env-dependent: `src/services/db/industry-briefing-pool.ts:16-18` throws if `INDUSTRY_BRIEFING_DB_URL` unset; `src/app/api/internal/industry-briefing/run/route.ts:18` needs `INDUSTRY_BRIEFING_CRON_SECRET`; `src/services/ai/scheduler.ts:18`. `research-engine@3b952cc` is a **separate** system (00019, `src/services/research/scheduler.ts`, watchers EIA/Federal Register/RSS) — it does not verify the original briefing job role/credential/runs. **Settles only with:** live `industry_briefing_runs` query + role config + one triggered run.
- **F-021 (bot narrow snapshot) — CHANGED on branches, substantially closed in code.** Main is snapshot-bound (see register). `bot-intelligence-v2@dd87216`: tool-calling loop (`src/services/ai/agent-loop.ts`, `MAX_AGENT_STEPS=6`), 7 read + 5 write tools in `src/services/bot/tools.ts:39-447` (`list_loads, hos_summary, money_summary, list_contacts, list_documents, search_memories, search_dispatch_exchanges` + writes as proposals). `agent-omnipresence@66e0060`: ~51 tools across `tools-read.ts/tools-write.ts/tools.ts` — every entity read+write (loads, expenses, fuel, brokers, customers, drivers, trucks+profile, trailers, inspections, checklists, maintenance events/schedules, duty logs, documents incl. `search_documents`/`get_document`, memories, industry briefings), Zod-validated, deletes always proposal+yes, plus `stage_dump_items` batch intake (00021). It also fixed a real v2 bug (`list_documents` filtering on non-existent `documents.deleted_at`). **Remains:** merge v2→omnipresence (rebase over Smart Path main move), gate, live numeric-grounding QA (NV-6). No invoices/settlements table exists on any branch — bot correctly says so.
- **F-039 (truncated bot context) — CHANGED/PARTIALLY on branches.** Main: `src/services/telegram/store.ts:47` history limit 20, `:38` contacts 25, `:77` memories 100, `:102` active loads 5, `:109` duty logs 100. On v2/omnipresence the snapshot is no longer the bot's only knowledge — on-demand tool retrieval replaces stuffing for factual questions (agent-turn + tools above). Snapshot limits still exist in the v1 code path the branches inherit. **Remains:** merge + live proof that out-of-snapshot questions trigger tool calls, not guesses.
- **F-040 (no search/filter, no export) — PARTIALLY CHANGED, narrowly.** Only on `document-scan`: Documents page full-text search (`src/app/(app)/more/documents/page.tsx:144-175`, `GET /api/v1/documents?q=` → `textSearch("extracted_tsv",…)` at route.ts:146 on that branch). On main, grep of loads/expenses/documents pages finds **zero** search UI; no branch adds search to loads/expenses/fuel/HOS lists, and **no export/backup exists on any branch**. Remainder is genuinely still to build.

## 4. Spot-checks of top Wave 1 items on main — all still true

- **F-001:** grep of 11 list pages (hos, loads, expenses, fuel, maintenance-events, pretrip, trucks, trailers, drivers, brokers, customers) — only links are "Add/Log…" + loads' "Route check" (`loads/page.tsx:61`). Zero edit/delete controls. API does have them: `src/services/api/crud-routes.ts:59-71` (update/remove).
- **F-007:** `src/app/api/v1/financial-summary/route.ts:20-27` `currentMonthRange()` uses `getUTCFullYear/getUTCMonth/Date.UTC`.
- **F-011:** `src/app/(app)/fleet/hos/new/page.tsx:20` `useState(() => new Date().toISOString().slice(0,16))` feeding `datetime-local` at :95-99.
- **F-013:** `src/app/(app)/fleet/hos/page.tsx:27` `useApiList("duty-logs",{limit:"200"})`, summary at :29-30 computed from that array only; underlying list order is `created_at desc` (`src/services/db/crud.ts:48-50`), not `started_at`.
- **F-053:** `src/data/schemas/fuel-purchases.ts:3-10` — gallons/price/total are three independent fields, no `.refine`; form enters total independently (`fuel-purchases/new/page.tsx:37-39`); summary sums `total_cost_cents` (financial-summary route.ts:78,107-109).

---

## 5. Verified findings register

### P1 (19)

- **F-001 CONFIRMED** — Evidence §4 above. Root: shared detail/edit/delete UI pattern was never built; only create+list screens exist (no `[id]` UI route under `src/app/(app)/loads/` — only `new/`+`page.tsx`). *Design: one shared record-detail route pattern per entity (view→edit form reusing create schemas→delete with confirm), rolled out entity-by-entity starting duty logs + expenses.*
- **F-007 CONFIRMED** — financial-summary route.ts:22-26 (above). At 2026-10-31 20:00 ET, UTC is already Nov 1 → "this month" flips ~4-5h early. *Design: compute month bounds in America/New_York (viewer tz), convert to query instants server-side; unit test at month-boundary 00:30 ET.*
- **F-008 CONFIRMED** — route.ts:97 `effectiveDate = delivery_date ?? pickup_date`, full `rate_cents` counted in that one month (route.ts:94-101); summary UI (`money/summary/page.tsx:53-54`) labels it only "Revenue". *Design: owner picks convention (delivery-date is defensible); label it in UI ("Revenue — counted on delivery date") and in API response.*
- **F-009 CONFIRMED** — No per-load P&L anywhere: summary is period-only (route.ts:115-122); fuel has no `load_id` (F-023), maintenance is truck-only (00003:59-60). *Design: contribution-margin model first (rate − load-linked expenses − allocated fuel), allocation rule documented before any UI number.*
- **F-010 CONFIRMED** — route.ts:64-88 four independent queries, response (115-122) returns only cents totals, no source IDs. *Design: summary response gains drill-down (record IDs or a `/financial-summary/detail` endpoint); every total tappable to its rows.*
- **F-011 CONFIRMED** — §4. Save path converts local→ISO correctly (hos/new:40), so defect is the initial value only. *Design: initialise `datetime-local` from local components (pad `getFullYear/Month/Date/Hours/Minutes`), shared helper + test.*
- **F-013 CONFIRMED** — §4; also `crud.ts:36` default limit 50 / range at :50. *Design: HOS queries a time-window (e.g. last 9 days for the 8-day calc, ordered `started_at`) via a dedicated query, not the generic list cap.*
- **F-016 CONFIRMED** — Loads default `draft` (00003:21; `loads/new/page.tsx:42,67` status selectable at create), API PATCH exists (crud-routes.ts:59-65) but no edit UI (F-001 evidence). *Design: lands with F-001 pattern; load detail shows what's missing for draft→confirmed.*
- **F-023 CONFIRMED** — `fuel-purchases.ts:4` schema has only `truck_id`; 00003 fuel table likewise; expense schema by contrast has `load_id` (`expenses.ts:10`). *Design: add nullable `load_id` to fuel (migration + RLS review), optional at entry, prompt-but-don't-force; backfill none.*
- **F-024 CONFIRMED (Wave 2 per charter)** — 00004:8-9 `related_entity_id uuid not null` with **no FK**; documents route.ts:59-63 validates UUID syntax only, never existence/company. *Design: server-side existence+company check on upload (404-style rejection), keep polymorphic shape short-term; composite FK is the long-term option to weigh.*
- **F-028 CONFIRMED** — `maintenance-schedules.ts:50-63` and `pretrip-inspections.ts:24-30`: update refinements skip or evaluate only submitted fields (e.g. PATCH `{truck_id:null}` alone passes pretrip refine because `trailer_id===undefined` short-circuits differently — merged row can end with neither/both, surfacing as raw DB CHECK error from 00010:25/59). *Design: on PATCH, load existing row, merge, validate full record with create schema, return field-level 422.*
- **F-029 CONFIRMED** — `src/lib/use-picker-list.ts:18` `.catch(() => setItems([]))`, no error/loading state returned (:21 returns array only). *Design: hook returns `{items,status,retry}`; pickers render explicit error/retry; S-effort quick win.*
- **F-033 CONFIRMED** — financial-summary route.ts:64-88: four `.from(...).select(...)` queries with **no `.range()`/count check**; sums whatever PostgREST returns (route.ts:40-42,101-113). *Design: DB-side aggregate (RPC/view) or paginated fetch with `count:"exact"` assertion; fail loud on mismatch.*
- **F-036 CONFIRMED (structure) / live exploit CANNOT VERIFY** — FKs are single-column (`00002:38` `assigned_truck_id references trucks(id)`; 00003:11-14,34-36; 00011:11-12) — no composite `(company_id,id)`; crud create inserts body-supplied FKs (`crud.ts:73-77`). RLS hides other-company rows on read, but doesn't validate FK ownership on insert. **Severity watch:** audit says P1; charter's P0 = "cross-company exposure" — keep P1 unless NV-3 two-company attack test proves a readable/writable cross-tenant link, then escalate with that evidence. *Design: same-company validation in service layer for all FK fields (cheap) + composite FKs/unique `(company_id,id)` as migration follow-up.*
- **F-037 CONFIRMED in code / CANNOT VERIFY live** — Pages exist (`forgot-password/page.tsx:28` `resetPasswordForEmail`), but `PROJECT_STATE.md:176-181,190` records the two dashboard actions (token_hash email template + Site URL `https://trucking.fly.dev`) as owner-pending, and :206 still repeats it. Note PROJECT_STATE is stale (F-050), so this may already be done live. *Settles with: one real reset email end-to-end on v15 (NV-4). Design: none — config + proof, keep as gate.*
- **F-046 CONFIRMED (Wave 2)** — `src/app/(app)/page.tsx:3-7` header comment defers recent activity/quick-add; body (:26-47) is only the month money card. No current load/duty/truck state. *Design: operational snapshot card (current load, current duty status, today's inspection) above the money card, from existing APIs.*
- **F-048 CONFIRMED (Wave 2)** — No load-detail UI route exists (F-001 evidence); related data lives on separate pages (documents page, hos page, expenses page). *Design: `/loads/[id]` aggregating load + linked expenses, duty logs, documents; fuel joins after F-023.*
- **F-049 CONFIRMED (Wave 2)** — Same root as F-010/F-033: summary returns totals only (route.ts:115-122), lists paginate independently (`crud.ts:36,50`). *Design: shared with F-010 drill-down; reconciliation test = sum(drill-down rows) == total.*
- **F-053 CONFIRMED** — §4. *Design: form computes total from gallons×price (editable override requires explicit adjustment reason), schema `.refine` tolerance (rounding to cent); summary keeps using stored total once invariant holds.*

### P2 (30)

- **F-002 CONFIRMED** — `crud.ts:100-108` softDelete sets `deleted_at`; grep for `restore|undelete|recycle|archive` in src = 0 hits. *Design: deleted-records view with restore (clears `deleted_at`) per entity, or explicit permanent policy in docs.*
- **F-004 CONFIRMED (code) / live orphan CANNOT VERIFY** — `documents/[id]/route.ts:24-27` comment admits failure leaves orphan; :27 `storage.remove()` result never inspected. *Design: check remove result, log + retry queue/metric on failure.*
- **F-005 CONFIRMED** — `crud.ts:100-108` discards update result (no `.select()`); crud-routes.ts:67-71 unconditionally returns 204. Nonexistent/RLS-invisible ID = silent no-op success. *Design: `.select("id")`, 404 when zero rows (mirrors update at crud.ts:88-97).*
- **F-006 CONFIRMED** — No idempotency anywhere: grep `idempot` in src = only an unrelated scheduler comment (`services/ai/scheduler.ts:29`); create path crud-routes.ts:45-50 → crud.ts:68-81 plain insert. Form disable-on-submit is the only guard. *Design: client submission token + unique index per entity, or dedupe window — decide per entity (money records first).*
- **F-012 CONFIRMED** — `fuel-purchases/page.tsx:32` renders `{purchase.purchased_at}` raw. *Design: shared formatter (with F-043).*
- **F-015 CONFIRMED** — `src/lib/hos.ts:36` `EIGHT_DAYS_MS = 8*24*60*MINUTE_MS`, used :150 as rolling `now-192h` sum; no 60h/7d option anywhere in file. Disclaimer (F-014) keeps this P2, not P1. *Design: document supported cycle explicitly in UI/docs; add 60/7 config only if owner's carrier cycle needs it.*
- **F-017 CONFIRMED** — documents route.ts:23-38 header comment states declared-type-only is deliberate; :50 checks `file.type`. *Design: magic-byte sniff for PDF/JPEG/PNG/WebP/HEIC on server; keep allowlist.*
- **F-018 CHANGED — see §3.** On main CONFIRMED (00004 has no extraction columns). Branch-complete; remaining = merge + gate + live BOL test.
- **F-020 CANNOT VERIFY FROM REPO — see §3.** *Design: none until live run history is inspected (NV-7).*
- **F-021 CHANGED — see §3.** On main CONFIRMED: `telegram/store.ts` snapshot limits + `services/ai/bot-chat.ts` answers from snapshot only.
- **F-025 CONFIRMED (Wave 2)** — Documents only via More→Documents with entity pickers (`more/documents/page.tsx:28,57-59,131-158`); loads page has no document link (loads/page.tsx:57-63). *Design: lands inside F-048 load detail.*
- **F-026 CONFIRMED** — 00003:1-6 header explicitly says non-negative/date rules "deliberately not duplicated here as DB check constraints"; invariants live only in Zod (`loads.ts:20-21`, `expenses.ts:7`, `fuel-purchases.ts:6-8`). *Design: add CHECK constraints mirroring Zod for money/miles in a new migration; keep Zod for error quality.*
- **F-027 CONFIRMED (Wave 3)** — `expenses.ts:3` enum = `insurance|permits|repairs|other` only. *Design: expand taxonomy (tolls, parking, scale, meals, lodging, factoring, dispatch, driver pay, truck payment) with migration-safe enum/text change + label map.*
- **F-030 CONFIRMED (Wave 2)** — `maintenance-events/page.tsx:23` `truckLabel = … ?? id` (raw UUID fallback); pretrip `vehicleLabel` at page.tsx:25 same pattern via picker lists that can fail silently (F-029). *Design: store/display fallback "Truck (record unavailable)" + distinguish lookup-failed vs deleted; long-term denormalised label snapshot.*
- **F-031 CONFIRMED** — `crud.ts:36` default limit 50, `crud-routes.ts:29` default 50; list pages render only `result.data` and ignore `page.total` (e.g. fuel page.tsx:13,28-37). *Design: pagination or "Showing X of Y" + load-more in shared `useApiList` pattern.*
- **F-032 CONFIRMED** — `use-picker-list.ts:16-18` limit 200, `result.data` only, total ignored, errors swallowed (F-029). *Design: with F-029 rework — searchable picker fetching by query.*
- **F-034 CONFIRMED** — `use-api-list.ts:30-48` and `use-financial-summary.ts:22-38` fetch on mount only; no cache/invalidation bus in `api-client.ts`. *Design: lightweight mutation→refetch signal (event/custom hook) for list+summary after create/update/delete.*
- **F-035 CONFIRMED** — `crud-routes.ts:29-30` `Number(param ?? 50)` unclamped (NaN/negative/huge flow into `crud.ts:50` range). *Design: central parse — integer, 1–200 clamp, 422 on NaN.*
- **F-038 CONFIRMED (code)** — documents route.ts:100-102 upload-rollback `storage.remove()` result unchecked (same defect class as F-004). *Design: shared with F-004 fix.*
- **F-039 CHANGED/PARTIAL — see §3.**
- **F-040 PARTIALLY CHANGED — see §3.** Main lists have no search (loads page has status filter only, :34-45); no export on any branch.
- **F-041 CONFIRMED (Wave 2)** — `fleet/page.tsx:18-49` is a link list of 10 separate surfaces; no daily aggregation. *Design: daily-ops view (truck/trailer/inspection-today/current status/due maintenance/current load) composing existing APIs.*
- **F-042 CONFIRMED** — Shared states exist (`components/ListStates.tsx:33-51` ListEmpty/ListError) and most lists pass an action, but picker-fed screens manufacture false empties via F-029, and ListEmpty has no error variant distinction. *Design: standardise after F-029; empty states name the next tap (already true for loads/expenses/fuel — preserve).*
- **F-043 CONFIRMED** — hos page:75 `toLocaleString()`, pretrip page:69 `toLocaleDateString()`, expenses page:39 raw `expense_date`, fuel page:32 raw timestamp, maintenance page:52 raw `service_date`. Five screens, four conventions. *Design: one `formatDate/formatDateTime` (viewer tz) in lib, applied everywhere.*
- **F-044 CONFIRMED** — No common detail convention: no `[id]` UI routes for standard entities (F-001 evidence); only loads have a row-level secondary action (Route check). *Design: same build as F-001.*
- **F-045 CONFIRMED** — No global search: grep `search` in `src/app/(app)` = only Smart Path's `useSearchParams` and (on branch) document search. *Design: per-list search first (F-040), cross-entity search later in More.*
- **F-047 CONFIRMED** — Same evidence as F-034 (home uses `use-financial-summary.ts`, mount-only). *Design: with F-034.*
- **F-050 CONFIRMED** — `PROJECT_STATE.md:206` "Last Updated: 2026-08-21" while the same file's top now contains 2026-10-31 Driver MVP/Smart Path/bot-v1 sections — internally contradictory, and its "not yet live / not applied" notes for 00011-00017 are superseded by the 2026-10-31 live applies + v15 deploy. *Design: rewrite state section from current main/branch/live facts (this report is a source), date it, add deploy SHA.*
- **F-051 CONFIRMED (file) / success CANNOT VERIFY** — `.github/workflows/fly-deploy.yml` exists on main and its header claims "CI is the only deploy path that actually works" — directly contradicting the owner's standing ban and the proven manual v15 deploy. *Design per settled owner rule: remove/disable the workflow, document manual `fly deploy` (buildah→registry→`flyctl deploy --image`) as sole process. Do NOT make Actions work.*
- **F-052 CANNOT VERIFY FROM REPO (not executed this pass)** — Suite exists (47 test files: unit schemas/hos/maintenance/smart-path/bot/api, 1 RLS integration, 9 Playwright specs; `package.json:13-14`). PROJECT_STATE.md top section records 5.1/5.2 suites as written-but-blocked from executing in sandbox. *Settles with: P-04 run on merged tree with persisted counts (NV-9).*

### Cleared items — independently re-checked (4)

- **F-003 CLEARED — CONFIRMED, agree.** 00002:77-94, 00003:76-89, 00004:19-20, 00010:67-76, 00011:29-30 all `FOR ALL USING/WITH CHECK (company_id = current_company_id())`. Soft-delete is an UPDATE (`crud.ts:101-105`), so no DELETE policy is needed. F-001's root cause is missing UI, not RLS. Do not regress.
- **F-014 CLEARED — CONFIRMED, agree.** `lib/hos.ts:4-10` header, `hos/page.tsx:36-39` ("ELD/official log wins"), `hos/new/page.tsx:58` — non-ELD boundary is explicit at every surface. (Calculation *completeness* is F-013/F-015, separate.)
- **F-019 CLEARED — CONFIRMED, agree.** `more/dispatch/page.tsx:89-90` "Nothing is ever sent for you", :145-149 `actual_reply_sent` is user-pasted and labelled as such. No send path exists in the page.
- **F-022 CLEARED — CONFIRMED, agree, with omnipresence note.** 00014:13-14 `kind IN ('fact','note','expense_hint','instruction')` — a hint is a memory kind, never an expense row. On omnipresence, pending actions (00016/00021) preserve propose→yes separation; re-check at merge that dump-intake staging cannot book an expense without approval (its tests assert this — gate must rerun them).

---

## 6. Coverage statement

- **Verified at repo level: 53/53** (49 with a confirmed/changed verdict above + 4 cleared re-confirmed). Wave-1 regrouped set (F-001–F-016, F-023, F-026, F-028, F-033, F-036, F-037, F-053) is fully evidenced in §4/§5.
- **IDs whose final truth needs live evidence (not repo):** F-020 (scheduler/runs), F-037 (reset email — may already be fixed live; PROJECT_STATE is stale), F-052 (suite execution — P-04/NV-9), plus the live side of F-004/F-038 (actual orphaned objects), F-036 (NV-3 attack test), F-018/F-021/F-039 (post-merge live QA).
- **Not done in this pass (by design):** P-04 test run, P-05 secret-name inventory, any implementation.
