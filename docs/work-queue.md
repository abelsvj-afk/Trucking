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
4. **Standing work order after that:** step 6 / step 7 with the pay profile; paper log; Smart Path Phases 1–3 (corridor geometry, regional fuel, weather, state laws, construction; stale data always labeled); decomposition (remaining oversized files: `services/bot/store.ts` (pay-truth -> `store-pay.ts`, threads/people -> `store-threads.ts`, memory+capability flags -> `store-memory.ts`; 1664 -> 805 lines, pending-actions -> `store-pending.ts`; the store is now composed of five slice modules), `tools-write.ts` (1780 -> 684: helpers, maintenance, fleet, records slices in `tools-write-*.ts`), `telegram/dispatch-bot.ts` (1104 -> 923: `forward-format.ts`, `context-loader.ts`; text-turn processing is the remaining large block)); reliability Units D and E.

## B. Retrospective audit (worked alongside; checklist in `docs/reconciliation/audit-closure-checklist.md`)
- Wave 4 remaining (needs a deployed app / live DB): real-browser E2E for the main journeys and the motion lock; real-browser accessibility + phone-width performance runs; model-behavior evals (language gate, same-name people, memory supersession); service-role item 3 jobs driven individually. DONE this session: brain-store + bot-tool + game company-scope tests, injection-authority, driver_positions, isolation seeders 60/60, pool-role grants, a11y static baseline.
- Wave 5: `TASKS.md` indexed through 2026-11-06 (done); `CHANGELOG.md` and agent files only if the owner names them; postmortem record.
- Wave 6: remediation only per owner-approved unit (G4 owner-visible activity log; retention beyond messages).
- P3: README refresh and `.env.example` check - DONE 2026-11-06.

## B0. Owner requirements round 2 (2026-11-05 night; design `docs/design/driver-hud-round2.md`)
- Block A (duty status can never trap the driver): BUILT + gated, NOT deployed - status switcher exempt from MotionLock/parked gates (quick no-typing sheet while moving), lock banner escape hatch, sustained-motion auto-switch (60 s @ 5 mph + 30 s grace, stamped at detection, `source auto_motion`, migration **00072**, Telegram notice), Driving + stopped 5 min prompt (never auto). King verifies after landing.
- Block B (HOS clock escalation + notifications + explainers): BUILT + gated, NOT deployed - amber <=2 h / red <=30 min / EXPIRED (words too) on all four rings from the one HOS read; Telegram at 2 h/1 h/30 m/expiry once per threshold per clock per shift with consequence + action text, quiet hours do not hold them; tap-a-clock plain-language explainers. Block C (Home mini map): BUILT + gated, NOT deployed - semi-truck vector icon rotating with heading, heading-up follow mode (no touch pan), planned route line + dimmed driven part for a confirmed load's checked run (none -> position only), OSM maxspeed badge only when data exists (`GET /api/v1/map/speed-limit`), current speed always shown. Both self-audits done and folded in (record in `docs/design/driver-hud-round2.md`). Awaiting King's verification; migration 00072 to apply; not deployed.
- Round 2 follow-up (owner 2026-11-06): D-12 BUILT (visible "can't tell if you're moving" / "location is off" banner; banner, not lock). Automatic switch now ALSO runs server-side on the Telegram Live Location stream (works with the app closed), shared rules in `services/fleet/auto-motion.ts`, kill switch `auto_duty_switch` (default on), live-location thresholds aligned (5 mph; stopped-5-min proposal). Home map falls back to Telegram's last position when the device has no fix. Fully native background tracking (owner on ANDROID): server feed + device keys + Settings UI BUILT (migration **00073**), `native/tracker` Capacitor shell scaffolded and its queue logic tested - APK NOT built (no Android SDK in the sandbox): King/owner build it per `native/tracker/README.md` and prove it on the phone.
- Expired-clock reset + locks (owner 2026-11-06): an expired clock shows its RESET (10 h off / 30 min not driving / 34 h restart) filling in red until green, and a red "Locked right now" panel says what is locked, why, and what is still allowed (information only - never blocks logging); Driving button tagged "not legal now". `lib/clock-locks.ts`, `ClockReset` in `lib/hud-clocks.ts`. Day log entries now have Fix/Delete buttons.
- Final step: two self-audits (mistakes/edge cases; professional/working-driver review) folded in before the final report.

