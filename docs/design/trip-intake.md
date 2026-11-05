# Trip Intake and confirmation lifecycle — design (Phase A fixed; B–D not built)

Status: 2026-11-06. Source: King's audit of the Trip 1852 transcript, with the
claims below re-verified against `main` before acting.

## 1. Verified defects

| # | Claim | Verified in code | Status |
|---|---|---|---|
| 1 | A YES resolves the OLDEST pending action company-wide, any channel | `store.ts` `loadPendingRows`: `company_id` only, `created_at asc` | **OPEN (Phase B)** |
| 2 | Proposals are stored without `validateArgs`; a broker NAME reached a uuid field | `agent-loop.ts` stored `writeArgs` raw | **FIXED (Phase A)**: validated before staging; invalid → model told, nothing shown/stored |
| 3 | `list_contacts` returned names only, so ids could not be found | `tools.ts` selected `name` | **FIXED (Phase A)**: returns `[id] name` |
| 4 | A failed write discarded the proposal | `resolvePending` cleared first | **FIXED (Phase A)**: failure re-stages the same proposal and says so |
| 5 | "No, remove that" became a delete-load proposal | prompt had no cancel≠delete rule | **MITIGATED (Phase A)**: prompt rule; hard guard is Phase B |
| 6 | English dispatch got a Spanish reply draft | model-selected language trusted | OPEN (Phase D) |
| 7 | Load has no trip number / broker reference / deadhead+loaded miles / per-stop state | schema | OPEN (Phase C) |

Not verified here: live `bot_pending_actions` rows and which commit Fly runs.

Note on defect 1: the shared cross-channel timeline is a design choice (a
web proposal can be confirmed on Telegram). The fix is targeting, not
isolating channels.

## 2. Phase B — confirmation lifecycle

- Every proposal has an id and a state: `pending → executing → saved | failed`
  (failed keeps arguments; retry is idempotent via a per-proposal key stored on
  the created row, so a retry cannot double-create).
- A bare YES/NO targets the proposal the bot LAST SHOWN in this chat (store
  `last_shown_pending_id` per channel). If more than one is open and none was
  just shown, Abel lists them numbered and asks which; it never picks the oldest.
- Expiry never produces a prompt of its own; an expired proposal is dropped
  silently at the next listing and mentioned only if he answers it.
- "No/cancel/remove that" resolves only the targeted proposal. Deleting a saved
  load needs an explicit message naming that saved load; enforced in code (a
  `delete_record` proposal must cite a record id the owner's message names or the
  last-shown proposal referenced), not just by prompt.

## 3. Phase C — Trip Intake

- A forwarded dispatch assignment triggers one New Trip review: trip number,
  broker (resolved to an id by code; unknown → ask to create), broker reference,
  stops with facility-local appointment times (stored with their zone), deadhead /
  loaded / total miles (numeric, exact), dispatcher instructions as trip tasks
  (photos, seal, signed BOL, per-stop update, wait for approval).
- One confirmation → create load → reply with the real saved id and link. A
  failure names the exact field and keeps the same trip in context.
- Data model (needs migration + owner approval): `loads.trip_number`,
  `loads.broker_reference`, `loads.deadhead_miles`, `loads.loaded_miles`
  (numeric(8,2)), `load_stops` (kind, facility, address, appointment_at +
  appointment_tz, arrived_at, departed_at, approval_status), `load_tasks`.
- Abel reminds and drafts the BOL message to the dispatch group but never sends to
  third parties (existing boundary).

## 4. Phase D

Reply language is forced to the sender's detected language in code; regression
suite: multiple pending, stale, failed write + retry, cancel-vs-delete, language.

## 5. Decide

1. Approve Phase C's migration shape (trip number/reference/miles columns +
   `load_stops` + `load_tasks`).
2. Approve "bare YES targets the last-shown proposal; ambiguity lists them".
