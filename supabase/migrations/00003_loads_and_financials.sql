-- Task 1.4 (TASKS.md), part 2 of 3. loads, expenses, fuel_purchases,
-- maintenance_events - per docs/schemas.md. Money stored as integer cents
-- (docs/schemas.md's global convention). Business-rule validation (date
-- ordering, non-negative amounts) is enforced in services/db per
-- docs/design/data-model.md, deliberately not duplicated here as DB check
-- constraints beyond what docs/schemas.md actually specifies.

create table loads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  truck_id uuid references trucks (id),
  driver_id uuid references drivers (id),
  broker_id uuid references brokers (id),
  customer_id uuid references customers (id),
  origin text not null,
  destination text not null,
  pickup_date date,
  delivery_date date,
  rate_cents integer,
  miles integer,
  status text not null default 'draft',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  category text not null,
  amount_cents integer not null,
  expense_date date not null,
  truck_id uuid references trucks (id),
  load_id uuid references loads (id),
  driver_id uuid references drivers (id),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table fuel_purchases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  truck_id uuid not null references trucks (id),
  location text,
  gallons numeric(8, 3) not null,
  price_per_gallon_cents integer not null,
  total_cost_cents integer not null,
  purchased_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table maintenance_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  truck_id uuid not null references trucks (id),
  description text not null,
  cost_cents integer,
  service_date date not null,
  mileage_at_service integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table loads enable row level security;
alter table expenses enable row level security;
alter table fuel_purchases enable row level security;
alter table maintenance_events enable row level security;

create policy "tenant isolation" on loads
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

create policy "tenant isolation" on expenses
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

create policy "tenant isolation" on fuel_purchases
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

create policy "tenant isolation" on maintenance_events
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());
