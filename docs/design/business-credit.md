# Business Credit — owner-only page, Abel tools, and the vendor-mail watch

Owner order 2026-11-10 (brief:
`files/Brief-Business-Credit-Page-2026-11-10.md` in the trucking goal).
Three pieces that share one data model:

1. **An owner-only page mechanism** — data-driven, one central check,
   enforced on the server. The Business Credit page is its first user.
2. **The Business Credit page** (More → Business Credit): his LLC's
   credit file at a glance — identity header read from data, and one
   row per tracked account (vendor, phase, reporting bureaus, next
   action, payment state + next due date when he actually owes one).
3. **Abel's side** — conversational tools (list + update, propose→yes
   like every Abel write) and an email watch over the company inbox:
   vendor mail that signals an invoice, a due date, a payment made, or
   a missed/late payment updates the account's payment fields
   AUTOMATICALLY (that narrow scope only) and buzzes his Telegram,
   routed through the same delivery gate as every other proactive
   buzz.

## 1. Owner-only pages: the mechanism

### The flag is data

Migration 00087 creates `page_access_rules`:

| column | meaning |
|---|---|
| `route_prefix` | the route the rule governs (e.g. `/more/business-credit`); prefix match, longest prefix wins |
| `owner_only` | true = only the company's owner role may see/reach it |
| `note` | why it's flagged (human context, editable) |

One seeded row flags `/more/business-credit`. Flagging another page
later is a data edit (a row), never a code change — the brief's core
requirement. The table is deployment configuration: RLS on, no
client policies at all (the server reads it through the session's
server client; nobody edits it from a browser session). If the table
is missing (00087 not yet applied), the reader degrades to the same
single seeded rule compiled in `src/lib/page-access.ts` — identical
semantics, so the gate never silently opens OR silently locks the
owner out of a page the brief ordered.

### One central check

`src/lib/page-access.ts` is the only place the question "may this
role see this route?" is answered:

- `isOwnerRole(role)` — `user_profiles.role` is `'owner'` for the
  company owner. A FUTURE driver account is any other role value
  (`'driver'`), i.e. simply not-owner; no second mechanism needed.
- `isRouteOwnerOnly(rules, pathname)` — pure, prefix match.
- `canAccessRoute(rules, role, pathname)` — pure decision.
- `loadPageAccessRules(client)` — reads the table, falls back to the
  compiled seed on any error (missing table included).

Both consumers call it:

- **Nav** — the More index (`src/app/(app)/more/page.tsx`) is a
  server component: it resolves the caller's role server-side and
  filters owner-only sections out of the rendered list. A non-owner
  never receives the link in the HTML.
- **Enforcement** — the page/API data route
  (`GET /api/v1/business-credit`) re-checks through the same helper
  and answers 403 for a non-owner. The page itself renders nothing
  but the data route's answer, so a direct navigation by a
  non-owner yields the refusal, never the data. (Client hiding alone
  is not enforcement; the 403 is.)

