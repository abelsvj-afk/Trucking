# Employer Pay Profile — design (BUILT 2026-11-05; migration 00063 NOT applied)

Status: DESIGN, 2026-11-05. Nothing here is implemented. Owner decisions are
marked **DECIDE**; defaults are stated so work can proceed once confirmed.

## 1. Why

The owner is an OTR lease-on driver today and will run his own company later.
Pay terms (cents per mile, which miles count, W2 vs 1099, fuel/insurance
deductions) differ by employer and change over time. Standing rule: **the app
is employer-agnostic — pay terms are editable per-employer data, never
hardcoded.** The pay advisor and any earnings figure read from the profile.

## 2. Data

Table `employer_pay_profiles` (company-scoped RLS like every table, soft
delete, created/updated timestamps):

| column | type | notes |
|---|---|---|
| id | uuid | |
| company_id | uuid | RLS |
| employer_name | text | required, entered by the owner |
| rate_cents_per_mile | integer | money is integer cents; 55¢ = 55 (seed) |
| mile_basis | text null | `loaded` / `all` / `practical` — **null = visibly UNSET** |
| worker_type | text null | `w2` / `1099` — **null = visibly UNSET** |
| fuel_paid_by | text null | `employer` / `driver` / null |
| effective_from | date | profiles are dated; a change adds a row, never edits history |
| effective_to | date null | null = current |
| notes | text null | |

No pay amount is ever computed from an UNSET `mile_basis` or `worker_type`:
figures that depend on them say "set miles basis to see this" instead of
guessing. One current profile per employer (partial unique index on
company+employer where effective_to is null and deleted_at is null).

## 3. Surfaces (frontend is mandatory)

- Settings → "Pay terms": list of profiles, edit form, visible "not set"
  chips for the null fields, history of earlier terms.
- Abel: `evaluate_pay_offer` reads the current profile for the comparison;
  tool to update it is a write tool → propose→yes (never silent).
- Money shown as rate "operational revenue recognized on delivery", never
  "profit"; payroll-tax math stays in `pay-advisor.ts`, selected by
  `worker_type` when set.

## 4. Safety / honesty

- NO SEED (owner ruling 2026-11-05, superseding the earlier seed pick): the migration creates structure only — no employer name, no rate. Current terms are entered as live data after deployment (Settings → Pay terms, or King in the database).
- Terms are the owner's data, entered by him or confirmed via Abel; the app
  never infers them from a document without his confirmation.
- Public repo: nothing about any employer is in the code or the migration.

## 5. Decide

1. Per company (recommended — one owner) vs per driver. Default: per company.
2. Seed in the migration vs entered by the owner on first visit. RULED: no seed;
   entered live.
3. Migration number: next free after 00061 (00063; 00061 is trip intake, 00062 load stops).

## 6. Build order

migration + RLS + tests → schema/service/route → Settings UI with unset chips
→ pay-advisor reads it → Abel proposal tool → docs/state.

## 7. Decided and built

Owner picks: (1) per company; (2) **no seed** — the migration creates structure
only and the app is employer-agnostic all the way down (ruling of 2026-11-05,
which replaced an earlier "seed" pick); (3) "migration 00061" — that
number was already taken by trip intake (00061) and load stops (00062), so it
ships as **`00063_employer_pay_profiles.sql`**, the next free number.

