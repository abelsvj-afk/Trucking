-- 00116 - Tenant FK stragglers: research_learning_topics.research_run_id -> research_runs and
-- duty_log_edits.duty_log_id -> duty_logs, converted to the composite tenant form
-- (company_id, fk) -> parent (company_id, id), exactly as 00070/00090/00111 did for the others.
--
-- ROOT CAUSE (full note: docs/audits/tenant-fk-stragglers-root-cause-2026-11-20.md): migration
-- 00090 already contains this exact conversion, and on a from-empty chain it lands - the scratch
-- harness (tests/db/build-scratch.sh) replays every migration in order, so on scratch both FKs
-- have been composite since 00090, the tenant-fk inventory 00111 was written from never listed
-- them, and 00111 (a fixed list of eight, no sweep of its own) applied cleanly everywhere.
-- But 00090 was never applied to the production database, so in production both references are
-- still in their original single-column form from 00084 (research_learning_topics) and 00088
-- (duty_log_edits). The live run of tests/db/tenant-fk.sql - which enumerates pg_constraint in
-- whatever database it runs against - failed on exactly these two. 00090 and 00111 are frozen;
-- this migration is the production-side completion.
--
-- Written to be safe in BOTH states, so the full chain still replays cleanly:
--   - production (00090 never applied): converts both FKs, adds duty_logs' (company_id, id) key;
--   - a chain replay (00090 applied): the tenant constraints already exist and this no-ops.
-- Constraint names match 00090's exactly, so the end state is identical whichever path a
-- database took. Any third state is a hard stop, not a silent skip.
--
-- PRE-FLIGHT (as in 00070/00090/00111): a row whose company differs from its parent's aborts
-- the migration, reported by count only. No repair.

do $$
declare n bigint;
begin
  select count(*) into n from research_learning_topics c join research_runs p on p.id = c.research_run_id
   where c.research_run_id is not null and c.company_id <> p.company_id;
  if n > 0 then raise exception '00116 aborted: research_learning_topics.research_run_id -> research_runs: % cross-company row(s)', n; end if;
  select count(*) into n from duty_log_edits c join duty_logs p on p.id = c.duty_log_id where c.company_id <> p.company_id;
  if n > 0 then raise exception '00116 aborted: duty_log_edits.duty_log_id -> duty_logs: % cross-company row(s)', n; end if;
end $$;

-- Parent (company_id, id) unique keys where missing. research_runs' exists from 00070;
-- duty_logs' was 00090's to add, so production does not have it.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'research_runs'::regclass and conname = 'research_runs_company_id_id_key') then
    alter table research_runs add constraint research_runs_company_id_id_key unique (company_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'duty_logs'::regclass and conname = 'duty_logs_company_id_id_key') then
    alter table duty_logs add constraint duty_logs_company_id_id_key unique (company_id, id);
  end if;
end $$;

-- Convert each FK only if it is still in its original single-column form. The originals carry
-- no ON DELETE action (00084 / 00088), and neither do these conversions - same as 00090's.
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'research_learning_topics'::regclass and conname = 'research_learning_topics_research_run_id_fkey') then
    alter table research_learning_topics drop constraint research_learning_topics_research_run_id_fkey;
    alter table research_learning_topics add constraint research_learning_topics_research_run_id_tenant_fkey
      foreign key (company_id, research_run_id) references research_runs (company_id, id) not valid;
    alter table research_learning_topics validate constraint research_learning_topics_research_run_id_tenant_fkey;
  elsif not exists (select 1 from pg_constraint where conrelid = 'research_learning_topics'::regclass and conname = 'research_learning_topics_research_run_id_tenant_fkey') then
    raise exception '00116 aborted: research_learning_topics has neither the original research_run_id FK nor the tenant FK - unexpected schema state';
  end if;

  if exists (select 1 from pg_constraint where conrelid = 'duty_log_edits'::regclass and conname = 'duty_log_edits_duty_log_id_fkey') then
    alter table duty_log_edits drop constraint duty_log_edits_duty_log_id_fkey;
    alter table duty_log_edits add constraint duty_log_edits_duty_log_id_tenant_fkey
      foreign key (company_id, duty_log_id) references duty_logs (company_id, id) not valid;
    alter table duty_log_edits validate constraint duty_log_edits_duty_log_id_tenant_fkey;
  elsif not exists (select 1 from pg_constraint where conrelid = 'duty_log_edits'::regclass and conname = 'duty_log_edits_duty_log_id_tenant_fkey') then
    raise exception '00116 aborted: duty_log_edits has neither the original duty_log_id FK nor the tenant FK - unexpected schema state';
  end if;
end $$;
