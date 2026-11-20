-- 00111 - Audit batch 2 (F-007 / F-008 / F-010 / F-014 / F-025, verified 2026-11-20).
-- Every reference between two tenant tables is a COMPOSITE foreign key, (company_id, fk) -> parent
-- (company_id, id) (convention from 00070/00090), so the database itself refuses a row pointing at
-- another company's record even for a role that bypasses RLS. Running tests/db/tenant-fk.sql on a
-- scratch database built from every migration (F-010) found EIGHT single-column ones (the audit
-- named three):
--   paycheck_confirmations.statement_document_id -> documents      (00097)
--   agent_episodes.supersedes_id / superseded_by -> agent_episodes  (00092)
--   monthly_income_goals.driver_id               -> drivers        (00099)
--   outbound_calls.driver_id                     -> drivers        (00100)
--   voice_note_views.note_id / voice_note_reports.note_id -> voice_notes (00101, on delete cascade)
--   bot_group_messages.telegram_chat_id          -> bot_group_rooms (00103, on delete cascade)
-- RLS still guards the app path: defense in depth, not a live leak. The source migrations stay frozen.
--
-- F-008: business_credit_events_email_fk (00087) is composite with ON DELETE SET NULL, which nulls
-- BOTH columns - company_id is NOT NULL, so deleting a linked email failed. PostgreSQL 15+ can null
-- only the reference: ON DELETE SET NULL (email_message_id).
--
-- PRE-FLIGHT (as in 00070/00090): a row whose company differs from its parent's aborts the migration,
-- reported by count only. No repair.

do $$
declare n bigint;
begin
  select count(*) into n from paycheck_confirmations c join documents p on p.id = c.statement_document_id
   where c.company_id <> p.company_id;
  if n > 0 then raise exception '00111 aborted: paycheck_confirmations.statement_document_id: % cross-company row(s)', n; end if;
  select count(*) into n from agent_episodes c join agent_episodes p on p.id in (c.supersedes_id, c.superseded_by)
   where c.company_id <> p.company_id;
  if n > 0 then raise exception '00111 aborted: agent_episodes supersede links: % cross-company row(s)', n; end if;
  select count(*) into n from monthly_income_goals c join drivers p on p.id = c.driver_id where c.company_id <> p.company_id;
  if n > 0 then raise exception '00111 aborted: monthly_income_goals.driver_id: % cross-company row(s)', n; end if;
  select count(*) into n from outbound_calls c join drivers p on p.id = c.driver_id where c.company_id <> p.company_id;
  if n > 0 then raise exception '00111 aborted: outbound_calls.driver_id: % cross-company row(s)', n; end if;
  select count(*) into n from voice_note_views c join voice_notes p on p.id = c.note_id where c.company_id <> p.company_id;
  if n > 0 then raise exception '00111 aborted: voice_note_views.note_id: % cross-company row(s)', n; end if;
  select count(*) into n from voice_note_reports c join voice_notes p on p.id = c.note_id where c.company_id <> p.company_id;
  if n > 0 then raise exception '00111 aborted: voice_note_reports.note_id: % cross-company row(s)', n; end if;
  select count(*) into n from bot_group_messages c join bot_group_rooms p on p.telegram_chat_id = c.telegram_chat_id
   where c.company_id <> p.company_id;
  if n > 0 then raise exception '00111 aborted: bot_group_messages.telegram_chat_id: % cross-company row(s)', n; end if;
end $$;

-- Parent (company_id, key) unique keys where missing.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'agent_episodes'::regclass and conname = 'agent_episodes_company_id_id_key') then
    alter table agent_episodes add constraint agent_episodes_company_id_id_key unique (company_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'voice_notes'::regclass and conname = 'voice_notes_company_id_id_key') then
    alter table voice_notes add constraint voice_notes_company_id_id_key unique (company_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'bot_group_rooms'::regclass and conname = 'bot_group_rooms_company_id_chat_key') then
    alter table bot_group_rooms add constraint bot_group_rooms_company_id_chat_key unique (company_id, telegram_chat_id);
  end if;
end $$;

alter table paycheck_confirmations drop constraint paycheck_confirmations_statement_document_id_fkey;
alter table paycheck_confirmations add constraint paycheck_confirmations_statement_document_id_tenant_fkey
  foreign key (company_id, statement_document_id) references documents (company_id, id) not valid;
alter table paycheck_confirmations validate constraint paycheck_confirmations_statement_document_id_tenant_fkey;

alter table agent_episodes drop constraint agent_episodes_supersedes_id_fkey;
alter table agent_episodes add constraint agent_episodes_supersedes_id_tenant_fkey
  foreign key (company_id, supersedes_id) references agent_episodes (company_id, id) not valid;
alter table agent_episodes validate constraint agent_episodes_supersedes_id_tenant_fkey;
alter table agent_episodes drop constraint agent_episodes_superseded_by_fkey;
alter table agent_episodes add constraint agent_episodes_superseded_by_tenant_fkey
  foreign key (company_id, superseded_by) references agent_episodes (company_id, id) not valid;
alter table agent_episodes validate constraint agent_episodes_superseded_by_tenant_fkey;

alter table monthly_income_goals drop constraint monthly_income_goals_driver_id_fkey;
alter table monthly_income_goals add constraint monthly_income_goals_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table monthly_income_goals validate constraint monthly_income_goals_driver_id_tenant_fkey;

alter table outbound_calls drop constraint outbound_calls_driver_id_fkey;
alter table outbound_calls add constraint outbound_calls_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table outbound_calls validate constraint outbound_calls_driver_id_tenant_fkey;

alter table voice_note_views drop constraint voice_note_views_note_id_fkey;
alter table voice_note_views add constraint voice_note_views_note_id_tenant_fkey
  foreign key (company_id, note_id) references voice_notes (company_id, id) on delete cascade not valid;
alter table voice_note_views validate constraint voice_note_views_note_id_tenant_fkey;
alter table voice_note_reports drop constraint voice_note_reports_note_id_fkey;
alter table voice_note_reports add constraint voice_note_reports_note_id_tenant_fkey
  foreign key (company_id, note_id) references voice_notes (company_id, id) on delete cascade not valid;
alter table voice_note_reports validate constraint voice_note_reports_note_id_tenant_fkey;

alter table bot_group_messages drop constraint bot_group_messages_telegram_chat_id_fkey;
alter table bot_group_messages add constraint bot_group_messages_room_tenant_fk
  foreign key (company_id, telegram_chat_id) references bot_group_rooms (company_id, telegram_chat_id) on delete cascade not valid;
alter table bot_group_messages validate constraint bot_group_messages_room_tenant_fk;

-- F-008: null only the email reference, never the tenant key.
alter table business_credit_events drop constraint business_credit_events_email_fk;
alter table business_credit_events add constraint business_credit_events_email_fk
  foreign key (company_id, email_message_id) references email_messages (company_id, id)
  on delete set null (email_message_id);
