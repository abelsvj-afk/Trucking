-- Driver MVP (docs/design/driver-mvp.md §3). A manual, warn-only
-- paper-log helper: one row per duty-status start for a driver. This
-- is NOT an ELD and not an HOS system of record - the truck's ELD (or
-- official paper logs) stays the legal record. Same conventions as
-- every other table: company_id + tenant-isolation RLS, soft delete,
-- created_at/updated_at.

create table duty_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  driver_id uuid references drivers (id),
  load_id uuid references loads (id),
  duty_status text not null,
  constraint duty_logs_status_valid
    check (duty_status in ('off_duty', 'sleeper', 'driving', 'on_duty')),
  started_at timestamptz not null,
  location text,
  odometer integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint duty_logs_odometer_nonnegative check (odometer is null or odometer >= 0)
);

alter table duty_logs enable row level security;

create policy "tenant isolation" on duty_logs
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