## B0b. Telegram bot audit fixes (owner 2026-11-06: "fix all of them in that order")
- From the owner's live Abel transcript. CODE DONE + gated, NOT deployed, NOT verified live:
  - P0-1: yes/no is matched as an exact phrase, so compound messages ("No that's not it. Delete that", "yes but...") always reach the model.
  - P0-2: a permanent write failure is dropped and said plainly. Only a network hiccup keeps it, and it keeps its original time, so it can't become the eternal YES target.
  - P0-3: `verifyProposal`. A proposal pointing at a record that doesn't exist is never shown. Proposals name records in words.
  - P0-4: several proposals in one turn become ONE numbered list.
  - P0-5: one rule. YES answers the newest proposal, and anything else still waiting is named.
  - P0-6: `execute-gate.ts`. Decisions, thread closing, attach and load edits execute only when his message names them; otherwise they are proposed.
  - P1:
    - NOW (Eastern) and recent-photo context blocks.
    - `complete_load` tool.
    - delete targets for decisions and threads.
    - backward-status warning.
    - "Now:" read-back of the changes.
    - no transient load state in memory.
    - "ok" is never a yes for deletes.
    - revise a single proposal.
    - an explicit delete survives the cancel path.
    - the prompt names the bot Abel (it said King).
  - P2: the model's duplicate "reply YES" prose is stripped; a recognised trip forward skips the sender guess.
  - Tests: `tests/unit/services/bot/telegram-audit-helpers.test.ts` plus the transcript regression in `agent-turn.test.ts`.
  - Follow-up self-review (same day): fixed "Still waiting" being listed twice (partial approvals, kept-for-retry), a delete being merged into a list one YES approves (it now stays its own proposal and is named as still waiting), and a stray "reply YES" when nothing was staged.
  - New: proposals go out with tap-able Yes / No buttons (`yn:yes` / `yn:no`). A tap is exactly the typed word through the same code path. A tap on a message over 10 minutes old is refused. If buttons fail to send, plain text goes out. Needs the Telegram webhook to deliver callback_query updates, which the photo buttons already rely on.
  - To verify after deploy: replay the transcript's turns with Abel on Telegram.

## B1. Smart Path intelligence (design: `docs/design/smart-path-intelligence.md`, draft for owner review)
- BUILT + gated: Phase 1 corridor points with ETA, states crossed; Phase 2a regional diesel (per-PADD EIA, stale labeled not ranked); 2b NWS weather at his arrival time; 2c state-rule machinery (table EMPTY on purpose).
- Phase 3 road-work machinery BUILT (WZDx parser, corridor+ETA filter, section); feed registry EMPTY until a feed is verified from the deploy network (King: pick states, verify each feed once).
- NEEDS OWNER/KING: verified state-rule rows (his common states first); answers to the spec's open questions (corridor width, wind trigger, first states for work-zone feeds); swap the state-outline asset for an official Census file if provenance matters.

## B3. Reliability Unit D (design: `docs/reliability-wave1-design-package.md` Unit D)
- BUILT + gated, NOT applied/deployed: D1 fuel `load_id` (migration **00068**, picker + never-auto "assign it?" suggestion on the fuel forms), D2 `GET /loads/[id]/economics`, D3 summary aggregates (migration **00069** replaces `financial_summary_snapshot`; "Fuel not assigned to a load" line on Money -> Summary; C.3 bridge property tested), D4 contribution-margin section on the load page + the "real profit" copy corrected (copy test added). Both migrations verified on a clean scratch Postgres 16 (all prior migrations, isolation 60/60, anon 0 grants, snapshot function checked on seeded data).
- OWNER/KING: apply 00068 then 00069 (order matters); Abel can now assign fuel to a load only when the owner says so (`update_fuel_purchase` takes an optional `load_id`; never guessed) and `money_summary` with a load reports the fuel he assigned; `create_fuel_purchase` and receipt-photo fuel still do not set a load.
- Unit E BUILT + scratch-verified, NOT applied (`docs/tenant-integrity.md`): 00070 composite FKs (63, generated from the catalog; pre-flight aborts on any cross-company row - owner ruling then, no auto-repair), 00071 documents reference trigger (non-oracle), uniform 422 mapping, `tests/db/tenant-fk.sql` + `documents-trigger.sql`. Apply order 00068 -> 00069 -> 00070 -> 00071. The live pre-flight result is the real gate: King runs it (or just applies 00070 - it refuses safely).

## B2. Paper log (checked 2026-11-05)
- Built and gated: in-app review (`/fleet/hos/paper`, migration 00059), Telegram reader, by-hand entry, carrier-cycle before/after line, naming condition for faint stretches.
- D-13 (B7) RULED by the owner 2026-11-05: option (a), stop-at-gap. Implemented (`capAtFirstGap` in `services/fleet/paper-logs.ts`, tests added); design note in `driver-hud.md` §6. Gated with the next push; not deployed.
- Owner acceptance: his own photographed sheet vs his reading - outstanding (needs the deploy).

## C. Built but incomplete / parked ideas the owner raised
- D-12 banner: BUILT 2026-11-06 on the owner's yes.
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
