# Verification of the 2026-11-19 full-repository audit

**Checked against:** `main` at `26a3c96` (2026-11-20). Source only. The live Supabase grants, Fly config and devices were **not** inspected from here: the sandbox cannot reach them. Each "NEEDS LIVE" item says what King must check.
**Audit:** `docs/audits/full-repository-audit-2026-11-19.md` on branch `audit/full-repository-2026-11-19`.
**Status:** investigation and design only. Nothing below is implemented; each fix waits for the owner's approval.

## Results

| # | Finding | Result | Evidence (current main) |
|---|---|---|---|
| F-001 | Outbound-call claim RPC callable too broadly | **VERIFIED in source; NEEDS LIVE grants** | `00100_outbound_calls.sql:50-82`: `security definer`; no `set search_path`; no `revoke execute`; trusts `p_company_id` with no caller check. |
| F-002 | Business Credit owner-only not enforced in DB | **VERIFIED (design gap); low risk today** | `00087`: "tenant isolation" policies are company-wide, not owner-only. Today the company has one member (the owner), so no one else can read it yet. It becomes real when drivers get logins. |
| F-003 / F-011 | Auto Off Duty after 2 h parked | **Behaviour = owner decision (2026-11-17: "Auto Off Duty after 2h"). One part VERIFIED as a defect: the false log note.** | `auto-motion.ts:370`: the note says "no answer to 'going off duty?'", but no such question is sent anywhere in `src/`. The duty record claims a prompt that never happened. |
| F-004 | Weekly recap turns failures into $0 | **VERIFIED (fuel)** | `weekly-recap.ts:90`: `fuelRes.error ? 0 : ...` — a failed fuel query reads as $0. Loads use confirmed + completed by delivery date — a deliberate rule (loads past their date that were never marked complete), to be confirmed by the owner. |
| F-005 / F-016 | Queued calls skip the kill switches | **VERIFIED** | The kill switch (`ai_globally_disabled` + `outbound_calling`) is read only in `outbound-call-tools.ts:43-60`. The Telnyx webhook's claim-and-dial (`route.ts:~132`) does not re-check it. |
| F-006 / F-017 | Call lifecycle: orphan calls / late webhooks | **PARTLY VERIFIED** | Hangup and conversation-ended both set the end state (`route.ts:98-111`) with no terminal-state guard, and there is no compensating hangup when assistant startup fails. Needs a state-machine design. |
| F-007 / F-014 | Single-column tenant FKs | **VERIFIED** | `00097:21` `statement_document_id references documents (id)`; `00099:10` and `00100:14` `driver_id references drivers (id)` — not `(company_id, id)`. |
| F-008 | Composite `ON DELETE SET NULL` nulls the tenant key | **VERIFIED in source** | `00087:153-154`: `foreign key (company_id, email_message_id) ... on delete set null` sets **both** columns, and `company_id` is NOT NULL. Deleting a linked email row would fail. Fix: `on delete set null (email_message_id)` (PostgreSQL 15+). |
| F-009 / F-015 | Regex write-intent gate | **VERIFIED** | `execute-gate.ts:13-14`: `miles`, `delivered`, `mark` and similar match questions and negations. No dedicated gate test found. It is a second layer, not the only authorization. |
| F-010 | Tenant-FK SQL test not executed | **CONFIRMED (gap)** | `tests/db/tenant-fk.sql` needs a disposable database built from every migration. |
| F-012 / F-021 | Missing GPS accuracy treated as perfect | **VERIFIED** | `live-motion.ts:54`: `(cur.accuracyM ?? 0) > MAX_ACCURACY_M` — unknown accuracy passes. |
| F-013 / F-020 | Device-feed rate limit per process | **VERIFIED; low risk today** | `device-feed.ts:83` uses an in-memory Map. `fly.toml` runs `min_machines_running = 1`; the risk is real only if scaled out. |
| F-018 | Android backup may copy the device key | **VERIFIED in source; NEEDS DEVICE check** | Manifest line 5: `android:allowBackup="true"`; no backup rules. The key is in SharedPreferences `tracker_native`. |
| F-019 | Tracker drops a batch on HTTP 400 | **VERIFIED** | `TrackerService.java:275-282`: a 400 is treated like success and the batch is dropped (logged). |
| F-022 | Bot proposal decisions: no owner-role check | **VERIFIED** | `api/bots/proposals/route.ts`: no `role` check; `decidedBy` is hard-coded. |
| F-023 | Bot spend cap fails open with no store | **VERIFIED** | `bots/group.ts`: the cap check runs only `if (store)`. With no store the model is still called. |
| F-024 | Spend-cap race | **VERIFIED (by design)** | The cap is read, then the model is called, then the spend is recorded — concurrent turns can both pass. |
| F-025 | Bot-team FKs not tenant-composite | **MOSTLY NOT AN ISSUE** | `bot_identities` is global (by slug), not tenant data. One real gap: `bot_group_messages.telegram_chat_id -> bot_group_rooms` does not tie the company. Low risk (the room is keyed by Telegram's own unique chat id). |

## Proposed fixes (each needs the owner's yes)

1. **F-001 — call queue function.** New migration `00106`:
   - `set search_path = public`;
   - inside the function, refuse unless the caller is the server (service role) **or** `p_company_id = private.current_company_id()`;
   - Execute permission is NOT revoked from logged-in users: Abel's web chat places calls with the owner's session (`api/v1/assistant/chat` → `createBotStore(supabase, ...)`). Revoking would break it.
   - Test: two companies, a cross-company claim refused.
2. **F-005/F-016 — kill switch.** One shared `canPlaceOutboundCall(client, companyId)` check, called before **every** dial: the tool, the webhook queue step, and any retry. Off means nothing is claimed or dialed. Test: switch off with a queued call → no dial.
3. **F-003 — false log note.** Reword the automatic Off Duty note so it states only what happened: "truck parked 2+ hours with no movement — switched automatically; change it if wrong". **Separate owner question:** keep auto Off Duty after 2 h, or ask first and only switch after no answer (the audit's recommendation for compliance)?
4. **F-022 — proposal decisions.** Require the owner role on the decision route, and record the real user id, not a hard-coded "owner".
5. **F-023 — spend cap.** No store means no paid model call; say so plainly.
   - **F-024:** reserve the estimated spend before the call (one atomic insert, cap checked in the same statement), settle after.
6. **F-007/F-008/F-014 — tenant keys.** New migration:
   - composite `(company_id, …)` FKs for `paycheck_confirmations.statement_document_id`, `monthly_income_goals.driver_id` and `outbound_calls.driver_id`, using the 00070/00090 pattern;
   - `on delete set null (email_message_id)` for F-008.
   - Run `tests/db/tenant-fk.sql` on a scratch database built from all migrations (F-010).
7. **F-012/F-021 — GPS quality.** Unknown accuracy counts as **unknown**, not perfect: it is never used to start Driving or prove a stop.
   - Tracker 1.3: send accuracy on every fix, and skip fixes worse than 100 m.
   - **Caution, recorded:** the 2026-11-19 auto-switch fix relies on good-accuracy pairs; this tightens, never loosens.
8. **F-004 — recap.** A failed fuel or expense read says "fuel couldn't be read this week", never $0.
9. **F-019 — tracker 400.** Keep the batch and retry fix by fix, so one bad fix can't drop 60 good ones; log what the server rejected. Ships in Tracker 1.3.
10. **F-018 — backup.** `android:allowBackup="false"` (or exclude `tracker_native`) in Tracker 1.3. After installing it, the owner re-enters the key once if the phone is restored.
11. **F-009/F-015 — intent gate.** Add a test matrix (questions, negations, quotes, real orders) and tighten the patterns. It stays a second layer, never the only authorization.
12. **F-006/F-017 — call state machine.** Design doc first (terminal states final, events idempotent, hang up on failed assistant start), then code.
13. **F-013 — rate limit.** Leave as is while Fly runs one machine; note it in `fly.toml` and the design. Move it to the database before scaling out.
14. **F-002 — Business Credit.** Owner-only policy in the database (company + role = owner) before drivers get logins.

## For King (live checks this sandbox cannot do)

- F-001: `select has_function_privilege('authenticated', 'claim_next_outbound_call(uuid)', 'execute');` on production.
- F-002: effective policies on the `business_credit_*` tables.
- F-018: whether Android backup actually includes the tracker preferences on the owner's phone.
