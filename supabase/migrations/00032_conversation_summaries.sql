-- Lane 2 — Abel Intelligence Upgrade, Phase B storage
-- (Trucking-Abel-Intelligence-Upgrade-Design-2026-11-02, §3.3/§3.6/§7).
-- NOT applied by the build lane.
--
-- conversation_summaries: one rolling summary per conversation
-- week. Summaries AUGMENT the raw timeline, never replace it -
-- every row carries the ids of the source turns it was built from,
-- and the raw turns stay in telegram_messages forever. Injected
-- into context when a topic predates the verbatim history window.
--
-- consolidation_runs: the night shift's own log - when it ran, its
-- one-line morning report, and how many proposals it staged. The
-- scheduler reads the newest row per company to decide due-ness;
-- the report text is what gets surfaced to the owner.

create table conversation_summaries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  week_start date not null,
  summary text not null,
  source_message_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (company_id, week_start)
);

alter table conversation_summaries enable row level security;

create policy "tenant isolation" on conversation_summaries
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create table consolidation_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  ran_at timestamptz not null default now(),
  report text,
  proposals_staged int not null default 0,
  created_at timestamptz not null default now()
);

alter table consolidation_runs enable row level security;

create policy "tenant isolation" on consolidation_runs
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create index consolidation_runs_company_ran_idx
  on consolidation_runs (company_id, ran_at desc);
