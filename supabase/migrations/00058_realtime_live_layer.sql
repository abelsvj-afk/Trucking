-- 00058 - Live layer (docs/design/driver-hud.md §4). Adds the tables the
-- app listens to into Supabase's `supabase_realtime` publication so
-- postgres_changes events are emitted for them.
--
-- Security: Supabase Realtime checks each subscriber's RLS SELECT policy
-- before delivering a change, so the existing company policies scope
-- events exactly like the REST path. The app also never renders an
-- event's payload - an event only triggers a re-fetch through the
-- company-scoped API.
--
-- Idempotent: tables already in the publication are skipped. On a plain
-- Postgres without the publication (local scratch), it says so and does
-- nothing - it never creates the publication itself.
--
-- Numbering: the wave map ends at 00057 (Unit C 00043-00044, photo/
-- maintenance 00045-00047, Abel 00048-00050, R-6 00051, GAP 00052-00057).

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present - live layer tables not added';
    return;
  end if;
  foreach t in array array[
    'duty_logs', 'loads', 'expenses', 'fuel_purchases', 'maintenance_events',
    'maintenance_schedules', 'trucks', 'trailers', 'drivers', 'documents',
    'detention_stamps'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
