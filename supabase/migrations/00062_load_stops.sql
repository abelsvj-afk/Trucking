-- 00062 - Per-stop records for a load (docs/design/trip-intake.md).
-- A trip can have any number of stops (Amazon Relay-style loads have many).
-- Each keeps the facility, address, and its appointment IN THE ZONE IT WAS
-- WRITTEN IN, plus owner-recorded progress: arrived, left, and the
-- dispatcher's approval to leave. Those three are set only when the owner
-- taps them - nothing is inferred, and approval is never assumed.

create table load_stops (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  load_id uuid not null references loads (id),
  seq integer not null check (seq >= 1),
  kind text not null default 'other'
    constraint load_stops_kind_valid check (kind in ('pickup', 'delivery', 'other')),
  name text,
  address text,
  appointment_at timestamptz,
  appointment_tz text,
  arrived_at timestamptz,
  departed_at timestamptz,
  approved_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index load_stops_load_idx on load_stops (company_id, load_id, seq);

alter table load_stops enable row level security;

create policy "tenant isolation" on load_stops
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'load_stops'
     ) then
    alter publication supabase_realtime add table public.load_stops;
  end if;
end
$$;
