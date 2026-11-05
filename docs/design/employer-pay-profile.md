# Employer Pay Profile — design (spec; not built)

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
| employer_name | text | required, e.g. "Steven" (seed) |
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

- Seeded row: employer "Steven", 55¢, mile_basis and worker_type NULL.
- Terms are the owner's data, entered by him or confirmed via Abel; the app
  never infers them from a document without his confirmation.
- Public repo: the seed lives in the migration only as the owner-approved
  employer name and rate already stated in project docs; no personal data.

## 5. Decide

1. Per company (recommended — one owner) vs per driver. Default: per company.
2. Seed in the migration vs entered by the owner on first visit. Default: the
   migration seeds Steven/55¢ for company rows that have none.
3. Migration number: next free after 00061 (00063; 00061 is trip intake, 00062 load stops).

## 6. Build order

migration + RLS + tests → schema/service/route → Settings UI with unset chips
→ pay-advisor reads it → Abel proposal tool → docs/state.
