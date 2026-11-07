-- Reliability Unit E acceptance (design E.5): tenant integrity at the database boundary.
-- Run as a SUPERUSER / privileged role (RLS bypassed) so a refusal can only be the FOREIGN KEY
-- layer, never RLS (the role-separation rule, E.5 #1b). One transaction; rolls back.
--
--   1. COMPLETENESS (E.3 step 0 / E.5 #5): every foreign key between two tenant tables is
--      composite (company_id, child_fk) -> parent (company_id, id); none is left single-column;
--      the only single-column FKs that remain are the documented exceptions (-> companies,
--      user_profiles.id -> auth.users).
--   2. BEHAVIOR: a cross-company reference is refused (23503) on representative relationships
--      of every shape; the same-company reference is accepted.
--
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/tenant-fk.sql

begin;

do $$
declare
  bad text;
  n int;
begin
  -- 1a. no single-column FK between tenant tables remains
  select string_agg(c.conrelid::regclass::text || '.' || a.attname || ' -> ' || c.confrelid::regclass::text, '; ')
    into bad
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
    and c.confrelid::regclass::text not in ('companies', 'auth.users')
    and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'company_id' and not x.attisdropped)
    and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'company_id' and not x.attisdropped);
  if bad is not null then raise exception 'UNCONVERTED single-column tenant FK(s): %', bad; end if;

  -- 1b. every composite tenant FK has the one consistent shape: (company_id, col) -> (company_id, id)
  select count(*) into n from pg_constraint c
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.conname like '%_tenant_fkey';
  -- 63 from 00070, +2 from 00077 (person_preferences.driver, load_decisions.driver), +2 from 00078 (load_candidates.email_message, email_drafts.email_message)
  if n <> 67 then raise exception 'expected 67 composite tenant FKs, found % (inventory drift - regenerate and review)', n; end if;

  select string_agg(c.conname, ', ') into bad
  from pg_constraint c
  where c.contype = 'f' and c.conname like '%_tenant_fkey'
    and not (
      (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) = 'company_id'
      and (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) = 'company_id'
      and (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[2]) = 'id'
      and c.convalidated
    );
  if bad is not null then raise exception 'composite FK with wrong shape or not validated: %', bad; end if;

  raise notice 'completeness: 0 unconverted tenant FKs; 67 composite FKs, all (company_id, fk) -> (company_id, id) and validated';
end $$;

-- 2. behavior ---------------------------------------------------------------------------
create temp table _fk_results (relationship text, outcome text) on commit drop;

do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000aa01';
  b uuid := '00000000-0000-0000-0000-00000000bb01';
  truck_a uuid := gen_random_uuid(); truck_b uuid := gen_random_uuid();
  load_a uuid := gen_random_uuid(); load_b uuid := gen_random_uuid();
  driver_b uuid := gen_random_uuid(); broker_b uuid := gen_random_uuid();
  failures text := '';
  refused boolean;
begin
  insert into companies (id, name) values (a, 'A'), (b, 'B');
  insert into trucks (id, company_id, unit_number) values (truck_a, a, 'A1'), (truck_b, b, 'B1');
  insert into loads (id, company_id, origin, destination) values (load_a, a, 'x', 'y'), (load_b, b, 'x', 'y');
  insert into drivers (id, company_id, name) values (driver_b, b, 'Bob');
  insert into brokers (id, company_id, name) values (broker_b, b, 'Brk');

  -- each case: insert a company-A child that points at company B's parent; it MUST be refused with 23503
  refused := false;
  begin insert into expenses (company_id, category, amount_cents, expense_date, truck_id) values (a, 'other', 100, current_date, truck_b);
  exception when foreign_key_violation then refused := true; end;
  if not refused then failures := failures || 'expenses.truck_id; '; end if;

  refused := false;
  begin insert into expenses (company_id, category, amount_cents, expense_date, load_id) values (a, 'other', 100, current_date, load_b);
  exception when foreign_key_violation then refused := true; end;
  if not refused then failures := failures || 'expenses.load_id; '; end if;

  refused := false;
  begin insert into fuel_purchases (company_id, truck_id, gallons, price_per_gallon_cents, total_cost_cents, purchased_at, load_id) values (a, truck_a, 10, 400, 4000, now(), load_b);
  exception when foreign_key_violation then refused := true; end;
  if not refused then failures := failures || 'fuel_purchases.load_id; '; end if;

  refused := false;
  begin insert into loads (company_id, origin, destination, driver_id) values (a, 'x', 'y', driver_b);
  exception when foreign_key_violation then refused := true; end;
  if not refused then failures := failures || 'loads.driver_id; '; end if;

  refused := false;
  begin insert into loads (company_id, origin, destination, broker_id) values (a, 'x', 'y', broker_b);
  exception when foreign_key_violation then refused := true; end;
  if not refused then failures := failures || 'loads.broker_id; '; end if;

  refused := false;
  begin insert into duty_logs (company_id, duty_status, started_at, load_id) values (a, 'driving', now(), load_b);
  exception when foreign_key_violation then refused := true; end;
  if not refused then failures := failures || 'duty_logs.load_id; '; end if;

  refused := false;
  begin update loads set truck_id = truck_b where id = load_a;
  exception when foreign_key_violation then refused := true; end;
  if not refused then failures := failures || 'UPDATE loads.truck_id; '; end if;

  -- same-company references still work exactly as before
  insert into expenses (company_id, category, amount_cents, expense_date, truck_id, load_id) values (a, 'other', 100, current_date, truck_a, load_a);
  insert into fuel_purchases (company_id, truck_id, gallons, price_per_gallon_cents, total_cost_cents, purchased_at, load_id) values (a, truck_a, 10, 400, 4000, now(), load_a);
  update loads set truck_id = truck_a where id = load_a;

  if failures <> '' then raise exception 'cross-company reference was ACCEPTED for: %', failures; end if;
  raise notice 'behavior: 7/7 cross-company references refused by the FK layer (RLS bypassed); same-company references accepted';
end $$;

rollback;
