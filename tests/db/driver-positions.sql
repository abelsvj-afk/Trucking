-- Wave 4 gate (wave-4-test-matrix.md §3 item 6): driver_positions is keyed (company_id, source),
-- so a second company's fix never overwrites the first's, and the same company's second fix
-- replaces its own. Mirrors the app's upsert (services/telegram/live-location.ts: onConflict
-- "company_id,source"). Privileged role; one transaction; rolls back.
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/driver-positions.sql

begin;

do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000aa01';
  b uuid := '00000000-0000-0000-0000-00000000bb01';
  la double precision; lb double precision; n int;
begin
  insert into companies (id, name) values (a, 'A'), (b, 'B');

  insert into driver_positions (company_id, source, lat, lng, recorded_at) values (a, 'telegram', 10, 10, now())
    on conflict (company_id, source) do update set lat = excluded.lat, lng = excluded.lng;
  insert into driver_positions (company_id, source, lat, lng, recorded_at) values (b, 'telegram', 20, 20, now())
    on conflict (company_id, source) do update set lat = excluded.lat, lng = excluded.lng;
  -- A reports again: it replaces A's row only
  insert into driver_positions (company_id, source, lat, lng, recorded_at) values (a, 'telegram', 11, 11, now())
    on conflict (company_id, source) do update set lat = excluded.lat, lng = excluded.lng;

  select lat into la from driver_positions where company_id = a;
  select lat into lb from driver_positions where company_id = b;
  select count(*) into n from driver_positions;

  if la <> 11 then raise exception 'company A''s own second fix did not replace its row (lat=%)', la; end if;
  if lb <> 20 then raise exception 'company B''s row was overwritten by company A (lat=%)', lb; end if;
  if n <> 2 then raise exception 'expected exactly one latest-fix row per company, found %', n; end if;
  raise notice 'driver_positions: one row per company; A''s update left B''s fix untouched';
end $$;

rollback;
