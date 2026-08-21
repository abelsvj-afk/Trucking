-- Task 1.4 (TASKS.md) also covers industry_briefings, per docs/schemas.md -
-- created now so the schema is complete, even though the capability itself
-- is Stage 4 (ROADMAP.md) and ships off by default (docs/governance.md).
-- No client-side insert: only the scheduled job's scoped service credential
-- writes this table (docs/automation.md), which uses the service-role key
-- and therefore bypasses RLS entirely for its own writes - the insert
-- policy below is defense in depth, not what actually authorizes the job.

create table industry_briefings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  summary text not null,
  reasoning text not null,
  confidence text not null,
  based_on jsonb not null,
  generated_at timestamptz not null default now(),
  dismissed_at timestamptz
);

alter table industry_briefings enable row level security;

create policy "read own company's briefings" on industry_briefings
  for select using (company_id = current_company_id());

create policy "dismiss own company's briefings" on industry_briefings
  for update using (company_id = current_company_id())
  with check (company_id = current_company_id());
