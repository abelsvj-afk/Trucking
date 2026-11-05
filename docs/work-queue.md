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
4. **Standing work order after that:** step 6 / step 7 with the pay profile; paper log; Smart Path Phases 1–3 (corridor geometry, regional fuel, weather, state laws, construction; stale data always labeled); decomposition (remaining oversized files: `services/bot/store.ts` (pay-truth slice moved to `store-pay.ts`, 1664 -> 1389 lines; threads/people, memories, pending-actions slices next), `tools-write.ts` (1780), `telegram/dispatch-bot.ts` (1104)); reliability Units D and E.

## B. Retrospective audit (worked alongside; checklist in `docs/reconciliation/audit-closure-checklist.md`)
- Wave 4 remaining: service-role company-isolation tests (webhook store, schedulers, internal invokers); seeders for the 4 unseedable tables; real-browser E2E for the main journeys and the motion lock; AI evals (confirmation targeting, cancel-vs-delete, forwarded-text injection G3, memory supersession, same-name people); accessibility pass; phone-width performance run; update remaining stale canonical sections.
- Wave 5: reconcile `TASKS.md` into small dependency-ordered tasks; `CHANGELOG.md` and agent files only if the owner names them; postmortem record.
- Wave 6: remediation only per owner-approved unit (G4 owner-visible activity log; retention beyond messages).
- P3: README refresh, `.env.example` check.

## B2. Paper log (checked 2026-11-05)
- Built and gated: in-app review (`/fleet/hos/paper`, migration 00059), Telegram reader, by-hand entry, carrier-cycle before/after line, naming condition for faint stretches.
- ONE engineering item left, and it is a ruling, not code: **D-13 (B7)** - a dropped/unreadable mid-day stretch in a Telegram paper-log batch is still carried by the previous status in the app's clocks once he approves (a duty row runs until the next row; the model cannot store "unknown"). Today the approval prompt names the stretch and says so (informed yes). Options: (a) stop-at-gap - stage only up to the first gap and send him to the app review screen for the rest (recommended; no schema change, nothing guessed); (b) by-word fill before approval; (c) keep the informed yes. Not changed without the owner's pick.
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
