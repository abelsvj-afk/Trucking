# Open work queue — nothing here gets dropped

Kept in the repo so it survives context loss and interruptions. If a newer request pushes something aside, it stays on this list with a note of what displaced it. Updated 2026-11-05 at `main` `bc1be1c`. Order = the order I work them unless the owner reorders.

## A. Owner's active orders (in this order)
1. **Isolation follow-through** — DONE (00067, complete-row probes, tolerance fix; pushed `3144aa7`). King reports (relayed, 2026-11-05) 00067 applied and the live isolation checks run; not re-verified by me.
2. **FMCSA** — CODE DONE, gated with the next push (not yet deployed/verified live): switch `rss.ts` to the taxonomy Newsroom URL `https://www.fmcsa.dot.gov/taxonomy/term/191/feed`; carry the captured HTTP status into the partial-coverage message (today it shows failed source names only); King's production-poll check stays armed until it deploys. Boundary: if it still 403s from Fly, the drop decision returns to the owner.
3. **King's four-item work order** (relayed owner requirements, dictated on the road):
   - 1 duty-aware MotionLock — DONE (`5e8d180`).
   - 3 backfill finished loads + paycheck check — CODE DONE (gated; not deployed/verified live; the detail-page pay-check line and an import path for old loads beyond the form are not built). Design as built: no migration (00048 `settlement_lines` kind `load_pay` + `load_id` is the per-load received pay); price a load with the pay-terms row in force on its delivery date; new `GET /api/v1/pay-summary` (server computes, pages consume); "already completed" path on Loads/new with loaded + deadhead miles; Money → Paychecks view (expected vs received, shortfalls flagged).
   - 2 HOS cost inside pay answers — CODE DONE for `explain_load_pay` (appends the hours line; `evaluate_pay_offer` is not a tool in this repo, so only load-pay answers carry it): Abel's `evaluate_pay_offer`/load answers state the load's driving-hours cost next to its pay, using the one HOS read (`loadHosWindow`) and the remaining drive / 14-hour / 70-8 / break clocks; no second HOS implementation.
   - 4 Home preview card — CODE DONE (`PaycheckHomeCard`): expected pay on the active load, completed-but-unpaid total, break-due + cycle remaining; consume `pay-summary`.
4. **Standing work order after that:** step 6 / step 7 with the pay profile; paper log; Smart Path Phases 1–3 (corridor geometry, regional fuel, weather, state laws, construction; stale data always labeled); decomposition (remaining oversized files: `services/bot/store.ts` (pay-truth -> `store-pay.ts`, threads/people -> `store-threads.ts`; 1664 -> 1071 lines; memories and pending-actions slices next), `tools-write.ts` (1780 -> 1153: helpers in `tools-write-helpers.ts`, maintenance/defects/checklist in `tools-write-maintenance.ts`), `telegram/dispatch-bot.ts` (1104)); reliability Units D and E.

## B. Retrospective audit (worked alongside; checklist in `docs/reconciliation/audit-closure-checklist.md`)
- Wave 4 remaining: service-role company-isolation tests (webhook store, schedulers, internal invokers); seeders for the 4 unseedable tables; real-browser E2E for the main journeys and the motion lock; AI evals (confirmation targeting, cancel-vs-delete, forwarded-text injection G3, memory supersession, same-name people); accessibility pass; phone-width performance run; update remaining stale canonical sections.
- Wave 5: reconcile `TASKS.md` into small dependency-ordered tasks; `CHANGELOG.md` and agent files only if the owner names them; postmortem record.
- Wave 6: remediation only per owner-approved unit (G4 owner-visible activity log; retention beyond messages).
- P3: README refresh, `.env.example` check.

