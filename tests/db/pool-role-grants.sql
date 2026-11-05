-- Wave 4 matrix §3 item 5: the least-privilege job role. `industry_briefing_job` (the scheduler's
-- connection; bypasses RLS by design, so its table grants ARE its security boundary) must hold exactly
-- the grants below - no DELETE anywhere, nothing on any business table (loads, drivers, expenses, ...),
-- nothing on the bot/Telegram tables. Any drift (a new grant, a widened privilege) fails this check.
-- Privileged role; read-only.
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/pool-role-grants.sql

do $$
declare
  expected text[] := array[
    'ai_capability_settings:SELECT',
    'industry_briefing_runs:INSERT,SELECT,UPDATE',
    'industry_briefings:INSERT,SELECT',
    'research_briefings:INSERT,SELECT,UPDATE',
    'research_corridor:INSERT,SELECT,UPDATE',
    'research_health_alerts:INSERT,SELECT,UPDATE',
    'research_requests:INSERT,SELECT,UPDATE',
    'research_runner_heartbeat:INSERT,SELECT,UPDATE',
    'research_runs:INSERT,SELECT,UPDATE',
    'research_signals:INSERT,SELECT,UPDATE',
    'research_watcher_state:INSERT,SELECT,UPDATE'
  ];
  actual text[];
  extra text[];
  missing text[];
begin
  select coalesce(array_agg(table_name || ':' || privs order by table_name), '{}') into actual
  from (
    select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.role_table_grants
    where grantee = 'industry_briefing_job' and table_schema = 'public'
    group by table_name
  ) g;

  select coalesce(array_agg(x), '{}') into extra from unnest(actual) x where x <> all (expected);
  select coalesce(array_agg(x), '{}') into missing from unnest(expected) x where x <> all (actual);

  if array_length(extra, 1) > 0 then raise exception 'industry_briefing_job holds grants beyond the least-privilege set: %', extra; end if;
  if array_length(missing, 1) > 0 then raise exception 'industry_briefing_job lost expected grants: %', missing; end if;
  if exists (select 1 from information_schema.role_table_grants where grantee = 'industry_briefing_job' and privilege_type in ('DELETE', 'TRUNCATE')) then
    raise exception 'industry_briefing_job can DELETE/TRUNCATE';
  end if;
  raise notice 'industry_briefing_job: exactly the % expected grants, no DELETE/TRUNCATE, no business tables', array_length(expected, 1);
end $$;
