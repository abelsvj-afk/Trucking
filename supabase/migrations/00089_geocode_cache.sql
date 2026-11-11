-- 00089 - A geocode cache that survives restarts (active-load navigation; number reserved by the owner 2026-11-10,
-- 00087/00088 belong to other work). A stop's address is turned into coordinates ONCE and kept here, so the automatic route to
-- the next stop does not ask the public geocoder again on every request or after every restart (the only cache before this was an
-- in-process map, lost on restart and not shared between machines).
--   query       the address text exactly as normalised by the app (trimmed, lower-cased, single spaces); unique per company
--   lat / lng   null = the geocoder answered "not found" for this text (a recorded miss, re-tried after a while - never invented)
-- ADDITIVE, tenant-isolated (RLS), anon grants 0 by the 00067 defaults, no foreign keys to other tenant tables, no seed.

create table geocode_cache (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  query text not null check (length(btrim(query)) > 0 and length(query) <= 500),
  lat double precision,
  lng double precision,
  provider text not null,
  geocoded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint geocode_cache_query_unique unique (company_id, query),
  constraint geocode_cache_both_or_neither check ((lat is null) = (lng is null)),
  constraint geocode_cache_lat_range check (lat is null or lat between -90 and 90),
  constraint geocode_cache_lng_range check (lng is null or lng between -180 and 180)
);

alter table geocode_cache enable row level security;
create policy "tenant isolation" on geocode_cache
  for all using (company_id = private.current_company_id()) with check (company_id = private.current_company_id());
