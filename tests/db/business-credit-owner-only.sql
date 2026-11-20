-- Audit F-002 (migration 00112): Business Credit rows are visible and writable only to the
-- company's OWNER; a driver logged in to the same company reads 0 and cannot write.
-- Run after scratch-auth-shim.sql. One transaction; rolls back.
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/business-credit-owner-only.sql

begin;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2');
insert into companies (id, name) values ('00000000-0000-0000-0000-00000000aa01', 'A');
insert into user_profiles (id, company_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01', 'owner'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000aa01', 'driver');
insert into business_credit_accounts (company_id, vendor, vendor_key, status)
  values ('00000000-0000-0000-0000-00000000aa01', 'Vendor', 'vendor', 'open');

set local role authenticated;

-- the driver
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
do $$
declare n int; refused boolean := false;
begin
  select count(*) into n from business_credit_accounts;
  if n <> 0 then raise exception 'FAIL: a driver can read % business credit row(s)', n; end if;
  begin
    insert into business_credit_accounts (company_id, vendor, vendor_key, status)
      values ('00000000-0000-0000-0000-00000000aa01', 'X', 'x', 'open');
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'FAIL: a driver could write business credit'; end if;
  raise notice 'ok: a driver in the same company reads 0 rows and cannot write';
end $$;

-- the owner
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
declare n int;
begin
  select count(*) into n from business_credit_accounts;
  if n <> 1 then raise exception 'FAIL: the owner reads % row(s), expected 1', n; end if;
  insert into business_credit_accounts (company_id, vendor, vendor_key, status)
    values ('00000000-0000-0000-0000-00000000aa01', 'Y', 'y', 'open');
  raise notice 'ok: the owner reads and writes his business credit';
end $$;

rollback;
