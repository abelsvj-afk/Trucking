-- 00080 - Corrective: cash_advances.driver_id becomes a composite tenant FK
-- (Reliability Unit E rule, migration 00070; ChatGPT fresh audit 2026-11-07,
-- fix-list item 1). Migration 00079 created cash_advances with a single-column
-- foreign key `driver_id -> drivers (id)`, the one shape Unit E forbids between
-- two tenant tables: it lets a row name a driver that belongs to ANOTHER
-- company, and tests/db/tenant-fk.sql rightly rejects it. This migration
-- converts it to the standard composite shape
--   (company_id, driver_id) -> drivers (company_id, id)
-- so the database itself refuses a cross-company driver reference even for a
-- role that bypasses RLS. Migration 00079 is applied and frozen - it is NOT
-- edited; this is the additive correction.
--
-- NULL driver_id stays valid: a composite FK is only checked when every
-- referencing column is non-null (MATCH SIMPLE, the repo-wide default), and
-- 00079 defines driver_id as nullable (null = not assigned to a driver row).
-- drivers already holds UNIQUE (company_id, id) (drivers_company_id_id_key,
-- 00070), so the composite reference needs no new parent index.
--
-- PRE-FLIGHT (00070 pattern): rows whose driver belongs to a different company
-- than the advance abort this migration with the count - no automatic repair,
-- no nulling, no reassignment; the next step would be an owner ruling. Rows
-- are counted only, never printed.

do $$
declare
  n bigint;
begin
  select count(*) into n
  from cash_advances c join drivers p on p.id = c.driver_id
  where c.driver_id is not null and c.company_id <> p.company_id;
  if n > 0 then
    raise exception '00080 pre-flight: cash_advances.driver_id -> drivers has % cross-company row(s); aborting - owner ruling required, no automatic repair', n;
  end if;
end $$;

alter table cash_advances drop constraint cash_advances_driver_id_fkey;

alter table cash_advances add constraint cash_advances_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table cash_advances validate constraint cash_advances_driver_id_tenant_fkey;
