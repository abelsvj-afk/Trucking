-- 00116 - bot_handoffs.parent_id (00113, Tracker landing) is a single-column self-reference, so a
-- handoff could point at another company's handoff. Found by `bash tests/db/build-scratch.sh`
-- (tests/db/tenant-fk.sql) right after 00113 landed. Same convention as 00070/00090/00111: a
-- composite (company_id, parent_id) -> (company_id, id) key, keeping ON DELETE SET NULL on the
-- reference column only (PostgreSQL 15+), never the tenant key. 00113 stays frozen.
--
-- PRE-FLIGHT: a row whose parent belongs to another company aborts the migration (count only, no repair).

do $$
declare n bigint;
begin
  select count(*) into n from bot_handoffs c join bot_handoffs p on p.id = c.parent_id where c.company_id <> p.company_id;
  if n > 0 then raise exception '00116 aborted: bot_handoffs.parent_id: % cross-company row(s)', n; end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'bot_handoffs'::regclass and conname = 'bot_handoffs_company_id_id_key') then
    alter table bot_handoffs add constraint bot_handoffs_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table bot_handoffs drop constraint bot_handoffs_parent_id_fkey;
alter table bot_handoffs add constraint bot_handoffs_parent_id_tenant_fkey
  foreign key (company_id, parent_id) references bot_handoffs (company_id, id) on delete set null (parent_id) not valid;
alter table bot_handoffs validate constraint bot_handoffs_parent_id_tenant_fkey;
