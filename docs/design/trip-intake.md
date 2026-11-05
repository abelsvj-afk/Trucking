# Trip Intake and confirmation lifecycle — design (Phases A–C built; D partly)

Status: 2026-11-05. Source: King's audit of the reported trip-assignment transcript, with the
claims below re-verified against `main` before acting.

## 1. Verified defects

| # | Claim | Verified in code | Status |
|---|---|---|---|
| 1 | A YES resolves the OLDEST pending action company-wide, any channel | `store.ts` `loadPendingRows`: `company_id` only, `created_at asc` | **FIXED (Phase B, owner-approved 2026-11-05)**: a bare yes/no targets the most recently shown proposal; with several open and none shown in the last 10 min it executes nothing and lists them |
| 2 | Proposals are stored without `validateArgs`; a broker NAME reached a uuid field | `agent-loop.ts` stored `writeArgs` raw | **FIXED (Phase A)**: validated before staging; invalid → model told, nothing shown/stored |
| 3 | `list_contacts` returned names only, so ids could not be found | `tools.ts` selected `name` | **FIXED (Phase A)**: returns `[id] name` |
| 4 | A failed write discarded the proposal | `resolvePending` cleared first | **FIXED (Phase A)**: failure re-stages the same proposal and says so |
| 5 | "No, remove that" became a delete-load proposal | prompt had no cancel≠delete rule | **FIXED**: a leading "No" cancels the waiting proposal in code and any `delete_record` proposed in that turn is discarded |
| 6 | English dispatch got a Spanish reply draft | model-selected language trusted | **FIXED**: for an English message the reply language is forced to English in code and a Spanish draft (by label or by reading the text) is dropped |
| 7 | Load has no trip number / broker reference / deadhead+loaded miles / per-stop state | schema | **BUILT (Phase C, migration 00061 — applied live per audit addendum §11.1)**: trip_number, broker_reference, deadhead/loaded miles (numeric 2dp), pickup_tz/delivery_tz, `load_tasks`. Per-stop arrival/departure already exist as detention stamps; a separate per-stop dispatcher-approval record is NOT built — approval is never assumed and stays a task the owner ticks |

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
  (numeric(8,2)), `load_stops` (kind, name, address, appointment_at +
  appointment_tz, arrived_at, departed_at, **approved_at** — set only by the owner's tap, never inferred), `load_tasks`. (As built; the plan's "approval_status" became the owner-tapped `approved_at`. Per-stop detention clocks remain separate `detention_stamps`.)
- Abel reminds and drafts the BOL message to the dispatch group but never sends to
  third parties (existing boundary).

## 4. Phase D

Reply language is forced to the sender's detected language in code; regression
suite: multiple pending, stale, failed write + retry, cancel-vs-delete, language.

## 5. Decide — RULED by the owner (2026-11-05): both approved; kept for the record

1. Approve Phase C's migration shape (trip number/reference/miles columns +
   `load_stops` + `load_tasks`).
2. Approve "bare YES targets the last-shown proposal; ambiguity lists them".

## 6. Built 2026-11-05 (owner approved both decisions)

- Phase B: targeting + ambiguity listing + cancel-in-code (tests in `agent-turn.test.ts`).
  Failed writes keep their proposal. Expiry behavior unchanged (2 h).
- Phase C: migration `00061_trip_intake.sql` (the Employer Pay Profile migration
  therefore moves to 00062); `create_load` takes the new fields and a `tasks`
  list saved in the same yes; Load detail shows trip, reference, exact miles,
  appointments in the facility's own zone, and a Trip tasks checklist
  (`/api/v1/load-tasks`). Frontend + bot + API ship together.
- Still open: Phase D language enforcement (Spanish draft for an English
  dispatch message); a structured multi-stop (3+) model; a forwarded-dispatch
  trigger that calls `create_load` with the trip fields is a prompt/extraction
  behavior and needs a real forwarded message to tune.

## 7. Built 2026-11-05, round 2 (owner: "do all the still open things")

- **Structured trip messages are read by code** (`lib/dispatch-trip.ts`): the
  structured-trip format ("NEW TRIP n HAS BEEN ASSIGNED", any number of STOP blocks,
  TRIP DETAILS, the dispatcher's ❗ lines). The model path had failed on this
  exact message ("origin: expected string"). The parser's `create_load` replaces
  any the model proposed; the broker NAME is resolved to an id in code (exact,
  case-insensitive; unknown = saved without a broker link and the review says
  so); the review shows every stop, appointment as written, miles and
  requirements before the one yes. Other formats (Amazon Relay, free text) still
  go through the model extraction, which now knows the same fields and a
  `stops` list; add a parser per format once real messages are available.
- **Stops** (migration `00062_load_stops.sql`; applied live per audit addendum §11.1): any number per
  load, each with its appointment in its own zone; arrived / dispatcher-approved
  / left are set only by the owner's tap on the load page.
- **Expired proposals** are dropped silently at the start of each turn (the one
  exception: if only an expired one remains and he answers yes/no, he is told).
- Pay profile migration number is now 00063.
