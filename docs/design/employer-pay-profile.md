# Employer Pay Profile — design (BUILT 2026-11-06; migration 00063 NOT applied)

Status: DESIGN, 2026-11-06. Nothing here is implemented. Owner decisions are
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
