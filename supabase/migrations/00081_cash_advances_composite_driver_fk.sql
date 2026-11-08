-- 00081 - Cash advances: tenant-safe driver reference (King's check 2026-11-07). 00079 (applied, frozen) declared
-- cash_advances.driver_id as a simple foreign key to drivers (id). Every other cross-table reference follows 00070's composite
-- pattern, (company_id, driver_id) -> drivers (company_id, id), so the DATABASE refuses a cross-company reference even for a
-- role that bypasses RLS. This brings cash_advances in line. driver_id stays nullable: an advance not yet assigned to a driver
-- row is a designed case, and the composite check passes when driver_id is null (MATCH SIMPLE).
--
-- PRE-FLIGHT (as in 00070): any advance whose driver belongs to another company aborts the migration, reported by count only.
-- No automatic repair - the next step would be an owner ruling.

do $$
declare n bigint;
begin
  select count(*) into n
  from cash_advances c join drivers p on p.id = c.driver_id
  where c.driver_id is not null and c.company_id <> p.company_id;
  if n > 0 then raise exception '00081 aborted: cash_advances.driver_id -> drivers: % row(s) point at another company''s driver', n; end if;
end $$;

alter table cash_advances drop constraint cash_advances_driver_id_fkey;
alter table cash_advances add constraint cash_advances_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table cash_advances validate constraint cash_advances_driver_id_tenant_fkey;
