# Trucking Repo — Audit Fix Checklist (canonical, do-not-lose list)

**Source:** ChatGPT forensic audit, received by owner 2026-10-31 ~19:10 EDT (audit prompt from King, same day).
**Repo:** `abelsvj-afk/Trucking`, live at https://trucking.fly.dev/
**Findings:** F-001 → F-053 (49 confirmed/suspicion findings + 4 cleared), 5 user journeys, 14 cleared suspicions, ~27 not-verified gates, Waves 1–4 (37 work orders), Top 5 quick wins.
**Owner's order (2026-10-31):** fix all of it as fast as possible, King ↔ ChatGPT relay, nothing dropped.

## Program charter (added 2026-10-31 ~19:12 EDT — ChatGPT's "Trucking Reliability & Completion Program")

This program is governed as follows, and **this charter supersedes the wave groupings in the original audit roadmap wherever they differ** (the 53 findings themselves do not change):

- **Roles:** ChatGPT = technical architect, audit owner, requirements, task breakdown, independent reviewer, acceptance authority. Muse (implementation crews) = repository investigator + implementation partner: examines code, proposes changes, implements approved tasks, reports test evidence. Owner (Sajacous) = product owner: approves material design decisions, scope changes, documentation decisions, and deployment.
- **Design first, implementation second. Deployment is always a separate owner approval.**
- **Core rule: nothing gets fixed just because the audit labeled it a bug.** Every finding is independently verified against the actual repository first. No new problems introduced while solving old ones.
- **Closure pipeline — every finding must walk all of these, in order, and cannot be CLOSED without evidence at each stage:**
  `NOT VERIFIED → VERIFIED → DESIGN REQUIRED → DESIGN APPROVED → IMPLEMENTATION → TESTING → CODE REVIEW → ACCEPTED → LIVE VERIFICATION → CLOSED`
  Required evidence: original reproduction · root cause · files + exact line numbers · approved design · implementation commit/PR · tests executed + results · regression assessment · live verification where applicable.
- **Program rules (12):** (1) no implementation before design + acceptance criteria; (2) no finding closed merely because code changed; (3) every finding needs file/line evidence; (4) every fix needs appropriate tests; (5) every DB change needs migration + RLS review; (6) every user-facing date/time uses the viewer's local timezone; (7) financial figures must reconcile to underlying records; (8) every created record must have an appropriate correction/deletion lifecycle; (9) no silent failures or misleading success states; (10) no production deployment without explicit owner approval; (11) a passing unit test does not establish that production works; (12) no unrelated refactoring or scope expansion during a task.
- **Severity:** P0 = data loss, cross-company exposure, materially wrong money, serious security failure · P1 = user blocked, records cannot be corrected, materially misleading operational information · P2 = inconsistency, confusing navigation, missing visibility, incomplete workflows · P3 = cosmetic/convenience. Severity changes only with documented reasoning.
- **Required task format:** Finding IDs · problem statement · existing behavior + evidence · desired behavior · architecture impact · DB impact · API impact · UI impact · security/RLS impact · acceptance criteria · unit tests · integration tests where applicable · regression tests · documentation updates · rollback considerations. Tasks independently testable, preferably < 4 hours.
- **ChatGPT's regrouped waves (authoritative):** Wave 1 (data integrity/money/time/CRUD): F-001–F-016, F-023, F-026, F-028, F-033, F-036, F-037, F-053 · Wave 2 (operational workflows): F-024, F-025, F-030, F-041, F-046, F-048, F-049 + Journeys 1–5 + load contribution-margin model · Wave 3 (reliability/validation/usability): F-017, F-018, F-027, F-029, F-031, F-032, F-034, F-035, F-038, F-040, F-042–F-045, F-047, F-050, F-052 · Wave 4 (AI/deployment/expansion): F-019–F-022, F-039, F-051. Plus the cross-cutting verification list in the Not-Verified section below.
- **Review cycle (repeating):** ChatGPT assigns verification task → Muse investigates and returns evidence/reproduction/root cause/proposed design → ChatGPT independently reviews and challenges → Owner approves the design → Muse implements (scoped, tested, documented) → ChatGPT audits the diff/security/regressions/test evidence → checklist updated, next task.
- **Definition of complete:** every record can be understood, corrected, appropriately deleted; every financial figure traceable to source; every date/time correct in the viewer's timezone; every operational relationship visible and meaningful; daily workflows completable without hunting menus; AI never presents unsupported info as database truth; the app reports its own failures accurately; tenant isolation independently verified; tests and live production agree; documentation describes the actual implementation.
- **First assignment (ChatGPT):** independent verification pass on ALL 53 findings before any implementation, returned as a verified findings register grouped by severity with exact file/line references and proposed designs, for ChatGPT to challenge before Wave 1 is authorized. **Status: kicked off 2026-10-31 by King (pre-flight reconciliation expanded to the full 53-finding verification register).**

