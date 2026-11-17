-- 00099 - Monthly income goal (owner 2026-11-17; design docs/design/monthly-income-goal.md).
-- "I have a target amount that I want to make for the month before I go home." One live goal per
-- driver (driver_id null = the owner-operator himself; a hired driver's id later), applying to every
-- month until changed. Not required before deploy: until applied the page shows the projection with
-- no goal and says the goal isn't switched on yet. Additive, tenant-isolated, soft delete, no seed.

create table monthly_income_goals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  driver_id uuid references drivers (id),
  target_cents bigint not null check (target_cents > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index monthly_income_goals_one_live
  on monthly_income_goals (company_id, coalesce(driver_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where deleted_at is null;

alter table monthly_income_goals enable row level security;

create policy "tenant isolation" on monthly_income_goals
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
