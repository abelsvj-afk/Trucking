-- 00090 - Two cross-table references that missed the tenant-safety convention (audit 2026-11-11; found by tests/db/tenant-fk.sql,
-- which has failed on main since they landed). Every reference between two tenant tables is a COMPOSITE foreign key,
-- (company_id, fk) -> parent (company_id, id) (migration 00070), so the database itself refuses a row that points at another
-- company's record even for a role that bypasses RLS. Two tables declared a simple one:
--   research_learning_topics.research_run_id -> research_runs (id)   (00084)
--   duty_log_edits.duty_log_id               -> duty_logs (id)       (00088)
-- RLS still guards the app path, so this is a defense-in-depth gap, not a live leak. 00084 and 00088 are applied and frozen; this
-- converts both, exactly as 00070 and 00081 did. NUMBER: 00090 is the next free number on main at the time of writing - if another
-- branch has claimed it, renumber this file before applying.
--
-- PRE-FLIGHT (as in 00070): a row whose company differs from its parent's aborts the migration, reported by count only. No repair.

do $$
declare n bigint;
begin
  select count(*) into n from research_learning_topics c join research_runs p on p.id = c.research_run_id
   where c.research_run_id is not null and c.company_id <> p.company_id;
  if n > 0 then raise exception '00090 aborted: research_learning_topics.research_run_id -> research_runs: % cross-company row(s)', n; end if;
  select count(*) into n from duty_log_edits c join duty_logs p on p.id = c.duty_log_id where c.company_id <> p.company_id;
  if n > 0 then raise exception '00090 aborted: duty_log_edits.duty_log_id -> duty_logs: % cross-company row(s)', n; end if;
end $$;

-- The parents' (company_id, id) unique keys exist from 00070 for research_runs; duty_logs gets one here if it is missing.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'duty_logs'::regclass and conname = 'duty_logs_company_id_id_key') then
    alter table duty_logs add constraint duty_logs_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table research_learning_topics drop constraint research_learning_topics_research_run_id_fkey;
alter table research_learning_topics add constraint research_learning_topics_research_run_id_tenant_fkey
  foreign key (company_id, research_run_id) references research_runs (company_id, id) not valid;
alter table research_learning_topics validate constraint research_learning_topics_research_run_id_tenant_fkey;

alter table duty_log_edits drop constraint duty_log_edits_duty_log_id_fkey;
alter table duty_log_edits add constraint duty_log_edits_duty_log_id_tenant_fkey
  foreign key (company_id, duty_log_id) references duty_logs (company_id, id) not valid;
alter table duty_log_edits validate constraint duty_log_edits_duty_log_id_tenant_fkey;