## ⚠️ Reconciliation rule — read before fixing ANY item

ChatGPT audited **`main` only**. On 2026-10-31 a large amount of work was built on branches that are NOT on main yet, and the live database already has migrations applied through **00022**. Fixing a finding that a branch already fixes would waste work and create conflicts.

Before any fix, for that item check all four, in order:
1. [ ] Current `main` HEAD
2. [ ] The 2026-10-31 branches: `bot-intelligence-v2` (migrations 00015/00016), `agent-omnipresence` (00021), `document-scan` (00022), `research-engine` (00019), `smart-path-truck-routing`, plus Smart Path / Driver MVP already merged to main
3. [ ] Live Supabase schema (migrations through 00022 applied 2026-10-31)
4. [ ] Live deploy state (production may still be older than main — deploy is manual `fly deploy`, **GitHub Actions is banned by standing owner rule, never use/fix Actions**)

Items affected are flagged **↻ RE-VERIFY** below. If a branch already fixes it, the work is *merge + gate + verify*, not rebuild.

## How an item gets checked off (definition of done)

An item is only `[x]` when ALL are true:
- [ ] Finding re-verified against the current merged tree (not just ChatGPT's say-so)
- [ ] Fix lands with a test/check that **failed before and passes after** (or a documented manual verification for UI-only items)
- [ ] Full gate on the fixed tree: tests + typecheck + lint + build, numbers quoted from persisted logs, not memory
- [ ] ChatGPT re-audits that wave's diff and confirms the finding is closed (relay loop: King fixes → ChatGPT re-audits → discrepancies become new checklist lines, never silently dropped)
- [ ] Merge to main and deploy remain the owner's separate taps (standing rule) — a branch fix is "done-coded", not "done-live", until both happen, and the checklist entry must say which state it's in

Status key: `[ ]` open · `[~]` re-verify against branches first · `[x]` done + verified live

---

## Pre-flight reconciliation (do first, unblocks everything)

- [x] **P-01** Establish current main HEAD, all open branch HEADs, and which branches are merged vs pending owner tap — **DONE 2026-10-31 (verification register §1): main = `7e03ed3`; merged: driver-mvp-telegram, smart-path-v1; branch-only: bot-intelligence-v2, agent-omnipresence (stacked on v2, merge v2 first), smart-path-truck-routing (cleanest next merge), research-engine, document-scan (oldest base)**
- [~] **P-02** Establish live deploy SHA vs main HEAD — **evidence received 2026-10-31 ~19:13 EDT: Fly release v15 runs main @ `7e03ed3e` (Driver MVP + Smart Path), verified server-side (both machines on image `trucking:manual-7e03ed3`, `/forgot-password` → 200, `/smart-path` + `/fleet/checklists` exist and auth-gate). Deploy route proven from this VM: local buildah build → Fly registry push → `flyctl deploy --image`. Closes when the verification register confirms main HEAD is still `7e03ed3e` (or records the new HEAD + its deploy state). This also partially evidences NV-1 and NV-4 (recovery *page* live; a full email reset cycle is still unverified)
- [x] **P-03** Reconcile migration ledger — **DONE repo-side 2026-10-31 (register §2): 00018 and 00020 exist in NO branch — they are reservation gaps, not lost migrations; live DB "through 00022" is the highest number, not contiguous; final main must union 00001–00017 + 00019 + 00021 + 00022. Live-ledger confirmation remains part of NV-2**
- [ ] **P-04** Run the existing test suite once on the current tree and record real pass/fail/skip counts (F-052 — test *existence* is not proof)
- [ ] **P-05** Confirm production secrets present by name only (no values): industry-briefing DB URL / cron secret, EIA key, ORS key status, Telegram secrets

## Wave 1 — Trust blockers (fix first, in this order)

ChatGPT's 11 Wave-1 work orders, mapped to findings:
- [ ] **W1-1** Common record-detail + edit/delete pattern → F-001, F-016, F-044
- [ ] **W1-2** Expose correction/deletion for duty logs, loads, expenses, fuel, maintenance, inspections, trucks, trailers, drivers, brokers, customers → F-001
- [ ] **W1-3** HOS datetime-local default uses local wall time → F-011
- [ ] **W1-4** Monthly boundaries in America/New_York, not UTC → F-007
- [ ] **W1-5** Define + label the revenue-date convention → F-008
- [ ] **W1-6** Enforce fuel gallons × price = total → F-053
- [ ] **W1-7** Financial summary proves source-row completeness → F-033, F-010, F-049
- [ ] **W1-8** Fix pagination/truncation in HOS + financial calculations → F-013, F-031, F-033
- [ ] **W1-9** Same-company ownership enforced on every FK relationship → F-036, F-024
- [ ] **W1-10** Delete verifies a row actually changed → F-005
- [ ] **W1-11** Partial-update validation validates the merged record → F-028

## All findings F-001 → F-053

### CRUD & data lifecycle
- [ ] **F-001 · P1 · CONFIRMED** — No edit/delete controls on normal list screens (duty logs, loads, expenses, fuel, maintenance, inspections, trucks, + brokers/customers/drivers/trailers). *The original "added a log, couldn't delete it" bug. API has PATCH/DELETE; UI never exposes them.* Fix: shared detail/correction pattern with delete confirmation. Effort M–L
- [ ] **F-002 · P2 · CONFIRMED** — Soft delete exists (`softDelete()` sets `deleted_at`) but no restore/archive screen. Fix: restore mechanism or explicit permanent-delete policy. Effort S
- [x] **F-003 · CLEARED** — RLS DELETE authorization is NOT the problem: ordinary tenant tables have `FOR ALL` company-scoped policies. Do not "fix" this. Preserve.
- [ ] **F-004 · P2 · CONFIRMED** — Document delete can orphan Storage objects (removal result unchecked, `documents/[id]/route.ts`). Effort M
- [ ] **F-005 · P2 · CONFIRMED** — Generic `softDelete()` doesn't verify a row was actually changed; nonexistent/RLS-invisible ID can return HTTP 204 success. Effort S
- [ ] **F-006 · P2 · CONFIRMED** — No idempotency/dedup on creates; two POSTs = two records (double-tap, retry). Effort M

### Truth in code — money, time, HOS
- [ ] **F-007 · P1 · CONFIRMED** — Financial summary current-month uses UTC boundaries (`getUTCFullYear/getUTCMonth`, `financial-summary/route.ts`). Violates America/New_York rule — month flips early on the last evening of the month. Effort S–M
- [ ] **F-008 · P1 · CONFIRMED** — Revenue attributed to `delivery_date ?? pickup_date` as one lump, convention unlabeled in UI. Decide + label the convention. Effort M
- [ ] **F-009 · P1 · CONFIRMED** — No per-load P&L exists; summary is period-level only and fuel/maintenance aren't load-linked so no honest per-load profit can be shown. Effort L (design allocation first — see F-023)
- [ ] **F-010 · P1 · CONFIRMED** — Money summary components are independently date-filtered with no drill-down to contributing rows. Effort M
- [ ] **F-011 · P1 · CONFIRMED** — Duty-log form default `new Date().toISOString().slice(0,16)` puts UTC into a `datetime-local` field (can show midnight instead of 8pm ET). Effort S — **Top-5 quick win #2**
- [ ] **F-012 · P2 · CONFIRMED** — Fuel list displays raw `purchased_at` timestamp (UTC/ISO on screen). Shared local formatting. Effort S
- [ ] **F-013 · P1 · CONFIRMED** — HOS summary calculated from only the latest 200 rows, ordered by `created_at` not `started_at` — older logs silently excluded, summary can be wrong. Query the full window ordered by start time. Effort M
- [x] **F-014 · CLEARED** — HOS honestly labeled a paper-log helper, NOT an ELD (UI, `lib/hos.ts`, migration 00011, design doc). Preserve this boundary in every fix.
- [ ] **F-015 · P2 · CONFIRMED** — HOS 70-hr uses fixed rolling 192-hr window; no calendar-day grouping, no 60-hr/7-day cycle option. Define supported cycle semantics explicitly. Effort M
- [ ] **F-016 · P1 · CONFIRMED** — Loads can be created as incomplete drafts but there is no load edit screen to finish/correct them. Effort M

### Documents & uploads
- [ ] **F-017 · P2 · CONFIRMED** — Document upload validates declared MIME (`file.type`) only, not actual file bytes/signatures. Effort M
- [~] **F-018 · P2 · CONFIRMED on main** — No OCR/text extraction in main's document schema. **↻ RE-VERIFY: document-scan branch (migration 00022) already built scan + AI extraction + full-text search — likely merge-and-verify, not a rebuild.** Effort L if rebuilt, S–M if branch lands
- [ ] **F-038 · P2 · CONFIRMED** — Document upload rollback cleanup result unchecked; failed cleanup orphans Storage objects (pairs with F-004). Effort M

### AI / bot / dispatch
- [x] **F-019 · CLEARED** — Dispatch helper honestly says nothing is sent automatically; draft vs sent distinction is truthful. Preserve.
- [~] **F-020 · P2 · SUSPICION** — Industry-briefing scheduler/DB role production state never verified. **↻ RE-VERIFY against research-engine branch + live run history (`industry_briefing_runs`).** Proof: live role config + a real produced briefing
- [~] **F-021 · P2 · CONFIRMED on main** — Bot's factual access is a narrow snapshot (recent loads/logs/expenses/fuel, names, memories) — not every entity. **↻ RE-VERIFY: bot-intelligence-v2 (tool-calling agent) + agent-omnipresence (full-CRUD tools for every entity, migration 00021) were built 2026-10-31 — likely merge-and-verify.** Effort M–L if any gap remains
- [x] **F-022 · CLEARED (with note)** — Bot memories correctly separate `expense_hint` from a booked expense (00014). Note: pending-actions system ChatGPT found absent on main now exists on the omnipresence branch (00021) — re-check semantics when it merges, don't regress the separation.
- [~] **F-039 · P2 · CONFIRMED on main** — Telegram bot context deliberately truncated (20 msgs / 100 memories / 5 active loads / 100 logs). **↻ RE-VERIFY against v2 tool-calling design (retrieval on demand replaces snapshot stuffing).** Effort L if still snapshot-bound

### UI ↔ backend inconsistencies
- [ ] **F-023 · P1 · CONFIRMED** — **Fuel purchases have `truck_id` but no `load_id`** — fuel can never be attributed to a load (blocks F-009). Design fuel-to-load attribution. Effort L
- [ ] **F-024 · P1 · CONFIRMED** — Documents use polymorphic `related_entity_type` + `related_entity_id` with NO foreign key and no existence/company validation of the referenced entity. Validate referenced record belongs to the company before accepting. Effort M
- [ ] **F-025 · P2 · CONFIRMED** — No load-detail screen, so a load's documents aren't visible from the load (must hunt in More → Documents). Effort M (lands with F-048)
- [ ] **F-026 · P2 · CONFIRMED** — Financial invariants (non-negative rate/miles/amounts) enforced in Zod only, not as DB CHECK constraints — any non-API writer can insert bad values. Decide DB-boundary enforcement. Effort M
- [ ] **F-027 · P2 · CONFIRMED** — Expense categories too narrow (insurance/permits/repairs/other only — no tolls, parking, scale, meals, lodging, factoring/dispatch fees, driver pay, truck payment). Design real taxonomy. Effort M
- [ ] **F-028 · P1 · CONFIRMED** — Partial PATCH validates only submitted fields, not the merged record (maintenance schedules, pre-trip inspections) — invalid combos surface as raw DB errors. Validate merged state. Effort S
- [ ] **F-029 · P1 · CONFIRMED** — `usePickerList` catch turns failures into empty lists (`.catch(() => setItems([]))`) — a failed broker lookup looks like "you have no brokers." Add loading/error/retry states. Effort S — **Top-5 quick win #5**
- [ ] **F-030 · P2 · CONFIRMED** — Related-record labels degrade to raw UUIDs when the related truck/driver isn't in the picker list or the picker fails. Preserve historical labels; distinguish deleted vs failed lookup. Effort M

### Bugs & operational pitfalls
- [ ] **F-031 · P2 · CONFIRMED** — Generic lists default to limit 50 with no next-page UI — records exist but are invisible. Effort M
- [ ] **F-032 · P2 · CONFIRMED** — Picker lists capped at 200, `page.total` never checked, failures silently discarded. Searchable/paginated pickers. Effort M
- [ ] **F-033 · P1 · CONFIRMED** — Financial summary queries have no explicit pagination/count verification — past the PostgREST max, totals silently omit real transactions. Use DB aggregation or count-verified pagination. Effort M
- [ ] **F-034 · P2 · CONFIRMED** — No shared cache invalidation after mutations — cross-screen totals can be stale until remount/refresh. Effort M (pairs with F-047)
- [ ] **F-035 · P2 · CONFIRMED** — Generic list `limit` parsed with `Number()` and never clamped/validated (negative, fractional, huge all pass through). Effort S
- [ ] **F-036 · P1 · CONFIRMED** — FKs reference only the related UUID, not `(company_id, id)` — DB structure alone doesn't stop cross-company references; CRUD accepts related IDs from the request body. Enforce same-company ownership at the DB boundary. Effort L
- [ ] **F-037 · P1 · CONFIRMED** — Password recovery pages exist but the two Supabase dashboard steps (reset email template with token_hash link + Site URL = https://trucking.fly.dev) are production dependencies not proven done. Proof: one real end-to-end reset on the deployed app. Effort S config

### Search, journeys, consistency, visibility
- [ ] **F-040 · P2 · CONFIRMED** — Lists mostly have no search/date/amount/keyword filtering; no export/backup anywhere. Effort M–L **↻ Partial re-verify: document full-text search exists on document-scan branch**
- [ ] **F-041 · P2 · CONFIRMED** — Fleet is several disconnected lists; no unified daily view (truck? trailer? inspection today? current duty status? maintenance due? current load?). Effort L
- [ ] **F-042 · P2 · CONFIRMED** — Empty states inconsistent; some don't distinguish genuine-empty from failed lookup (see F-029). Standardize loading / empty / error / populated. Effort S–M
- [ ] **F-043 · P2 · CONFIRMED** — Date formatting differs per screen (`toLocaleString` / `toLocaleDateString` / raw string / raw timestamp). One shared timezone-aware formatter. Effort S
- [ ] **F-044 · P2 · CONFIRMED** — No common record-detail convention across entities (open / all fields / related records / edit / delete / history). Effort L (same build as W1-1)
- [ ] **F-045 · P2 · CONFIRMED** — No global/cross-entity search. Effort M–L
- [ ] **F-046 · P1 · CONFIRMED** — Home is a monthly money summary only — no current load, duty status, truck readiness, or today's timeline (its own code comment defers recent activity + quick-add). Build operational snapshot separate from financial snapshot. Effort M
- [ ] **F-047 · P2 · CONFIRMED** — Home/financial snapshot has no guaranteed refresh after mutations (see F-034). Effort M
- [ ] **F-048 · P1 · CONFIRMED** — No load-detail page tying together load + truck/driver + broker/customer + duty logs + expenses + fuel + documents + profit. Effort L — **the centerpiece Wave-2 build**
- [ ] **F-049 · P1 · CONFIRMED** — Money totals can't be reconciled to visible transactions (summary returns no source IDs/breakdown; lists paginate independently). Every total gets a drill-down. Effort M

### Docs, deployment, testing
- [ ] **F-050 · P2 · CONFIRMED** — `PROJECT_STATE.md` stale (last updated 2026-08-21) — cannot be trusted for deploy/config state. Reconcile against commits, migrations, live state. Effort S
- [ ] **F-051 · P2 · CONFIRMED/SUSPICION** — `.github/workflows/fly-deploy.yml` exists but its success is unproven. **Owner's standing rule resolves this: GitHub Actions is banned — the fix is to remove/disable the workflow and formally document manual `fly deploy` as the only release process, NOT to make Actions work.** Effort S
- [ ] **F-052 · P2 · CONFIRMED** — Test suite exists (unit/integration/e2e) but was not executed in the audit; e2e was previously blocked per project docs. Run all suites, record real counts (see P-04). Effort M
- [ ] **F-053 · P1 · CONFIRMED** — Fuel gallons × price-per-gallon is never reconciled with entered total cost (100 gal × $3.50 with a $500 total passes Zod; summary uses the entered total). One authoritative calculation + explicit tax/discount policy. Effort S — **Top-5 quick win #4**

## The 5 user journeys (each must pass end-to-end on the live app)

- [ ] **J-1 · PARTIAL/BROKEN at load detail** — Add load → drive it → log hours → fuel + expenses → attach BOL → see what the load made. Breaks at: no fuel→load link (F-023), no load detail (F-048), no per-load P&L (F-009)
- [ ] **J-2 · BLOCKED** — Add any entry → realize it's wrong → fix or delete it. Blocked for most entities (F-001, F-016). **Highest-priority journey**
- [ ] **J-3 · PARTIAL** — Start day → pre-trip → duty log → end day. Pieces exist, no unified daily workflow, inspection doesn't gate/inform readiness (F-041)
- [ ] **J-4 · PARTIAL/WORKS** — Dispatch message → understand → reply → record what was sent. Helper works honestly (F-019); app cannot observe actual sending — accepted boundary, keep it labeled that way
- [ ] **J-5 · PARTIAL** — First-time user → log in → know what to do first. No guided setup sequence (truck → profile → driver → trailer → first load → first duty status). Effort M

## Wave 2 — Complete operational journeys (after Wave 1)

- [ ] **W2-1** Unified load-detail page → F-048
- [ ] **W2-2** Load-linked documents + expenses visible from load detail → F-025
- [ ] **W2-3** Fuel-to-load attribution design + build → F-023
- [ ] **W2-4** Daily start-to-end workflow (pre-trip + duty status + load) → F-041, J-3
- [ ] **W2-5** True operational Home snapshot → F-046
- [ ] **W2-6** Record-level search + pagination → F-040, F-031, F-045
- [ ] **W2-7** Document association visible from related entities → F-025
- [ ] **W2-8** First-time owner-driver setup journey → J-5
- [ ] **W2-9** Load-level contribution margin (honest allocation) → F-009

## Wave 3 — Consistency & clarity (after Wave 2)

- [ ] **W3-1** Standardize date/timezone formatting → F-043, F-012
- [ ] **W3-2** Standardize detail/edit/delete/confirmation behavior → F-044
- [ ] **W3-3** Visible picker loading/error states → F-029, F-032
- [ ] **W3-4** Empty states distinguish empty vs failed → F-042
- [ ] **W3-5** Real expense taxonomy → F-027
- [ ] **W3-6** Consistent restore/archive policy → F-002
- [ ] **W3-7** Document upload/delete failure handling → F-004, F-038, F-017
- [ ] **W3-8** Transaction drill-downs from Money totals → F-010, F-049
- [ ] **W3-9** Reconcile `PROJECT_STATE.md` → F-050

## Wave 4 — Polish & expansion (last)

- [ ] **W4-1** Phone-first accessibility + touch targets
- [ ] **W4-2** Export + backup → F-040
- [~] **W4-3** OCR/document processing with transparent extraction status → F-018 (branch-built, re-verify)
- [~] **W4-4** Expand AI tools on verified DB retrieval → F-021, F-039 (branch-built, re-verify)
- [ ] **W4-5** Operational alerts + maintenance reminders
- [ ] **W4-6** Dispatch history / message organization
- [ ] **W4-7** Performance monitoring + production health reporting
- [ ] **W4-8** Deployment process formally settled as manual Fly (Actions removed/disabled) → F-051

## Top 5 quick wins (do inside Wave 1)

- [ ] **QW-1** Edit/delete actions on duty logs + expenses first → F-001
- [ ] **QW-2** Fix HOS local datetime initialization → F-011
- [ ] **QW-3** Fix local (America/New_York) monthly boundaries → F-007
- [ ] **QW-4** Reconcile fuel total vs gallons × price → F-053
- [ ] **QW-5** Picker error states → F-029

## Cleared suspicions — checked by ChatGPT, actually fine, DO NOT REGRESS

- [x] C-01 Tenant RLS on ordinary company-owned tables
- [x] C-02 Business API handlers require authenticated context (`proxy.ts`, server client)
- [x] C-03 HOS non-ELD boundary (also F-014)
- [x] C-04 Money stored as integer cents
- [x] C-05 Load schema: delivery cannot precede pickup when both supplied
- [x] C-06 Maintenance schedule DB invariants (exactly one vehicle, ≥1 interval — migration 00010)
- [x] C-07 Pre-trip vehicle invariant (exactly one truck or trailer — migration 00010)
- [x] C-08 Document upload 25 MB limit + MIME allowlist enforced server-side
- [x] C-09 Documents in a private bucket with short-lived signed URLs
- [x] C-10 Centralized API error handling exists
- [x] C-11 Dispatch AI does not claim to send messages (also F-019)
- [x] C-12 Bot expense hints ≠ booked expenses (also F-022)
- [x] C-13 Maintenance-due calculation module exists with unit tests (`lib/maintenance-schedule.ts`)
- [x] C-14 Spec-first discipline in `CLAUDE.md` — repo rules require spec + doc updates with code; follow them, don't skip silently

## Not Verified — gates that must be closed with live evidence (grouped)

- [ ] **NV-1 Deploy truth:** live Fly release/commit vs main HEAD; manual deploy observed working; Fly secrets present (names only)
- [ ] **NV-2 Live DB truth:** actual tables, migration ledger, `pg_policies`, row counts by table/`deleted_at` vs migration files
- [ ] **NV-3 Tenancy attack test:** two-company cross SELECT/INSERT/UPDATE/DELETE attempts on the live/test DB (source review ≠ proof)
- [ ] **NV-4 Auth truth:** real login/logout cycle + one real end-to-end password reset from the deployed app (closes F-037)
- [ ] **NV-5 Storage truth:** upload → delete → simulated Storage failure → inspect bucket for orphans (closes F-004/F-038 live side)
- [ ] **NV-6 AI truth:** numeric questions against known records, verify every number traces to a source row; Telegram webhook tests (valid/invalid/missing secret, unlisted chat)
- [ ] **NV-7 Scheduler truth:** inspect real briefing runs, trigger one controlled job (closes F-020)
- [ ] **NV-8 Routing truth:** actual truck profile tested against known restrictions on the live routing provider
- [ ] **NV-9 Gate truth:** `npm test`, `npm run test:e2e`, `typecheck`, `lint`, `build` actually run with real counts recorded (closes F-052)
- [ ] **NV-10 Phone truth:** all 5 journeys exercised on the owner's Android phone, stationary, at real screen size — final sign-off gate for every wave

## ChatGPT relay log

_Every King ↔ ChatGPT round gets logged here so no finding is ever re-litigated or lost._

| Date | Round | Sent to ChatGPT | Verdict back | New checklist lines added |
|---|---|---|---|---|
| 2026-10-31 | Audit | Full-audit prompt (King) | 53 findings, Waves 1–4, 5 journeys | This checklist (initial) |
| 2026-10-31 | Program charter | Owner relayed the audit + King's checklist | ChatGPT established the **Reliability & Completion Program**: roles (ChatGPT architect/reviewer/acceptance, Muse investigator/implementer, owner approves design/scope/docs/deploy), 10-stage closure pipeline, 12 program rules, regrouped waves, required task format, definition of complete. First assignment: independent verification of ALL 53 before any implementation | Program charter section added at the top of this checklist; closure pipeline + regrouped waves override the original roadmap groupings |
| 2026-10-31 | Verification (in flight) | This checklist + charter | — pending — | Verification register to be added when the pass returns, then relayed to ChatGPT for challenge before Wave 1 |
| 2026-10-31 | **Verification register RETURNED** | — | **53/53 verified at repo level** (register: `Trucking-Verification-Register-2026-10-31.md` in these goal files). Headlines: all Wave-1 spot-checks still true on main @ `7e03ed3`; F-018/F-021/F-039 = CHANGED on branches (merge+verify, not rebuild); F-040 = partially changed (document search only; list search + export exist nowhere); F-020/F-037/F-052 = cannot verify from repo (need live evidence); all 4 cleared items (F-003/014/019/022) independently re-confirmed; F-036 stays P1 with a documented P0-escalation trigger (NV-3 attack test); F-051 sharpened: the Actions workflow header falsely claims "CI is the only deploy path that actually works" — removal/documentation is the fix. P-01 + P-03 closed repo-side; P-04 (test run) + P-05 (secret-name inventory) deliberately not done in this pass | Register file created; P-01/P-03 checked off; next step = owner relays register to ChatGPT for challenge, then owner approves Wave 1 designs |
| 2026-10-31 | Charter adopted | The canonical checklist (King's IDs: F-001–F-053, P-01–P-05, J-1–J-5, W1–W4, QW-1–QW-5, NV-1–NV-10) | ChatGPT adopted the checklist **as-is, no renumbering**, as the canonical register for its side too; restated the governing decisions (checklist is source of truth, audit is not proof; no implementation until the verification register is challenged and the owner approves; branch work is evaluated, not rebuilt; Actions stays banned; done-coded ≠ done-live). Noted ChatGPT cannot guarantee the 53-item register persists in its own memory — the durable copy must live in the repo or project records (currently: this file, in the own-truck goal files). **This message authorized no implementation, merge, or deployment.** Program status: pre-flight + independent verification in progress | Relay log entry (this row); P-02 updated with live v15 deploy evidence |
