-- 00077 - Fleet learning (docs/design/fleet-learning-and-driver-questions.md, owner 2026-11-07).
--  1. person_preferences: what the owner and each driver prefer - stated by the owner, or LEARNED from decisions and
--     approved by him (source 'learned' only ever lands after his yes). Every row carries its plain-words evidence and
--     a confidence. Tenant-isolated; the driver reference is a composite (company_id, driver_id) FK like migration 00070.
--  2. load_decisions gain structured columns, so a decision can be learned from (destination region, trip length, rate per
--     mile, deadhead) instead of only read as free text.
-- ADDITIVE: nullable columns, a new table, no seed, nothing hardcoded to any person or employer.

create table person_preferences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  subject_type text not null
    constraint person_preferences_subject_valid check (subject_type in ('owner', 'driver')),
  driver_id uuid,
  key text not null check (length(btrim(key)) > 0),
  value jsonb not null,
  source text not null default 'stated'
    constraint person_preferences_source_valid check (source in ('stated', 'learned')),
  confidence numeric not null default 1
    constraint person_preferences_confidence_valid check (confidence >= 0 and confidence <= 1),
  evidence text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint person_preferences_driver_matches_subject check (
    (subject_type = 'driver' and driver_id is not null) or (subject_type = 'owner' and driver_id is null)
  ),
  constraint person_preferences_driver_tenant_fkey
    foreign key (company_id, driver_id) references drivers (company_id, id)
);

-- One live value per subject + key.
create unique index person_preferences_one_live
  on person_preferences (company_id, subject_type, coalesce(driver_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
  where deleted_at is null;

create index person_preferences_driver_idx
  on person_preferences (company_id, driver_id)
  where deleted_at is null and driver_id is not null;

alter table person_preferences enable row level security;

create policy "tenant isolation" on person_preferences
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

alter table load_decisions
  add column driver_id uuid,
  add column origin_state text
    constraint load_decisions_origin_state_len check (origin_state is null or length(origin_state) = 2),
  add column destination_state text
    constraint load_decisions_destination_state_len check (destination_state is null or length(destination_state) = 2),
  add column miles integer
    constraint load_decisions_miles_valid check (miles is null or miles >= 0),
  add column rate_cents integer
    constraint load_decisions_rate_valid check (rate_cents is null or rate_cents >= 0),
  add column deadhead_miles integer
    constraint load_decisions_deadhead_valid check (deadhead_miles is null or deadhead_miles >= 0),
  add column reason text;

alter table load_decisions
  add constraint load_decisions_driver_tenant_fkey
    foreign key (company_id, driver_id) references drivers (company_id, id);
