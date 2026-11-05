-- 00063 - Employer pay profiles (docs/design/employer-pay-profile.md).
-- Pay terms are DATA per employer, never hardcoded: rate in integer cents
-- per mile, which miles count, W2 vs 1099, who pays fuel. A change of terms
-- is a NEW dated row (the old one gets an effective_to); history is kept.
--
-- mile_basis and worker_type are NULL until the owner (or Abel, with his
-- yes) sets them - NULL means visibly UNSET, and nothing computes from an
-- unset basis or worker type.
--
-- STRUCTURE ONLY (owner ruling 2026-11-05): no seed row, no employer name,
-- no rate. The app is employer-agnostic all the way down; the current terms
-- are entered as live data after deployment.
-- (Numbered 00063: 00061 is trip intake and 00062 is load stops.)

create table employer_pay_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  employer_name text not null check (length(btrim(employer_name)) > 0),
  rate_cents_per_mile integer not null check (rate_cents_per_mile >= 0),
  mile_basis text
    constraint employer_pay_profiles_basis_valid check (mile_basis is null or mile_basis in ('loaded', 'all', 'practical')),
  worker_type text
    constraint employer_pay_profiles_worker_valid check (worker_type is null or worker_type in ('w2', '1099')),
  fuel_paid_by text
    constraint employer_pay_profiles_fuel_valid check (fuel_paid_by is null or fuel_paid_by in ('employer', 'driver')),
  effective_from date not null default current_date,
  effective_to date,
  constraint employer_pay_profiles_dates_ordered check (effective_to is null or effective_to >= effective_from),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One current (open-ended) profile per employer.
create unique index employer_pay_profiles_one_current
  on employer_pay_profiles (company_id, lower(employer_name))
  where effective_to is null and deleted_at is null;

alter table employer_pay_profiles enable row level security;

create policy "tenant isolation" on employer_pay_profiles
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
