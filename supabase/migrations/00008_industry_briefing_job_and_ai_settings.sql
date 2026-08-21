-- Stage 4 (TASKS.md 4.4/4.6/4.7), per docs/schemas.md's additions for the
-- industry-intelligence engine. Three things:
--   1. industry_briefing_runs - a log of every scheduled-run attempt,
--      success or failure, since a failed run produces no briefing row at
--      all (docs/automation.md's Failure recovery) and the
--      consecutive-failure escalation (task 4.7) needs something to check.
--   2. ai_capability_settings + companies.ai_globally_disabled - the
--      per-capability and global kill switches docs/governance.md requires.
--   3. A dedicated, least-privilege Postgres role for the scheduled job
--      itself - deliberately NOT SUPABASE_SERVICE_ROLE_KEY (bypasses RLS
--      entirely, full access to every table - the gap found and fixed in
--      .env.example/docs/runtime.md while designing this). No password is
--      set here (a real password in a committed migration would itself be
--      a leaked secret, per CLAUDE.md) - a follow-up, non-committed
--      `ALTER ROLE industry_briefing_job PASSWORD '...'` must be run once
--      live against the project before this role can actually connect;
--      until then it exists but cannot log in.
--
-- Also closes a real gap found while writing this: 00005_industry_briefings.sql's
-- own top comment claims "the insert policy below is defense in depth" but
-- that file never actually defines one - industry_briefings has had RLS
-- enabled with a select and an update policy only, no insert policy at
-- all, since it was first created. The insert policy this migration adds
-- (scoped to industry_briefing_job only) is that missing policy, not a new
-- requirement - completing what 00005 already documented as intended.

create table industry_briefing_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('success', 'failure', 'insufficient_data')),
  error_message text,
  briefing_id uuid references industry_briefings (id),
  created_at timestamptz not null default now()
);

alter table industry_briefing_runs enable row level security;

create policy "read own company's run log" on industry_briefing_runs
  for select using (company_id = current_company_id());

create table ai_capability_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  capability text not null,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (company_id, capability)
);

alter table ai_capability_settings enable row level security;

create policy "manage own company's AI capability settings" on ai_capability_settings
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

alter table companies add column ai_globally_disabled boolean not null default false;

-- The scheduled job's own scoped credential. NOINHERIT + explicit GRANTs
-- (not membership in any broader role) is the least-privilege mechanism
-- here; RLS policies below are defense in depth for this role, matching
-- the precedent already set in 00005_industry_briefings.sql.
create role industry_briefing_job with login noinherit;

grant usage on schema public to industry_briefing_job;
grant select, insert on industry_briefings to industry_briefing_job;
grant select, insert, update on industry_briefing_runs to industry_briefing_job;
grant select on ai_capability_settings to industry_briefing_job;
grant select (id, ai_globally_disabled) on companies to industry_briefing_job;

-- This role authenticates as itself (a direct postgres:// connection, not
-- the anon-key/PostgREST/JWT path - see docs/runtime.md), so it has no
-- current_company_id() to check against. The GRANTs above are the actual
-- boundary (it cannot even see any other table exists); these policies are
-- a second layer, deliberately permissive within the tables it was already
-- granted access to rather than trying to reproduce a JWT-based check for
-- a role that was never issued a JWT.
create policy "industry_briefing_job full access to its own write tables" on industry_briefings
  for all to industry_briefing_job using (true) with check (true);

create policy "industry_briefing_job full access to its own write tables" on industry_briefing_runs
  for all to industry_briefing_job using (true) with check (true);

create policy "industry_briefing_job reads capability settings" on ai_capability_settings
  for select to industry_briefing_job using (true);