## B1. Smart Path intelligence (design: `docs/design/smart-path-intelligence.md`, draft for owner review)
- BUILT + gated: Phase 1 corridor points with ETA, states crossed; Phase 2a regional diesel (per-PADD EIA, stale labeled not ranked); 2b NWS weather at his arrival time; 2c state-rule machinery (table EMPTY on purpose).
- Phase 3 road-work machinery BUILT (WZDx parser, corridor+ETA filter, section); feed registry EMPTY until a feed is verified from the deploy network (King: pick states, verify each feed once).
- NEEDS OWNER/KING: verified state-rule rows (his common states first); answers to the spec's open questions (corridor width, wind trigger, first states for work-zone feeds); swap the state-outline asset for an official Census file if provenance matters.

## B3. Reliability Unit D (design: `docs/reliability-wave1-design-package.md` Unit D)
- BUILT + gated, NOT applied/deployed: D1 fuel `load_id` (migration **00068**, picker + never-auto "assign it?" suggestion on the fuel forms), D2 `GET /loads/[id]/economics`, D3 summary aggregates (migration **00069** replaces `financial_summary_snapshot`; "Fuel not assigned to a load" line on Money -> Summary; C.3 bridge property tested), D4 contribution-margin section on the load page + the "real profit" copy corrected (copy test added). Both migrations verified on a clean scratch Postgres 16 (all prior migrations, isolation 60/60, anon 0 grants, snapshot function checked on seeded data).
- OWNER/KING: apply 00068 then 00069 (order matters); the Telegram bot's fuel tools do not set `load_id` (bot-lane follow-up).
- Unit E BUILT + scratch-verified, NOT applied (`docs/tenant-integrity.md`): 00070 composite FKs (63, generated from the catalog; pre-flight aborts on any cross-company row - owner ruling then, no auto-repair), 00071 documents reference trigger (non-oracle), uniform 422 mapping, `tests/db/tenant-fk.sql` + `documents-trigger.sql`. Apply order 00068 -> 00069 -> 00070 -> 00071. The live pre-flight result is the real gate: King runs it (or just applies 00070 - it refuses safely).

## B2. Paper log (checked 2026-11-05)
- Built and gated: in-app review (`/fleet/hos/paper`, migration 00059), Telegram reader, by-hand entry, carrier-cycle before/after line, naming condition for faint stretches.
- D-13 (B7) RULED by the owner 2026-11-05: option (a), stop-at-gap. Implemented (`capAtFirstGap` in `services/fleet/paper-logs.ts`, tests added); design note in `driver-hud.md` §6. Gated with the next push; not deployed.
- Owner acceptance: his own photographed sheet vs his reading - outstanding (needs the deploy).

## C. Built but incomplete / parked ideas the owner raised
- D-12 banner: a visible "can't tell if you're moving" banner for unknown/stale location (recommended, not built; awaiting the owner's D-12 answer).
- Drive camera: the owner's description of truck-GPS behavior (zoomed on the icon, following the line, predicting turns). Motion logic is fixed; the camera/prediction feel is unverified until a real drive. Revisit with his feedback.
- Logging reminders: optional "no log by 10:00 ET" nudge once he defines a normal day; reminders stay off until he switches them on.
- Home map card (HUD §8) — parked.
- Unlinked Telegram photos stay filed under the company until a proposal links them to a load; a "file this under the trip" picker is not built.
- Amazon Relay load parser (needs a real message); payroll-tax math selecting by worker type; Employer-pay follow-ups.
- Screens for the four bot-only features if the owner later wants them (recurring obligations, broker follow-ups, IFTA worksheet, tax packet).
- Screen-by-screen UI/UX rewrite (needs King's post-deploy visual walkthrough).

## D. Waiting on someone else (not mine to do)
- **Owner:** deploy everything since Fly v48; switch `logging_reminders` on; real-phone checks (GPS, lock prompt, documents, trailer, Live Location); D-12; GitHub Support purge request (with King).
- **King:** (00067 + live isolation reported done); one FMCSA production poll after the owner deploys `f83996b` (if it still 403s from Fly, the drop decision returns to the owner; no more code churn first); deployed SHA; production proof (schedulers, Realtime, webhook, rollback); independent review of Waves 1–4; the Telegram document hunt (his lane).