Built: table + RLS + one-open-row-per-employer index; `/api/v1/pay-profiles`;
Settings → "Pay terms" (empty until the owner adds terms; add form pre-fills
nothing; rate in dollars, stored as integer cents; Not set chips and a plain
note that nothing is calculated from unset fields; "Save correction" edits in
place; "Terms changed — start new terms" closes the old row then starts a dated
new one; earlier terms listed); Abel `set_pay_terms` (always a proposal for the
owner's yes; omitted fields keep their value, unset stays unset). The pay pin
falls back to the profile ONLY when no remembered pin exists and only once
`mile_basis` is loaded or all. Abel's pay prompts no longer name any employer
(they say "his carrier"). Not built: payroll-tax math selecting by worker type
beyond what the pin already carries.

## 8. Percent-of-load pay, per-load pay edit, weekly payday total (owner 2026-11-06)

Owner: "if I put my CPM and/or load percentage, it should tell me what I'm going to get
paid for the load and the cumulative weekly payday total - and I can edit all of it."

**Pay formula (still gross, still a projection).** Pay for a load = the MILE part +
the PERCENT part, each present only when its term is set:
- mile part = `rate_cents_per_mile` x the miles the basis counts (all the existing
  basis rules apply: loaded / all / practical / UNSET -> range, never a guess). A rate of 0
  means "no mile part" and then the miles basis is NOT needed.
- percent part = `percent_of_load_bps` (basis points, 8500 = 85.00%) x the load's `rate_cents`
  (the load's gross rate). A load without a rate cannot get a percent part: "can't project
  yet - this load has no rate", never a substituted number.
- Both set = both added ("and/or"). Neither set = nothing to project, said plainly.

**Edit everything.**
- Terms (CPM, percent, basis, pay week, payday): Settings -> Pay terms; "Save correction"
  edits in place, "Terms changed" starts dated new terms (unchanged from section 7).
- One load's pay: `loads.pay_override_cents` (integer cents, null = use the terms). When set it
  IS that load's expected pay ("set by you" - he may know the real rate-con split); it is shown
  as such, counts in the weekly total, and clearing it returns to the terms. Edited on the load page.
- Abel: `set_pay_terms` gains the percent, pay-week and payday fields; `update_load` gains
  the pay override. Both stay proposals for his yes.

**Pay week and payday (UNSET stays visible).** Two profile fields:
`pay_week_ends_on` (0 = Sunday .. 6 = Saturday), `statement_weekday` (the day the pay statement comes out) and `payday_weekday` (the day the money reaches his bank), same numbering. Owner's deal, 2026-11-06 (entered as data, never a default): week Sunday-Saturday, statement Thursday, paid Friday.
- A pay week is the 7 days ending on `pay_week_ends_on`; a load belongs to the week holding its
  delivery date (pickup date when none). Unset week end = Monday-Sunday (the existing behaviour),
  labeled as the default.
- Payday = the first `payday_weekday` after the week's last day. Unset payday = no payday date is
  shown (the totals still are).
- Surfaces: Money -> Projected pay shows THIS pay week so far (the running, cumulative total that
  grows as loads are added/delivered), LAST pay week and its payday when it has not passed, and
  every row says which part (miles / percent / his override) made the number. Booked and completed
  loads count; drafts and cancelled ones do not (unchanged).
- Not computed: tax, fuel, deductions, advances. The settlement is the final number.

**Migration 00074** (additive, nullable, no seed): `employer_pay_profiles.percent_of_load_bps`
(0..10000), `.pay_week_ends_on` (0..6), `.statement_weekday` (0..6), `.payday_weekday` (0..6); `loads.pay_override_cents` (>= 0).

## 9. Cash advances against a payday (owner 2026-11-07)

Owner: he has already taken advances against his current pay and wants them
netted against the real thing — expected pay for the pay period, minus the
advances taken out of that pay, equals the exact net he should receive on
payday. Section 8 said "advances: not built"; this section builds them.

**Data — `cash_advances` (migration 00079, structure only, no seed):**

| column | type | notes |
|---|---|---|
| id | uuid | |
| company_id | uuid | RLS tenant isolation like every table |
| driver_id | uuid null → drivers | **per-worker**: the worker who took the advance. Null = not assigned to a driver row (today: the owner himself, who has no driver row requirement). Never hardcoded to any employer or person. |
| amount_cents | integer > 0 | positive by design (like `fund_entries`): an advance is always money taken out; the deduction sign comes from what it is, never from a negative amount typed by hand |
| advance_date | date | the day the money was taken |
| note | text null | his words for what it was ("fuel advance", "Comchek", …) |
| created/updated/deleted_at | | standard soft-delete + submission idempotency columns (00041 pattern) |

An advance is **not** a `settlement_lines` row: settlement lines record what
a statement *did* deduct (kind `advance` exists there for that), and they
require a settlement. An advance here is recorded when it is *taken*, before
any statement exists, so the projection can net against it.

**Which payday an advance deducts from.** An advance belongs to the pay week
containing its `advance_date`, grouped with the pay terms in force on that
date — the exact rule that already groups finished loads into pay weeks
(`groupByPayWeek`). Its payday is that week's payday
(`paydayAfter(weekEnd, payday_weekday)`; no payday date is shown while the
payday weekday is UNSET). If his terms later change, an advance is re-grouped
by the same rule as his loads, so the two never drift apart.

**The net figure.** For any pay week or period:
`net = expected − advances`, applied to both ends of the expected range.
The advances total itself is always exact (it is money he counted out), so
while `mile_basis` is UNSET the net shows as a range minus an exact amount —
never one confident number (owner rule). A net can go negative when advances
exceed the week's expected pay; it is shown as the negative number it is,
with words ("more taken out than this week is expected to pay"), never
clamped to $0.

**Surfaces (frontend is mandatory):**
- **Money → Cash advances** (`/money/advances`): the entry point — add an
  advance (amount in dollars, date, optional driver, optional note), the
  list grouped by pay week with each week's payday and advances total, and
  delete for a mis-tap. Linked from the Money index, Paychecks and
  Projected pay.
- **Home → Projected pay preview**: this pay week's gross range, the
  advances taken out of it, and the net range he should receive.
- **Money → Projected pay**: per period (this week / last week) the same
  gross − advances = net lines.
- **Money → Paychecks**: each pay-week group shows its advances total and
  the net that should land; a week with advances but no finished loads
  still appears (money was taken against it). Header totals carry the
  advances total.
- **Home → Pay and hours card**: when advances exist, a line naming the
  total taken and pointing at Paychecks for the week-by-week net.

**Scope limits, stated plainly:** previews net every advance recorded for
the company in the period (today the company is him; `driver_id` is stored
per advance so a future multi-driver view can net per worker without a data
change). Abel/Telegram entry ("I took a $100 advance") is **phase 2**: it
fits the existing propose→yes write-tool pattern, but is not built in this
pass. Tax/fuel/other deductions stay out — the settlement is still the
final number.
