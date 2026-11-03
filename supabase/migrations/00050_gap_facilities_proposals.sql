-- Fresh-Eyes Gap Register (2026-11-02) — Cluster B: GAP-03 facility
-- memory, GAP-01 support columns, GAP-15's state fields (the
-- worksheet itself is Cluster E; the fields must exist before
-- GAP-01's proposals can fill them).
--
-- GAP-03: the places he actually goes have no memory — origin and
-- destination are free text re-typed per load. facilities is the
-- place record: address, check-in procedure, dock/yard notes,
-- parking reality, detention behavior, hours, contact — created
-- from the rate con/forward (proposed by Abel) and enriched after
-- each visit. Loads link to the facilities they used.
--
-- GAP-15 groundwork: fuel by state needs a STATE on the purchase
-- (today only free-text location), and load lanes need structured
-- states (the rate con's extraction already pulls origin_state /
-- destination_state — GAP-01's proposals now have somewhere to
-- put them).

create table facilities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  address text,
  city text,
  state text,
  kind text not null default 'both'
    constraint facilities_kind_valid check (kind in ('shipper', 'receiver', 'both')),
  checkin_notes text,
  dock_notes text,
  parking_notes text,
  detention_notes text,
  hours_notes text,
  contact_name text,
  contact_phone text,
  visit_count integer not null default 0,
  last_visited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index facilities_company_name_idx on facilities (company_id, name);

alter table facilities enable row level security;

create policy "tenant isolation" on facilities
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

alter table loads
  add column pickup_facility_id uuid references facilities (id),
  add column delivery_facility_id uuid references facilities (id),
  add column origin_state text,
  add column destination_state text;

alter table fuel_purchases
  add column state text;
