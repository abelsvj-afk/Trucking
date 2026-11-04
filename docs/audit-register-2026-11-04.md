# Audit register — 2026-11-04 (tracked; checked off as completed)

Sources: the external product/UX audit pasted by the owner (UX-01…UX-10 and the
findings around them), the visual audit set (14 of 62 pages), King's review fix
lists, and the owner's live requests. **Rule: an item is checked only when it is
in the code on the deploy branch, tested, and noted with its evidence.** Items
that need a human (owner, King, a device) say so and stay open.

Branch of record: `m4-reanchor` → merged to `main` (the Fly deploy branch) at the
end of the cycle. Nothing is visible in the app until the owner taps Deploy.

## A. Safety and privacy (release blockers)
- [x] A1 Unknown GPS speed must not unlock the fuller Drive screen — fail closed (`lib/vehicle-motion.ts`).
- [x] A2 Drive's moving screen keeps the live map (`components/drive/DriveGlance.tsx`).
- [x] A3 Drive's moving screen has no "Talk to Abel"/links; "I'm parked" is the only way back.
- [x] A4 UX-01 Home status buttons / Day log / Paper log locked while moving; unknown speed asks "I'm parked" (`StoppedGate`).
- [ ] A5 **OWNER/KING:** delete public branch `visual-audit-2026-11-04` and have GitHub purge commit `cf356393` (14 real-data screenshots were downloadable without login). Claude's delete was blocked by the sandbox.
- [ ] A6 Motion gate on the remaining forms/pages (HUD + Drive covered; the rest of the app is not).
- [x] A7 Self-audit find: a lull at 3 mph unlocked the fuller screen instantly — a stop must now HOLD 10 s (`settleMotion`, Drive + Home hook), tests prove a lull/creep doesn't unlock.

## B. Correctness
- [x] B1 One server-side HOS read (carrier cycle) for Abel, context, paper-log line, Smart Path (King D-1).
- [x] B2 Migration 00052 byte-identical to main (King D-3).
- [x] B3 Telegram paper-log approval prompt names flagged stretches (owner naming condition).
- [x] B4 UX-02 — Home reads `useHosWindow` (full carrier window) + the cycle warning; test `HomeNextStep.test.tsx` proves no 200-row duty-logs request Home's "Your next step" HOS summary uses the full carrier window, not 200 rows + the old summary.
- [x] B5 UX-06 Day Wrap failure is visible, with retry.
- [x] B6 Duty-status location — `StatusSheet` "Use my GPS position" (coordinates + accuracy; typed fallback) — `PositionAndGps.test.tsx`: use GPS position when granted (typed fallback).
- [ ] B7 Telegram paper-log: a dropped/missing mid-day span is still covered by the previous status on approval — **needs owner/King ruling** (by-word fill vs stop-at-gap).
- [ ] B8 Day graph positions on 23/25-hour DST days (known limit; edit-panel times are exact).
- [ ] B9 Live two-company proof (NV-3) against the real Supabase project — **King**.
- [ ] B10 Migration 00058: confirm against the live migration ledger that it was never applied (Claude created it 2026-11-04 and never applied it). If it had been, a new numbered migration must add the 3 new tables.

## C. Home (owner-operator cockpit)
- [x] C1 HUD first on Home: status, time-in-status, four live rings, status buttons.
- [x] C2 Live Home: Day Wrap and news banner follow the live layer.
- [x] C3 UX-07 Home order: HUD → banner → next step → active plan → day wrap.
- [x] C4 Active-load card — `ActiveLoadCard` + `lib/active-load.ts`; rate worded as operational revenue; overdue asks, never assumes on Home (route, dates, rate as operational revenue, miles, status).
- [x] C5 UX-04 Live GPS position card — `HomePositionCard`, only with a fresh fix (<60 s), says phone GPS ± accuracy/age on Home (only when a recent fix exists; honest about accuracy/age).
- [x] C6 UX-08 — `NumberTicker` on Home money figures Number animation on Home money figures (reduced-motion safe).
- [x] C7 UX-09 — `WordReveal` on the banner headline; also fixed WordReveal's screen-reader bug (aria-label on a span) News headline word-reveal transition (reduced-motion safe).
- [ ] C8 UX-05 Image-led news: **design written (`news-banner-images.md`); build needs the owner's OK on the image source + a safe image proxy** (see `docs/design/news-banner-images.md`).

## D. Drive Mode
- [x] D1 UX-03 — `DriveClocks` on the moving surface, full Drive screen and preview HOS clocks alongside the route (compact strip on the moving surface and the full screen).
- [x] D2 Status prompt — `DriveStatusPrompt` offers, never books; behind the motion gate (never automatic): offer "Log Driving" at GO, "Off/On duty" when parked/ended.
- [ ] D3 Background GPS (Drive is foreground-only) — product decision; documented.
- [ ] D4 Rerouting (Drive follows a checked plan, never replans) — product decision; documented.
- [ ] D5 Spoken maneuver instructions — unverified; investigate.

## E. Process and records
- [x] E1 PROJECT_STATE.md reconciled with main's actual history.
- [x] E2 HUD spec status updated (was DRAFT).
- [x] E3 — `docs/design/driver-usability.md` `docs/design/driver-usability.md` (the missing consolidated design).
- [ ] E4 UX-10 Visual audit covers 14 of 62 pages — **King** captures the rest after deploy (Drive, forms, details, HUD/day view/paper-log, banner states).
- [ ] E5 Maintainability: decompose `drive.ts` (1018), Drive page, `photo-purpose.ts` (1031), `globals.css` (~2,200).
- [ ] E6 Self-audit of this cycle's work (pitfall hunt, regression tests proven to fail on the bug).
- [ ] E7 Land on `main` (fast-forward), verify the tree, report coordinates.
