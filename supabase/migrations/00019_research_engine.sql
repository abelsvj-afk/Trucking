-- Deep Research Engine (docs/design/research-engine.md, Stage 8).
-- Numbering: 00015/00016 belong to the bot-intelligence-v2 branch and
-- 00017/00018 are reserved for the Smart Path branch - this branch off
-- main starts at 00019.
--
-- Four tables:
--   research_signals        - normalized pressure signals emitted by the
--                             watcher layer. company_id is NULL for global
--                             market signals (diesel, federal rulemaking,
--                             industry news) - they are not one company's
--                             data; the column exists so a future
--                             company-scoped watcher needs no migration.
--   research_watcher_state  - one row per watcher: last poll, last
--                             status (ok | error | skipped), last error,
--                             and a jsonb state bag (e.g. the last EIA
--                             period/price the diesel watcher has seen).
--                             Written only by the job credential;
--                             owner sessions get read-only access (the
--                             select policy below) because watcher health
--                             is operational transparency, not tenant data.
--   research_runs           - the full run log: every decision outcome
--                             (queued, running, success, failure,
--                             insufficient_data, skipped_cap,
--                             skipped_disabled) - caps and the kill
--                             switch must leave a visible trace, never
--                             silence (docs/design/research-engine.md §3).
--   research_briefings      - the stored briefings (data, not files):
--                             Secrets Brief shape - findings with real
--                             sources, what changed, the counter-move,
--                             one takeaway, unverified items marked.
--
-- Writes come from the engine's scoped job credential (the Stage-4
-- industry_briefing_job role, grants extended below to these four
-- tables only) - never the service-role key. The ONE exception is the
-- owner's manual "research this now" queue insert, fenced by its own
-- policy to exactly (own company, trigger_kind='manual',
-- status='queued').

create table research_signals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id),
  watcher_key text not null,
  kind text not null,
  topic text not null,
  magnitude numeric not null check (magnitude >= 0 and magnitude <= 1),
  summary text not null,
  items jsonb not null default '[]'::jsonb,
  data jsonb not null default '{}'::jsonb,
  dedupe_key text not null unique,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index research_signals_topic_idx on research_signals (topic, observed_at desc);

alter table research_signals enable row level security;

-- Global signals (company_id null) are market data the engine gathered
-- for everyone; company-scoped signals are that company's alone.
create policy "read global and own research signals" on research_signals
  for select using (
    company_id is null or company_id = private.current_company_id()
  );

create table research_watcher_state (
  watcher_key text primary key,
  last_polled_at timestamptz,
  last_status text check (last_status in ('ok', 'error', 'skipped')),
  last_error text,
  last_signal_at timestamptz,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table research_watcher_state enable row level security;

-- Watcher health is operational transparency for the owner (design §2:
-- failures visible, never silent). Read-only for owner sessions; the
-- rows carry no tenant data.
create policy "read watcher health" on research_watcher_state
  for select using (true);

create table research_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  trigger_kind text not null check (trigger_kind in ('scheduled', 'pressure', 'manual')),
  topic text not null,
  trigger_detail jsonb not null default '{}'::jsonb,
  status text not null check (
    status in ('queued', 'running', 'success', 'failure', 'insufficient_data', 'skipped_cap', 'skipped_disabled')
  ),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  briefing_id uuid,
  created_at timestamptz not null default now()
);

create index research_runs_company_created_idx on research_runs (company_id, created_at desc);

alter table research_runs enable row level security;

create policy "read own company's research runs" on research_runs
  for select using (company_id = private.current_company_id());

-- The manual-trigger fence (design §6): an owner session may ONLY queue
-- a manual run for its own company. It cannot forge a scheduled/pressure
-- run, a finished run, or another company's run.
create policy "queue a manual research run for own company" on research_runs
  for insert with check (
    company_id = private.current_company_id()
    and trigger_kind = 'manual'
    and status = 'queued'
  );

create table research_briefings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  run_id uuid references research_runs (id),
  topic text not null,
  title text not null,
  headline text not null,
  findings jsonb not null default '[]'::jsonb,
  what_changed text not null,
  counter_move text not null,
  takeaway text not null,
  unverified jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  telegram_notified_at timestamptz,
  read_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table research_runs
  add constraint research_runs_briefing_id_fk
  foreign key (briefing_id) references research_briefings (id);

create index research_briefings_company_created_idx on research_briefings (company_id, created_at desc);

alter table research_briefings enable row level security;

create policy "read own company's research briefings" on research_briefings
  for select using (company_id = private.current_company_id());

-- The owner may only mark read / dismiss his own briefings; the update
-- policy is the same shape 00005 uses for industry_briefings.
create policy "mark own company's research briefings read or dismissed" on research_briefings
  for update using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- Extend the Stage-4 scoped job role to the engine's four tables - and
-- nothing else (same least-privilege mechanism as 00008: explicit
-- GRANTs, NOINHERIT role, RLS policies below as defense in depth for a
-- role that authenticates directly and has no JWT session).
grant select, insert, update on research_signals to industry_briefing_job;
grant select, insert, update on research_watcher_state to industry_briefing_job;
grant select, insert, update on research_runs to industry_briefing_job;
grant select, insert, update on research_briefings to industry_briefing_job;

create policy "research job full access to research_signals" on research_signals
  for all to industry_briefing_job using (true) with check (true);

create policy "research job full access to research_watcher_state" on research_watcher_state
  for all to industry_briefing_job using (true) with check (true);

create policy "research job full access to research_runs" on research_runs
  for all to industry_briefing_job using (true) with check (true);

create policy "research job full access to research_briefings" on research_briefings
  for all to industry_briefing_job using (true) with check (true);
