-- 00084: Abel Autonomous Research & Business Awareness
-- (docs/design/autonomous-research.md, owner spec 2026-11-09).
--
-- Two tables, both per-company, both following the research family's
-- established posture (00019/00040/00051):
--
--   research_knowledge        - the durable knowledge layer. The
--     research tick distills fresh watcher signals and a daily
--     own-business snapshot (from the company's own records) into
--     rows Abel can cite in chat WITH source + date. Freshness is
--     computed in code per standing topic (src/lib/watch-topics.ts);
--     the table stores the fact and its provenance, never a
--     "current?" flag that could silently rot.
--   research_learning_topics  - the self-directed learning agenda.
--     Rows are PROPOSALS (status 'proposed') filed by the tick's
--     agenda pass or by Abel in conversation. Nothing here runs
--     until the owner approves: approval flips the row to 'queued'
--     and records the manual research_runs row it created (the
--     engine executes it under its normal caps); the runner settles
--     the row to 'done' when that run reaches a terminal state.
--     'dismissed' is the owner's no. Research itself stays
--     read-only learning - these tables never move money, change
--     business records, or send anything.
--
-- Access, mirroring 00040 + 00051:
--   - owner sessions READ their own company's rows;
--   - owner sessions may INSERT a learning topic ONLY in the exact
--     proposal shape (own company, proposed_by 'owner', status
--     'proposed') - Abel's in-conversation proposals ride the bot's
--     service-role client on Telegram and this same fence on web;
--   - owner sessions may UPDATE their own company's learning topics
--     (approve/dismiss from the Research page; the approve route is
--     what queues the run, through the existing research_runs fence
--     in 00019);
--   - the scoped research job role (industry_briefing_job) gets
--     select/insert/update on both tables for the tick's writers;
--   - knowledge rows are written ONLY by the job role / service role
--     (no owner-session insert policy - knowledge is distilled, not
--     dictated).

create table research_knowledge (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  watch_topic text not null check (watch_topic in (
    'own_business', 'industry', 'crypto', 'authority_pathways', 'build_plan'
  )),
  title text not null,
  content text not null,
  source_title text,
  source_url text,
  observed_at timestamptz not null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (company_id, dedupe_key)
);

create index research_knowledge_company_topic_idx
  on research_knowledge (company_id, watch_topic, observed_at desc);

alter table research_knowledge enable row level security;

create policy "read own company's research knowledge" on research_knowledge
  for select using (company_id = private.current_company_id());

create table research_learning_topics (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  topic text not null check (length(btrim(topic)) > 0),
  reason text not null default '',
  watch_topic text check (watch_topic is null or watch_topic in (
    'own_business', 'industry', 'crypto', 'authority_pathways', 'build_plan'
  )),
  proposed_by text not null default 'abel' check (proposed_by in ('abel', 'owner')),
  status text not null default 'proposed' check (status in (
    'proposed', 'queued', 'done', 'dismissed'
  )),
  research_run_id uuid references research_runs (id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index research_learning_topics_company_status_idx
  on research_learning_topics (company_id, status, created_at desc);

alter table research_learning_topics enable row level security;

create policy "read own company's learning topics" on research_learning_topics
  for select using (company_id = private.current_company_id());

create policy "propose a learning topic for own company" on research_learning_topics
  for insert with check (
    company_id = private.current_company_id()
    and proposed_by = 'owner'
    and status = 'proposed'
    and research_run_id is null
  );

create policy "decide own company's learning topics" on research_learning_topics
  for update using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- The scoped job role gets the new tables - and nothing else (same
-- least-privilege mechanism as 00019/00040).
grant select, insert, update on research_knowledge to industry_briefing_job;
grant select, insert, update on research_learning_topics to industry_briefing_job;

create policy "research job full access to research_knowledge" on research_knowledge
  for all to industry_briefing_job using (true) with check (true);

create policy "research job full access to research_learning_topics" on research_learning_topics
  for all to industry_briefing_job using (true) with check (true);
