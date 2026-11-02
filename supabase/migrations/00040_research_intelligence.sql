-- Research Intelligence upgrade (Trucking-Research-Intelligence-Audit-
-- Design-2026-11-02.md, slices R-1/R-4/R-5). Numbering note: main is
-- through 00028; the parallel Abel lanes own 00029-00039 in flight
-- (00029/00032 reserved for Lane 2 memory, 00033 already used by Lane 1
-- telegram trust fixes on its branch) - this lane starts at 00040 to
-- guarantee no collision with any branch in flight.
--
-- What this migration adds:
--   research_runner_heartbeat - single-row proof-of-life for the tick
--     (D-1.3). Every tick (in-process scheduler OR the internal run
--     endpoint) upserts it; the watchdog and the Research page banner
--     read it. A dead engine is finally distinguishable from a quiet
--     month.
--   research_health_alerts    - watchdog alert state: one row per
--     issue, throttling (one alert per issue per 24h) and recovery
--     tracking live here, never in process memory.
--   research_corridor         - per-company corridor state derived
--     from the company's next confirmed load (D-5, R-4): origin /
--     destination states, honestly endpoints-only in v1 (route
--     geometry belongs to the Smart Path lane).
--   research_requests         - the pre-trip photo-ask interface table
--     (D-5). This lane creates the table + the research-side writer
--     contract ONLY; Abel's conversational side is R-6, built by the
--     bot lane after its current build lands.
--   research_briefings.delivery_class / delivery_held_until - the
--     delivery-timing columns (D-6, R-5): urgent | trip | routine,
--     and the moment a held briefing may be sent.
--
-- pg_cron / pg_net (D-1.2): the hourly invoker. Extensions are enabled
-- ONLY where the platform offers them, and the cron job is created
-- ONLY when the vault already holds 'research_run_url' and
-- 'research_run_cron_secret' - a blind apply can never create a job
-- that calls a placeholder URL or leaks a placeholder secret. The
-- owner setup steps (vault entries + re-running the DO block at the
-- bottom) are in docs/runtime.md ("Research engine invoker").

create table research_runner_heartbeat (
  id integer primary key check (id = 1),
  last_tick_at timestamptz,
  last_source text,
  last_detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into research_runner_heartbeat (id) values (1) on conflict (id) do nothing;

alter table research_runner_heartbeat enable row level security;

-- Heartbeat is operational transparency, same posture as watcher
-- health: readable by any owner session, written only by the job role.
create policy "read runner heartbeat" on research_runner_heartbeat
  for select using (true);

create table research_health_alerts (
  issue_key text primary key,
  company_id uuid references companies (id),
  first_seen_at timestamptz not null default now(),
  last_alerted_at timestamptz,
  last_seen_at timestamptz not null default now(),
  detail text not null default '',
  active boolean not null default true,
  recovered_at timestamptz
);

alter table research_health_alerts enable row level security;

-- Global issues (company_id null) + the company's own issues are
-- readable by an owner session; writes are the job role's alone.
create policy "read own and global research health alerts" on research_health_alerts
  for select using (
    company_id is null or company_id = private.current_company_id()
  );

create table research_corridor (
  company_id uuid primary key references companies (id),
  load_id uuid references loads (id),
  origin_state text,
  destination_state text,
  states text[] not null default '{}',
  method text not null default 'endpoints_only',
  trip_start date,
  trip_end date,
  updated_at timestamptz not null default now()
);

alter table research_corridor enable row level security;

create policy "read own company's research corridor" on research_corridor
  for select using (company_id = private.current_company_id());

create table research_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  load_id uuid references loads (id),
  kind text not null check (kind in ('pretrip_photo')),
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'fulfilled', 'dismissed')),
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz
);

create index research_requests_company_status_idx on research_requests (company_id, status, created_at desc);

alter table research_requests enable row level security;

create policy "read own company's research requests" on research_requests
  for select using (company_id = private.current_company_id());

alter table research_briefings
  add column delivery_class text not null default 'routine'
    check (delivery_class in ('urgent', 'trip', 'routine')),
  add column delivery_held_until timestamptz;

-- The scoped job role gets the new tables - and nothing else (same
-- least-privilege mechanism as 00019).
grant select, insert, update on research_runner_heartbeat to industry_briefing_job;
grant select, insert, update on research_health_alerts to industry_briefing_job;
grant select, insert, update on research_corridor to industry_briefing_job;
grant select, insert, update on research_requests to industry_briefing_job;

create policy "research job full access to research_runner_heartbeat" on research_runner_heartbeat
  for all to industry_briefing_job using (true) with check (true);

create policy "research job full access to research_health_alerts" on research_health_alerts
  for all to industry_briefing_job using (true) with check (true);

create policy "research job full access to research_corridor" on research_corridor
  for all to industry_briefing_job using (true) with check (true);

create policy "research job full access to research_requests" on research_requests
  for all to industry_briefing_job using (true) with check (true);

-- D-1.2 invoker: enable the extensions where the platform offers them.
-- Wrapped so a platform without them (local dev, non-Supabase
-- Postgres) applies the rest of this migration cleanly and the
-- runbook's Fly scheduled-machine fallback applies instead.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

-- Create the hourly job ONLY when the vault already holds both the
-- endpoint URL and the shared secret (owner setup, docs/runtime.md).
-- Any missing piece - no vault schema, no entries, no extensions -
-- leaves the database exactly as it was; re-running this block after
-- the vault entries exist is the documented setup step.
do $$
declare
  v_url text;
  v_secret text;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    begin
      select decrypted_secret into v_url from vault.decrypted_secrets where name = 'research_run_url';
      select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'research_run_cron_secret';
    exception when others then
      v_url := null;
      v_secret := null;
    end;
    if v_url is not null and v_secret is not null then
      perform cron.schedule(
        'research-hourly-tick',
        '7 * * * *',
        format(
          $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-research-secret', %L), body := '{}'::jsonb)$job$,
          v_url, v_secret
        )
      );
    end if;
  end if;
end $$;