The owner himself always passes: his profile role is `'owner'`
(00001's default).

## 2. Data model (migration 00087)

All tenant-isolated under the usual posture (00078's shape): RLS on,
one "tenant isolation" policy per table keyed to
`private.current_company_id()`, composite `(company_id, id)`
uniques, anon writes 0 by the 00067 defaults. No seed touches any
other company: identity + account seeds are inserted per company
that has none yet, guarded by NOT EXISTS.

### `business_credit_profiles` — one row per company

The identity header, as DATA (editable, never code constants):
`legal_name`, `filed_name`, `duns`, `sunbiz_doc`, `sunbiz_status`,
`registered_address`, `business_email`. Seeded with the brief's
verified facts:

- SAJACOUS MIXED IT LLC (filed as SAJACOUSMIXEDIT LLC)
- D-U-N-S 144-350783
- Sunbiz L26000135400, ACTIVE
- 720 N US Highway 441 #1021, Lady Lake, FL 32159
- owner@roadtolegacytrucking.com

There is deliberately **no EIN column anywhere** — the brief forbids
displaying one and none was provided.

### `business_credit_accounts` — one row per tracked account

| column | meaning |
|---|---|
| `vendor` | display name ("Quill") |
| `vendor_key` | stable key (`quill`) Abel's tools address |
| `status` | the phase in words ("Account established", "In progress — blocked") — free text, editable by design |
| `reports_to` | text[] of bureaus ("Dun & Bradstreet", "Experian", "Equifax", "Creditsafe") |
| `next_action` | the next step, in words |
| `payment_state` | `none` (default — nothing owed) / `invoice_open` / `due_soon` / `paid` / `missed` |
| `next_due_date` | date, NULLABLE — null means no payment expected; the UI shows nothing, never a fake date |
| `amount_due_cents` | nullable, same rule |
| `match_senders` | text[] — sender addresses/domains that identify this vendor's mail (DATA, not code) |
| `notes` | free notes (the parked eCredable terms, the Quill cart) |
| `sort_order`, `deleted_at` | list order; soft delete |

Seeded rows (brief §2, verified 2026-11-10): Dun & Bradstreet,
Quill, Uline, eCredable Business Lift, Nav, Bluevine — with the
phases, bureaus, next actions, and match senders (`dnb.com`,
`quill.com`, `uline.com`, `ecredable.com`, `nav.com`,
`bluevine.com`) from the brief. eCredable is seeded PARKED
(status words say so); nothing in this build activates any
subscription, and the app never places the Quill order — those are
the owner's acts, outside the app.

### `business_credit_events` — the audit trail

One row per watch-driven or tool-driven change: `account_id`
(composite tenant FK), `source` (`email_watch` / `abel_tool` /
`owner`), `signal` (invoice / due_date / payment_made / missed /
update), `email_message_id` (composite tenant FK to
`email_messages`, nullable — set for watch events), `summary`,
`detail` jsonb (before/after of the changed fields), `created_at`.
Abel can show him exactly what mail caused what change
(`list_business_credit_accounts` includes the recent events).

## 3. Abel's conversational tools

`src/services/bot/business-credit-tools.ts`, registered in the one
registry like every module:

- `list_business_credit_accounts` (read) — identity + every account
  with payment state/due and the newest audit events.
- `update_business_credit_account` (write) — vendor_key + any of
  status / next_action / payment_state / next_due_date /
  amount_due_cents / notes / reports_to. It follows the standing
  propose→yes discipline automatically (write tools stage in
  `bot_pending_actions` unless his message is a direct order). On
  execution it writes the change AND a `business_credit_events` row
  (source `abel_tool`).

On a database where 00087 hasn't landed, both tools answer with one
honest "not switched on yet" sentence — the 00084 pattern.

## 4. The email watch

Integration point: `triageAndSurface` in
`src/services/email/ingest.ts` — the one pass every freshly stored
message already flows through, for BOTH mailboxes (owner@ is where
vendor mail lands, but the watch doesn't care which box it arrived
in). After the surfacing loop, each waiting message runs through the
watch ONCE (only messages this poll triaged — the pass is over the
poll's own fresh set, so a message is never re-watched).

`src/services/business-credit/watch.ts` is pure + store-shaped for
tests:

- `matchVendorAccount(accounts, msg)` — sender address/domain
  against each account's `match_senders` (exact address, exact
  domain, or subdomain of a listed domain).
- `detectPaymentSignal(msg)` — code-side pattern classification
  over subject + body text (no model call, deterministic, tested):
  missed/late language FIRST (so "your payment is past due" can
  never be read as a routine due date), then payment-made, then
  invoice, then due-date. A due date is extracted only from an
  explicit ISO date or a "due <Month D, YYYY>" phrase — never
  guessed; an amount only from an explicit dollar figure next to
  due/balance/invoice wording.
- The application step updates ONLY `payment_state` and
  `next_due_date` / `amount_due_cents` when the mail states them
  (a payment-made clears the due date; a missed marks `missed`).
  Status/phase is NEVER changed from mail — at most the audit event
  proposes it in words.
- Every signal writes a `business_credit_events` row with the
  `email_messages` row id + the server Message-ID, the signal, and
  before/after — the audit Abel can recite.
- A signal that changes nothing (same state re-stated) is logged
  once per message and never re-buzzes: the events table's
  `(account, email_message)` pair is the dedupe.

### Telegram routing

The buzz text is composed in code, then gated by the EXISTING
`deliveryDecision` (`src/services/research/delivery.ts`) with the
research config — the exact gate the pay report and maintenance
watcher already consult:

- **missed/late → class `urgent`** — sends immediately, quiet hours
  and driving hold do not apply (owner's 2026-11-03 doctrine:
  time-sensitive comes straight through).
- **invoice / due date / payment made → class `routine`** — held
  through quiet hours (21:00–06:00 ET) and while he's driving/on
  duty. The hold is durable: the event row records `buzz_state =
  'held'`; at the start of every later poll's watch pass, a flush
  step re-runs `deliveryDecision` for every held event and sends the
  buzz (marking it `sent`) as soon as the gate says send — the same
  hold semantics as the research briefing queue, no new scheduler.

Payment-state updates land in the database IMMEDIATELY either way —
only the buzz waits. The page is never behind the mail.

## 5. The page

`src/app/(app)/more/business-credit/page.tsx` + `GET
/api/v1/business-credit` (createApiHandler, auth + the owner-only
check, RLS fences the company). Client page in the Research page's
shape: identity header card (gold accent, from data), account cards
(vendor, status chip, reports-to, next action, payment state + due
date formatted in America/New_York via `formatDate`, amount when
present), an honest "not switched on yet" state pre-00087, and the
recent audit events in small print so he can see what the watch did.
Black-and-gold per the UI round (gold #c9a227). No EIN anywhere —
there is no field for one.

## 6. What this build does NOT do

- No migration is applied and nothing deploys from the build lane —
  King applies 00087 and deploys after merge (merge → apply → deploy
  order, like 00084–00086).
- No subscription is activated, no order is placed, no mail is sent.
  The watch only reads mail the inbox already stored.
- No new proactive-send path: the buzz rides `deliveryDecision` and
  the existing Telegram notifier, both unchanged.
