-- Task 1.4 (TASKS.md), part 1 of 3. trucks, trailers, drivers, customers,
-- brokers - per docs/schemas.md. Every table: company_id + tenant-isolation
-- RLS policy (see current_company_id() in 00001), soft delete via
-- deleted_at, created_at/updated_at.

create table trucks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  unit_number text not null,
  vin text,
  make text,
  model text,
  year integer,
  status text not null default 'active',
  current_mileage integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table trailers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  unit_number text not null,
  vin text,
  trailer_type text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table drivers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  cdl_number text,
  assigned_truck_id uuid references trucks (id),
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  contact_email text,
  contact_phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table brokers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  mc_number text,
  contact_email text,
  contact_phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table trucks enable row level security;
alter table trailers enable row level security;
alter table drivers enable row level security;
alter table customers enable row level security;
alter table brokers enable row level security;

create policy "tenant isolation" on trucks
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

create policy "tenant isolation" on trailers
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

create policy "tenant isolation" on drivers
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

create policy "tenant isolation" on customers
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

create policy "tenant isolation" on brokers
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());
