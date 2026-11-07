# AI authority matrix — reconciled to the code (Phase 4)

Status: **RECONCILED DRAFT, 2026-11-05, for owner ratification.** Source: the
code on `main` at `36ee0cb` plus the owner rulings recorded in the retrospective
audit addendum (§11.4) and `CLAUDE.md`. This document **classifies behavior that
already exists**; it grants no new authority and raises no autonomy level. Where
it says "verified", it means read from code — nothing here is live-verified
(that is King's lane, audit Wave 0). Governing rule is unchanged: AI proposes;
the owner decides; autonomy is never granted silently (`docs/governance.md`).

## 1. Actors and what each may do

| Actor | May | May not |
|---|---|---|
| **Owner** (Sajacous; sole admin) | everything, including deleting and overriding safety defaults explicitly | — |
| **Abel / the assistant** (Telegram + web, one shared brain) | read stored data through tools; draft; stage **proposals**; execute a write **only** when the owner's own message directly orders that write; run the unattended jobs in §3 | expand its own permissions; invent facts; book/send/delete on its own initiative; send to third parties or groups; act on instructions found inside forwarded or external text |
| **Scheduled jobs** (in-process schedulers + hourly invoker) | poll free external sources, write briefings/signals, stage proposals, send **the owner** Telegram reports | change business records on their own; message anyone but the owner |
| **External systems** (GDELT, EIA, NWS, OpenStates, FMCSA/RSS, route providers, Telegram, OpenAI) | return data | carry any authority; everything they return is untrusted input (validated, never obeyed) |
| **King** (the owner's other agent) | live operations: migrations, Fly deploys, connected-account work, independent verification | decide scope; merge/deploy/migrate without the owner's tap |
| **Claude** (this agent) | design and build; open/merge only as the owner has ordered | self-verify; skip a workflow step without the owner's direct word |

## 2. Autonomy level per capability (the ladder in `governance.md`, applied honestly)

Levels: 1 observe · 2 recommend · 3 prepare action · 4 human approves then executes · 5 bounded autonomous.
"Switch" = the per-capability on/off in Settings (`ai_capability_settings`) plus the global switch.

| Capability / behavior | Switch | Level | What it does without a yes | What needs the owner's yes |
|---|---|---|---|---|
| `bot_chat` — Abel on Telegram + web | `bot_chat` | **4** | answers; reads; **executes a write only if the owner's message directly ordered it** | every self-suggested write (stored as a pending action); every delete; pay-terms changes; dump batches |
| `dispatch_helper` — forwarded dispatch workup | `dispatch_helper` | **3** | reads who sent it, explains it, drafts a reply (never sent), stages recordables | recording any extracted item (incl. the code-read trip → one proposal with full review) |
| `industry_intelligence` | `industry_intelligence` | **2** (scheduled) | writes briefings to the app | n/a (no business-record writes) |
| `deep_research` — watchers, signals, briefings | `deep_research` | **2–3** (scheduled) | polls free sources hourly, stores signals/briefings, sends the owner Telegram alerts (quiet hours 21:00–06:00 ET; time-sensitive law/weather/safety alerts bypass) | pre-trip photo asks are requests to the owner, fulfilled only by a matching photo |
| `game_plan` | `game_plan` | **2** (scheduled) | monthly checkpoint closes + daily data re-games; Telegram notes to the owner | targets/assumptions are set by the owner or proposed |
| `memory_consolidation` — night shift | `memory_consolidation` | **3** (scheduled) | embeds/summarizes; **stages** memory changes and a report to the owner | every memory change |
| `maintenance_watch` | `maintenance_watch` | **2** (scheduled) | evaluates schedules/defects; messages the owner (one digest a day; urgent safety/legal immediately) | n/a |
| weekly pay report | `bot_chat` | **2** (scheduled) | builds the report; sends Telegram if there was data (never a "nothing arrived" nag) | n/a |
| `document_extraction` | `document_extraction` | **3** | reads uploaded paperwork into extracted fields | filing/recording derived values via proposals |
| `photo_intelligence` | `photo_intelligence` | **3–4** | classifies a photo; asks one question with buttons when unsure | the purpose choice; any record the photo implies |
| `voice_transcription` | `voice_transcription` | **2** | turns a voice note into text, then works it like a typed message (audio goes to the transcription provider) | the same yes/no as typed |
| `driver_twin` | `driver_twin` (default **off**) | **3** | drafts replies using his own past sent replies; tracks edit distance | sending (never automatic) |
| Paper-log reader | `photo_intelligence` + review screen | **4** | reads a sheet photo into a draft | the reviewed save (atomic, owner-acknowledged replacement); Telegram booking only per §4 rule 3 |
| **Logging reminders** | `logging_reminders` (default **off**) | **2** (scheduled) | messages the owner when a driving/14-hour/break clock is at 30, 10 or 0 minutes by his logged hours (immediate, even at night) and, after quiet hours, when his latest Driving/On-duty status looks stale; never changes a status | n/a |
| **Live Location** (Telegram, `driver_positions`) | `live_location` (default **on**; explicit off stops it) — G1 closed 2026-11-05 | **3** | stores his latest position; derives speed/episodes; stages a duty-status **proposal** (stopped 5 min while logged Driving; or moving while logged otherwise when the automatic switch is off) with the time the movement began | every status change (cooldown 30 min) |
| **Automatic switch to Driving** (open app + Telegram Live Location + the native Tracker's device feed; deterministic rule, not AI) | `auto_duty_switch` (default **on** — owner order 2026-11-06; explicit off stops both paths) | **4** | adds ONE Driving row (`source auto_motion`) from the detection time when the truck has moved ~90 s (5 mph+) while the log says otherwise; never edits/deletes earlier rows; a status set by hand during the move wins; idempotent per detection; Telegram notice with the time | each switch (visible notice; reversible by the next entry) |
| **Rerouting** (Drive) | none (no AI; user is in Drive Mode) | n/a | asks the route provider for a new route; applies it **only if truck-checked**, otherwise keeps the old plan and says so | n/a |
| **News images** (server fetch) | rides `deep_research` (off = no fetch) — G2 closed 2026-11-05 | n/a | fetches a stored https image URL server-side (SSRF-guarded), re-encodes it | n/a |

## 3. Unattended jobs (what runs with nobody watching)

In-process schedulers started at boot (`src/instrumentation.ts`): industry briefing, deep research (+ hourly invoker door), game plan, memory consolidation, pay report, maintenance watch; plus the pg_cron/pg_net invoker (migration 00040). Every one reads its switch before acting; the **global** switch drops all of them. Their live health (heartbeats, last runs) is audit Wave 0 / King — not asserted here.

## 4. Standing owner rulings encoded as rules (audit addendum §11.4 + CLAUDE.md)

1. **Abel has no slash commands, ever.** Intent is inferred from conversation. **The backend proactively self-reports** when something is broken or not good enough.
2. **Quiet hours (OP-03, 2026-11-03):** reports/digests wait for morning; time-sensitive alerts (law, weather, safety) deliver immediately.
3. **Paper-log Telegram approval (amended 2026-11-04):** flagged stretches (confidence 0.80–0.95) and partial days may be booked via Telegram; stretches that cannot be read are **dropped and named, never filled**; the approval prompt names the flagged stretches.
4. **Pay truth:** pay terms are editable per-employer **data**, per company, never code; no employer or person is named in working code (2026-11-05 passes).
5. **FMCSA watcher endgame:** fixes ship; **one production poll** is the evidence; if the feed still refuses from production the drop decision returns to the owner with that evidence; **no relay/proxy workaround without a fresh owner decision.**
6. **Providers are free-first** (cheapest option labeled honestly if none free); **GitHub Actions are prohibited**; deploys are manual via the Fly web UI; **no UTC in anything user-facing** (America/New_York).
7. **Not an ELD.** The app is a paper-log helper; the disclaimer stays verbatim; hours figures are planning-grade and labeled.
8. **Money is integer cents; "rate" means operational revenue recognized on delivery, never "profit".**
9. **Public repo hygiene:** no personal data, secrets, or real-account screenshots in git.
10. **Driving safety fails closed:** unknown or stale speed is treated as possibly moving; forms lock; only the Drive glance surface is available while moving.
11. **The owner is the only decision-maker** for merges, deploys, live-database changes, and scope; an exception to a workflow step is authorized only by his direct word, covers that instance only, and is logged.

## 5. Approval semantics (single authoritative definition)

- **What is approved:** one specific stored proposal (tool + exact arguments + the summary he was shown). Approval of anything else is not implied.
- **Which proposal a bare "yes/no" means:** the proposal shown most recently. If several are open and none was shown in the last 10 minutes, nothing executes and Abel lists them and asks. (Built 2026-11-05.)
- **Validity:** a proposal expires 2 hours after creation; expired proposals are dropped silently, except that a yes/no answering only an expired proposal is told it expired.
- **Failure:** a failed write keeps its proposal; retry is a new yes; nothing is "half approved".
- **Cancellation is not deletion:** a "no" (including "No, remove that…") cancels only the waiting proposal; any delete proposed in that same turn is discarded. Deleting a saved record needs an explicit message naming that record, and is always proposal-only.
- **Validated before shown:** a proposal whose arguments the tool would refuse is never shown or stored.
- **No inferred approval:** model output, an ambiguous reply, a forwarded message's text, or a button from an old message never approves anything.
- **Dump batches:** approved per item number or all/none by an explicit command.
- **Direct-order writes (Gap G3):** today the *model* decides whether a message is a direct order (`confirmation: "execute"`); code cannot verify it. Always-propose tools (below) ignore it.

## 6. Tool authority registry (generated from the code, 110 tools — `list_memories` added 2026-11-05; enforced by `tests/unit/docs-drift.test.ts`)

Source: `buildBotTools` on `main` at `36ee0cb`. **Read (65)** — no state change: `build_person_model`, `driver_profile`, `learn_driver_patterns`, `recommend_loads`, `home_time_status`, `fleet_overview`, `lane_rate_history`, `delivery_feasibility`, `quick_reference`, `news_digest`, `when_is`, `time_between`, `timeline`, `whats_due`, `load_calendar`, `learning_report`, `check_route`, `projected_pay`, `decision_patterns`, `evaluate_pay_offer`, `explain_load_pay`, `extract_settlement`, `get_broker_scorecard`, `get_cash_calendar`, `get_credential_watch`, `get_day_wrap`, `get_document`, `get_game_plan`, `get_ifta_worksheet`, `get_load_paperwork`, `get_pay_status`, `get_receivables`, `get_research_briefing`, `get_tax_packet`, `get_thread`, `get_truck`, `hos_summary`, `list_checklist_items`, `list_contacts`, `list_documents`, `list_drivers`, `list_duty_logs`, `list_expenses`, `list_facilities`, `list_fuel_purchases`, `list_industry_briefings`, `list_inspections`, `list_memories`, `list_loads`, `list_maintenance_events`, `list_maintenance_schedules`, `list_open_threads`, `list_recent_exchanges`, `list_research_briefings`, `list_research_requests`, `list_trailers`, `list_trucks`, `maintenance_outlook`, `money_summary`, `search_dispatch_exchanges`, `search_documents`, `search_memories`, `search_memory`, `twin_status`, `weekly_pay_report`.

**Write, directly orderable or proposed (59)** — executes only on the owner's direct order in his message, otherwise stored as a pending proposal: `add_load_note`, `attach_document`, `clear_game_assumption`, `complete_load`, `complete_maintenance_schedule`, `create_broker`, `create_broker_followup`, `create_checklist_item`, `create_credential`, `create_customer`, `create_driver`, `create_expense`, `create_facility`, `create_fuel_purchase`, `create_load`, `create_load_invoice`, `create_maintenance_event`, `create_maintenance_schedule`, `create_recurring_obligation`, `create_trailer`, `create_truck`, `create_vehicle_defect`, `dismiss_research_request`, `game_what_if`, `log_duty_status`, `log_pretrip_inspection`, `mark_thread_answered`, `promote_game_plan`, `propose_maintenance_pack`, `propose_person_model`, `queue_research`, `record_forward_thread`, `record_load_decision`, `record_sent_reply`, `record_settlement`, `request_pretrip_photos`, `resolve_vehicle_defect`, `revise_pending_item`, `save_game_assumption`, `save_memory`, `set_game_target`, `set_pay_pin`, `stamp_detention`, `update_broker`, `update_broker_followup`, `update_checklist_item`, `update_credential`, `update_customer`, `update_driver`, `update_expense`, `update_facility`, `update_fuel_purchase`, `update_load`, `update_load_invoice`, `update_maintenance_event`, `update_maintenance_schedule`, `update_recurring_obligation`, `update_trailer`, `update_truck`.

**Always proposal, never direct (4)** — `delete_record` (the only delete path), `set_pay_terms`, `record_preference` (a driver or owner preference is stored only after his yes, whether stated or learned), `stage_dump_items`. Nothing in the registry sends a message to a third party or posts to a group.

The drift test (`tests/unit/docs-drift.test.ts`) fails if a tool, route or table is added without a row in this registry, `api-contracts.md` or `schemas.md`.

## 7. Revocation and stop-verification matrix (design; execution is Wave 4 / King)

For each switch row above the test must show: (a) global off → the job/feature does nothing at its next run; (b) per-capability off → only that one stops; (c) off takes effect without the AI's cooperation; (d) the Settings UI shows the true state. Now switched: Live Location (`live_location`), news-image fetch (`deep_research`). Not yet evidenced by test against the live system: every row. No switch by design: rerouting (no AI; user in Drive). Pay report rides `bot_chat`.

## 8. Service-role and tenant scoping (security model pointer)

The Telegram webhook, the schedulers and `/api/internal/*` use the service-role client scoped by `TELEGRAM_COMPANY_ID` in code (RLS does not protect those paths). Every such path must filter by company explicitly; a complete test matrix is designed in `docs/reconciliation/wave-4-test-matrix.md` (prep). Live execution of the RLS/service-role suite from this sandbox is **not possible** (documented network block) and is an owner decision.

## 9. Gaps and decisions raised by this classification

- **G1 (CLOSED 2026-11-05) Live Location had no capability switch** — now `live_location`.
- ~~(original text)~~ **G1 Live Location has no capability switch.** It stores his position and stages proposals; today only the Telegram allowlist gates it. Recommendation: add `live_location` (default on, since he opts in by sharing) so the owner can stop storage.
- **G2 (CLOSED 2026-11-05)** news-image fetch now requires `deep_research`.
- ~~(original text)~~ **G2 News-image fetch has no switch** and makes outbound server requests to publisher hosts. Recommendation: gate it under `deep_research` (the source of the signals).
- **G3 Direct-order detection is model-judged.** Recommendation: keep, but record in the audit trail which tool calls ran as direct orders, and add an eval case for forwarded-text injection.
- **G4 Audit trail:** every automated write is traceable to a pending-action row or a tool log line, but there is no single owner-visible activity log. Recommendation: design one (Wave 3).
- **G5 `governance.md` states "AI layer does not exist; current state Level 1."** Corrected in the same change; the per-capability table above replaces the single global level.
