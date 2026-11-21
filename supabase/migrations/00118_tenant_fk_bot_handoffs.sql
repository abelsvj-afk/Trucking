-- 00118 - Tenant FK straggler: bot_handoffs.parent_id -> bot_handoffs, converted to the
-- composite tenant form (company_id, parent_id) -> bot_handoffs (company_id, id), exactly
-- as 00070/00090/00111/00116 did for the others.
--
-- ROOT CAUSE (full note: docs/audits/tenant-fk-bot-handoffs-root-cause-2026-11-21.md):
-- bot_handoffs was created by 00113 (Tracker lane; landed via PR #111 and applied live
-- 2026-11-20) with its self-reference in the original single-column form, and no migration
-- has ever converted it. 00111's inventory of eight single-column FKs was fixed from a
-- scratch chain that predated 00113, and the scratch gate that cleared PR #113 was built
-- from a tree (b37e3ec6) whose migrations stop at 00112 - bot_handoffs was not in the
-- gated chain at all, so the check passed on scratch while never seeing the table.
-- Production applied 00113, so the live run of tests/db/tenant-fk.sql - which enumerates
-- pg_constraint in whatever database it runs against - failed its completeness sweep on
-- this one FK on 2026-11-21, after 00116 cleared the first two stragglers. 00113 is
-- frozen; this migration is the completion.
--
-- ON DELETE: the original FK is ON DELETE SET NULL. A plain composite SET NULL would
-- null company_id too - company_id is NOT NULL, so deleting a parent handoff would fail
-- outright. Exactly as 00111 did for business_credit_events (F-008), the conversion uses
-- the PostgreSQL 15+ column-list form, ON DELETE SET NULL (parent_id): deleting a parent
-- handoff nulls only the reference, never the tenant key. The end state keeps 00113's
-- delete behavior and gains the tenant guarantee.
--
-- State-aware, like 00116: converts where the original single-column FK is still present
-- (production, and any chain replay), no-ops where the tenant FK already exists, and
-- aborts loudly in any third state instead of skipping silently.
--
-- PRE-FLIGHT (as in 00070/00090/00111/00116): a row whose parent belongs to another
-- company aborts the migration, reported by count only. No repair.

do $$
declare n bigint;
begin
  select count(*) into n from bot_handoffs c join bot_handoffs p on p.id = c.parent_id
   where c.parent_id is not null and c.company_id <> p.company_id;
  if n > 0 then raise exception '00118 aborted: bot_handoffs.parent_id -> bot_handoffs: % cross-company row(s)', n; end if;
end $$;

-- Parent (company_id, id) unique key where missing. 00113 gave bot_handoffs only
-- unique (company_id, idempotency_key); the composite FK needs this key to point at.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'bot_handoffs'::regclass and conname = 'bot_handoffs_company_id_id_key') then
    alter table bot_handoffs add constraint bot_handoffs_company_id_id_key unique (company_id, id);
  end if;
end $$;

-- Convert the FK only if it is still in its original single-column form.
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'bot_handoffs'::regclass and conname = 'bot_handoffs_parent_id_fkey') then
    alter table bot_handoffs drop constraint bot_handoffs_parent_id_fkey;
    alter table bot_handoffs add constraint bot_handoffs_parent_id_tenant_fkey
      foreign key (company_id, parent_id) references bot_handoffs (company_id, id) on delete set null (parent_id) not valid;
    alter table bot_handoffs validate constraint bot_handoffs_parent_id_tenant_fkey;
  elsif not exists (select 1 from pg_constraint where conrelid = 'bot_handoffs'::regclass and conname = 'bot_handoffs_parent_id_tenant_fkey') then
    raise exception '00118 aborted: bot_handoffs has neither the original parent_id FK nor the tenant FK - unexpected schema state';
  end if;
end $$;
