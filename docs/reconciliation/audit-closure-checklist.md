# Retrospective audit — closure checklist (the standing to-do)

Source: `docs/retrospective-workflow-audit-2026-11-05.md` (written by ChatGPT, extended by King/Muse §11), §9 acceptance criteria and §7 remediation sequence. This is the list I keep working until every box is honestly checked. It runs alongside feature work; it never pauses it. Status is as of 2026-11-05 and is updated whenever a box changes. "Evidence" = what would prove it; **I do not tick a box on my own word where the audit asks for a reviewer or live proof.**

Legend: ✅ done (docs/code evidence in repo) · 🟡 partly · ⬜ not started · 👤 owner decision needed · 🔑 King's lane (live system)

## §9 acceptance criteria

| # | Criterion | Status | What's done / what remains |
|---|---|---|---|
| 1 | Every page and major feature has a named design doc and acceptance criteria | 🟡 | Wave 3 matrix names the design of record for all 18 families. Remaining: per-page acceptance criteria; `ui-ux.md` screen-by-screen rewrite (needs King's post-deploy visual walkthrough). |
| 2 | Every API route and schema has a consumer classification and contract | 🟡 | 115-route inventory + new contracts done. Remaining: consumer column (UI / bot / internal) per route; per-route request/response detail for generic CRUD resources beyond the worked example. |
| 3 | Migrations reconciled against `schemas.md` and the live ledger | ✅/🔑 | Appendix covers 00032–00066 tables/columns; ledger complete through 00064 per King; 00065 pending apply. Remaining: drift check (Wave 4). |
| 4 | Governance describes every AI capability, tool, scheduled action, approval rule, revocation path | ✅ | `ai-authority-matrix.md`; G1/G2 closed with switches; G3 (direct-order detection model-judged) kept + eval pending; G4 owner-visible activity log not designed. |
| 5 | Architecture and service specs match the implementation | 🟡 | Addenda written. Remaining: owner review; keep current as code lands. |
| 6 | All contradictory built/not-built/open statements resolved | 🟡 | Fixed in news-banner, HUD, usability, trip-intake, pay-profile docs. Remaining: sweep `PROJECT_STATE.md` history, `TASKS.md`, `automation.md`, `repository-structure.md`, research-engine for stale statuses. |
| 7 | Moving/parked safety policy consistent across requirements, design, code, tests | 🟡 | REQ/SAF-1..4 written; estimator + tests built. Remaining: SAF-1 test that every form is locked (all pages), SAF-2 Drive surface test, tests for unknown/stale/no-permission states end to end. |
| 8 | RLS tests cover every tenant-scoped table; separate service-role isolation tests | ⬜ | Matrix designed (32 tables untested). 👤🔑 Live run is King's (D-3). Remaining: write the missing tests; service-role path tests. |
| 9 | Critical workflows have passing unit, integration, E2E and AI-eval evidence | 🟡 | Unit coverage strong (1750+). Remaining: E2E for dispatch→load, paper-log, Drive reroute, pay terms; AI evals (grounding, language, proposal identity, stale/multiple, cancel≠delete, injection). |
| 10 | Accessibility and performance gates executed and recorded | ⬜ | Contrast guard exists. Remaining: keyboard/screen-reader pass, phone-width perf budget run (targets accepted D-5). |
| 11 | Production SHA, migrations, secrets, schedulers, Realtime, webhook, rollback verified | 🔑 | King: v48 verified; migrations through 00064 verified; secrets/schedulers/Realtime/webhook/rollback proof outstanding. |
| 12 | ROADMAP.md, TASKS.md, PROJECT_STATE.md agree | 🟡 | `ROADMAP.md` EXISTS (my earlier line saying it didn't was wrong — caught by ChatGPT's re-check 2026-11-05) but described only the original MVP stages; a reconciled "where the product is now" section was added 2026-11-05. Remaining: reconcile `TASKS.md` (258 lines, mixed history) into small dependency-ordered tasks; CHANGELOG.md only after owner approval; keep PROJECT_STATE current. |
| 13 | Reviewer independently accepted the documentation and evidence | 🔑 | King's review of Waves 1–3 outstanding. |
| 14 | Owner approved the next implementation scope | 👤 | Waves 4–6 scope below awaits approval per work unit. |

## Evidence levels (never conflate)
Every item is one of: **documented** · **code gate passed** (tsc, eslint, vitest, build on a named tree) · **applied** (migration on the live project, King) · **deployed** (a named release) · **verified live / on a real phone**. Current tree with a passing code gate: `181b16e` (docs-only commits since). Applied through 00064; 00065/00066 pending. Deployed: v48 (source SHA unprovable; does not contain everything on `main`). Real-phone verification: none yet.

## Done in Wave 4 so far
- Drift tests (`tests/unit/docs-drift.test.ts`): routes ↔ api-contracts inventory, migration tables ↔ schemas.md, tools ↔ authority matrix, capabilities ↔ matrix. First run caught a real drift (`list_memories` missing from the registry), fixed.

## Remaining waves

**Wave 4 — test and review gates** (docs: `wave-4-test-matrix.md`; code needs owner OK per unit): drift tests (tools↔matrix, routes↔api-contracts, tables↔schemas, LIVE_TABLES↔publication) · RLS tests for the 32 untested tables + `reminder_sends` · service-role company-scope tests (webhook store, schedulers, internal invokers) · E2E journeys · AI evals incl. forwarded-text injection (G3) · SAF-1..4 tests · accessibility + performance runs · update `docs/design/testing.md` · reviewer sign-off on the exact tree.

**Wave 5 — roadmap, tasks, state**: create `ROADMAP.md` · rebuild `TASKS.md` as small dependency-ordered tasks · `CHANGELOG.md` and agent files (`GEMINI.md`/`ARCHITECT.md` only if the owner names them) · postmortem record for major milestones.

**Wave 6 — implementation of audit remediations**: only per owner-approved task. Candidates already identified: G3 audit trail / owner-visible activity log (G4); retention beyond messages; Relay parser; remaining screens for bot-only features if the owner later wants them.

**Open from the audit's §5 priorities:** P0 privacy closure (GitHub Support purge — 👤🔑); P1 stale canonical docs (mostly done, owner review pending); P1 contracts out of sync (done, drift test pending); P1 tenant isolation evidence (Wave 4); P1 driver safety on every form (SAF-1 test); P1 production state (King); P2 UI/UX coverage, API-only classification (done), large files (decomposition continuing), tests/evidence; P3 onboarding artifacts (README refresh, `.env.example` check — not yet done).

## How I work it
After each feature landing I take the next unchecked docs-only item that needs no decision, finish it, tick the box with evidence, and report it in the wave record. Items needing a decision go into one collected list for the owner (never one at a time). Code items wait for approval of the specific unit.
