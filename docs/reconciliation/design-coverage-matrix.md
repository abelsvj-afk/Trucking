# Wave 3 — design coverage matrix (DRAFT for owner review)

Status: 2026-11-05, read from `main`. Answers the audit's Phase 7 gap ("no current, complete screen-by-screen design and acceptance matrix") and §6 register. Test evidence = test files that exist; **none of it is a live proof**. "Design of record" is the one document that wins when documents disagree.

## 1. The app surface

**65 pages** (`src/app/**/page.tsx`): auth (login, forgot/reset password) · Home (HUD) · Loads (list, new, detail) · Fleet (trucks, trailers, drivers, truck-profile, checklists, equipment-checklist, pre-trip inspections, maintenance events + schedule, Hours: list/new/detail/paper review) · Money (expenses, fuel purchases, summary + detail, truck fund) · More (assistant, brokers, customers, facilities, dispatch helper, documents, memories, research, industry intelligence, game plan, settings) · Smart Path + Drive.

**Moving / parked rule for every page (SAF-1, `MotionLock`):** when location permission is already granted and the phone reports moving **or the speed is unknown/stale**, every form on every page is inert with a banner saying why; reading is allowed; Drive Mode shows the glance surface (map kept; only Skip stop, I'm parked, Talk to Abel, Voice, Re-plan). With permission not granted nothing locks (the app cannot know) — **owner decision D-7:** accept that, or require a permission prompt on first run.

**Accessibility baseline:** WCAG 2.1 AA color contrast pinned by `contrast-guard.test.ts`; 44 px touch targets; focus rings; reduced-motion respected. A full page-by-page keyboard/screen-reader walkthrough is **not evidenced** (Wave 4).

## 2. Feature-family matrix

| Family | Design of record | Pages | APIs / tools | Tables | Status | Test evidence | Open |
|---|---|---|---|---|---|---|---|
| Home / HUD | `driver-hud.md` §2,§12 | Home | hos-window, day-wrap, live layer | duty_logs, loads… | built (Home map + proactive reminders **not**) | HomeIntegration, HomeLiveCards, DutyHud, hud-clocks | D-4 reminders/map |
| Loads / trips / stops / tasks | `trip-intake.md`, `record-lifecycle.md`, `money-and-revenue.md` | loads list/new/detail | loads, load-tasks, load-stops, detention, paperwork; `create_load` etc. | loads, load_tasks, load_stops, detention_stamps | built | dispatch-trip, stage-recordables, agent-turn, ActiveLoadCard | Relay parser (needs a real message) |
| Dispatch/Telegram intake | `driver-mvp.md` §2,§4,§11, `trip-intake.md` | More→Dispatch | dispatch-suggest, webhook | dispatch_exchanges, bot_pending_actions | built | dispatch.test, dispatch-bot*.test | rate limits not specified (D-10) |
| Fleet (trucks/trailers/drivers) | `data-model.md`, `ui-ux.md` | fleet/* | CRUD + restore | trucks, trailers, drivers | built | crud route tests | credentials UI missing → §3 |
| HOS / paper logs | `time-and-hos.md`, `driver-hud.md` §6, `driver-usability.md` | fleet/hos/* | hos-settings, paper-logs, hos-window | duty_logs, documents | built; acceptance on his own sheet pending | hos*.test, paper-day, PaperLogReview, DayLog | owner acceptance |
| Maintenance / pre-trip | `driver-mvp.md`, image-intelligence | fleet/maintenance*, pretrip* | CRUD, vehicle-defects, watcher | maintenance_*, vehicle_defects | built | maintenance*.test | — |
| Money / pay | `money-and-revenue.md`, `employer-pay-profile.md` | money/*, settings→Pay terms | financial-summary, pay-profiles; pay tools | expenses, fuel_purchases, settlements, employer_pay_profiles | built; **00063 unapplied** | fuel-math, financial-summary-page, pay-terms-settings, pay-* | tax math by worker type |
| Documents / photos / voice | `driver-mvp.md` §10, `record-lifecycle.md` | More→Documents | documents, upload | documents, cleanup_incidents | built | photo-*.test, voice-intake | retention (D-8) |
| Assistant / Abel | `ai-authority-matrix.md`, `ai-architecture.md`, `memory-architecture.md` | More→Assistant | assistant/chat; 109 tools | bot_* | built | agent-turn, agent-loop, omnipresence, eval harness | G3 injection eval |
| Telegram bot | `driver-mvp.md` §4, `event-contracts.md` | — | webhook | telegram_* | built | dispatch-bot*.test, live-location | rate limits (D-10) |
| Memory / threads / people | `memory-architecture.md` | More→Memories | memories; thread tools | bot_memories, forward_threads | built | memory-*.test, threads | retention, forget intent (D-8,D-9) |
| Smart Path / Drive | `driver-mvp.md` §8, `driver-usability.md` §4 | smart-path, drive | route-check, position | driver_positions | built; live Location unproven | drive*.test, DriveGlance, MotionLock, live-motion | G1 switch |
| News / industry | `research-engine.md`, `news-banner-images.md` | Home banner, More→Industry | news-image, industry-briefings | research_signals/briefings | built (FMCSA feed unresolved) | news-banner, NewsBanner, safe-image-fetch, news-image | G2 switch |
| Deep research | `research-engine.md`, `event-contracts.md` §5 | More→Research | research-briefings, internal invoker | research_* | built | research tests | production heartbeat (King) |
| Game Plan | `gaming-system.md` | More→Game plan | game-plan, game-targets | game_* | built | game-plan.test | — |
| Integrations | `architecture.md` addendum | — | integrations/* | — | built | per-client tests | inventory with limits/licensing (D-11) |
| Auth / account | `security.md`, `runtime.md` | login, forgot, reset, settings | Supabase auth | user_profiles | built | e2e recovery | change-password flow unevidenced |
| API / internal | `api-contracts.md` (route inventory appendix) | — | 115 route files | — | documented | — | drift check |

## 3. Features with no UI (CLAUDE.md "no backend-only delivery") — RULED 2026-11-05 (D-1)

**Update:** credentials and invoices/receivables now have screens (More → Credentials, Money → Invoices). The four below are documented **bot-only by design** (owner-approved exception): recurring obligations, broker follow-ups, IFTA worksheet, tax packet.

Original finding:

Resources with an API and Abel tools but **no page** that consumes them: `credentials` (credential watch), `load-invoices` + receivables/cash calendar, `recurring-obligations`, `broker-followups`, `ifta` worksheet, `tax-packet`. They are reachable only by asking Abel. The standing rule says user-facing functionality must ship a reachable interface. **Owner decision D-1:** classify each as *bot-only by design* (documented exception) or schedule screens.

## 4. Workflow flows for the current journey families
(Normal / alternative / failure / approval / cancellation / escalation / recovery.)

1. **Dispatch → trip.** N: forward → review → yes → saved id. A: unstructured message → model extraction → same review. F: bad field named, same trip kept; DB lacks migration → saved with trip fields in notes + said so. Ap: one yes per proposal. C: "no" cancels only the proposal. E: unreadable/ambiguous → ask, never guess. R: failed save retained; retry = yes.
2. **Stale/multiple proposals.** N: bare yes → last shown. A: several open → numbered list. F: expired → silent drop (told only if it was the only thing). Ap: by number/all/none for batches. C/E/R as above.
3. **Paper log.** N: photo → read → review → atomic save. A: by-hand entry when the reader is off. F: unreadable stretch dropped and named; save refused if it would silently overwrite non-acknowledged rows. Ap: explicit replacement acknowledgement. R: re-read/re-save.
4. **Drive.** N: GO → follow → arrive. A: skip stop / re-plan. F: GPS lost (banner, no dead reckoning), stale position, route provider down (old plan kept, plain words). Ap: n/a. E: "use the truck's own navigation" when no truck-checked route. R: Resume from checkpoint after tab death.
5. **Pay terms.** N: add terms → correction or new dated terms. F: bad rate → field error. C: no delete; close = new terms. Unset fields stay unset; no pay is computed from them.
6. **Photos/voice/docs.** N: infer purpose or one-tap ask. F: provider failure → filed as plain document, said so. Ap: purpose choice. R: re-send.
7. **Memory.** N: proposal → yes. C: no. E: same-name different person → proposal, never silent close. R: superseded rows stay answerable.
8. **Live Location.** N: share in Telegram → proposals only. F: stale (> 45 s) fix ignored by Drive. C: stop sharing in Telegram. E: none (no capability switch — G1).

## 5. Contradictions resolved in this wave (documents edited)
- `news-banner-images.md`: title/body said "not built" while status said all phases built → title now "design and as-built record"; §3/§5/§6 marked superseded/resolved/completed.
- `driver-hud.md`: header "NOT built" list and audit-disposition table rows corrected (image news, rerouting, background tracking, active-load cockpit, spoken turns built; proactive reminders and Home map still not built).
- `driver-usability.md` §8: stale "Open" list replaced with the real open list.
- `trip-intake.md`: "Decide" section marked ruled; planned `approval_status` reconciled to as-built `approved_at`; migration status lines corrected to the live ledger (applied through 00062).
- `employer-pay-profile.md`: seed removed everywhere; migration number 00063.
- Added the missing design: `memory-architecture.md`, `event-contracts.md`, this matrix.

## 6. Still unresolved (not guessable)
`ui-ux.md` still frames many screens as MVP; a screen-by-screen rewrite needs the visual walkthrough (King's refreshed audit after deploy) — **not attempted from docs alone**.
