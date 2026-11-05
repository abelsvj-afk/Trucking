-- 00061 - Trip intake (docs/design/trip-intake.md, Phase C).
-- What a dispatch assignment carries that a load could not hold:
--   * trip_number / broker_reference - separate from the broker's NAME;
--   * deadhead_miles / loaded_miles - exact (2 decimals); `miles` stays the
--     integer total used by existing math;
--   * pickup_tz / delivery_tz - the IANA zone each appointment was written
--     in, so a facility's local time is never silently converted;
--   * load_tasks - the dispatcher's per-trip requirements (photos, seal,
--     signed BOL, per-stop updates, wait for approval), each with done_at.
-- Per-stop arrival/departure already lives in detention_stamps.

alter table loads
  add column trip_number text,
  add column broker_reference text,
  add column deadhead_miles numeric(8, 2)
    constraint loads_deadhead_nonnegative check (deadhead_miles is null or deadhead_miles >= 0),
  add column loaded_miles numeric(8, 2)
    constraint loads_loaded_nonnegative check (loaded_miles is null or loaded_miles >= 0),
  add column pickup_tz text,
  add column delivery_tz text;

create table load_tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  load_id uuid not null references loads (id),
  text text not null check (length(btrim(text)) > 0),
  -- Where in the run it applies; null = the whole trip.
  stop_kind text
    constraint load_tasks_stop_valid check (stop_kind is null or stop_kind in ('pickup', 'delivery', 'every_stop')),
  sort_order integer not null default 0,
  -- Set only when the owner records it done; never inferred.
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index load_tasks_load_idx on load_tasks (company_id, load_id, sort_order);

alter table load_tasks enable row level security;

create policy "tenant isolation" on load_tasks
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- Live layer: let the app hear task changes (same guarded pattern as 00058).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'load_tasks'
     ) then
    alter publication supabase_realtime add table public.load_tasks;
  end if;
end
$$;
