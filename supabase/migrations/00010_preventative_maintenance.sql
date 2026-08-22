-- Tasks 3.13/3.14/3.15 (TASKS.md), per docs/schemas.md's additions.
-- Preventative maintenance, added on the owner's explicit request:
-- maintenance_events (already built) only records repairs after
-- something breaks; these three tables let the owner track what's
-- coming due (maintenance_schedules), what should be on board
-- (equipment_checklist_items), and pre-trip walkaround outcomes
-- (pretrip_inspections). Same conventions as every other table:
-- company_id + tenant-isolation RLS, soft delete, created_at/updated_at.

create table maintenance_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  truck_id uuid references trucks (id),
  trailer_id uuid references trailers (id),
  description text not null,
  interval_miles integer,
  interval_days integer,
  last_done_date date,
  last_done_mileage integer,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint maintenance_schedules_exactly_one_vehicle
    check ((truck_id is not null) <> (trailer_id is not null)),
  constraint maintenance_schedules_has_an_interval
    check (interval_miles is not null or interval_days is not null)
);

create table equipment_checklist_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  truck_id uuid references trucks (id),
  trailer_id uuid references trailers (id),
  item_name text not null,
  quantity_on_hand integer,
  last_checked_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint equipment_checklist_items_exactly_one_vehicle
    check ((truck_id is not null) <> (trailer_id is not null))
);

create table pretrip_inspections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  truck_id uuid references trucks (id),
  trailer_id uuid references trailers (id),
  driver_id uuid references drivers (id),
  inspected_at timestamptz not null,
  passed boolean not null,
  defects_found text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint pretrip_inspections_exactly_one_vehicle
    check ((truck_id is not null) <> (trailer_id is not null))
);

alter table maintenance_schedules enable row level security;
alter table equipment_checklist_items enable row level security;
alter table pretrip_inspections enable row level security;

create policy "tenant isolation" on maintenance_schedules
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create policy "tenant isolation" on equipment_checklist_items
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create policy "tenant isolation" on pretrip_inspections
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
