-- Tenant-isolation check across EVERY table that has a company_id (audit Wave 4,
-- docs/reconciliation/wave-4-test-matrix.md). Pure SQL; one transaction that
-- ROLLS BACK, so it leaves nothing behind. It creates two companies and two
-- users, "logs in" as company A's user, and for each tenant table builds a
-- COMPLETE row (every NOT NULL column filled) so a refusal can only be the
-- row-level-security refusal (SQLSTATE 42501) and never a constraint failure
-- that happens to fire first (23502 not-null, 23514 check, 23503 foreign key):
--   1. cross-company INSERT (company_id = B) must be refused by RLS;
--   2. own-company INSERT must be allowed where the table is tenant-writable and
--      refused where it is read-only for tenants (research family, user_profiles);
--   3. ANON cannot write: the probe uses the SAME complete row, with the login
--      claim cleared, and anon's INSERT privilege is granted inside the
--      transaction (rolled back) when the migrations revoked it, so the refusal
--      is the RLS one - not a missing-privilege one that would prove nothing;
--   4. where a company-B row could be seeded, A reads 0, updates 0, deletes 0 of
--      them, and anon reads 0;
--   5. (separate file) anon holds NO write privilege on any table - tests/db/anon-privileges.sql;
-- A probe that fails on a constraint before RLS can decide is reported as
-- UNPROVEN - not a violation, and not counted as a pass.
--
-- Run (scratch): psql -d scratch -f tests/db/scratch-auth-shim.sql -f tests/db/rls-isolation.sql
--   (scratch setup order: Supabase stub -> tests/db/scratch-supabase-defaults.sql -> migrations)
-- Run (live, King): paste into the Supabase SQL editor as-is (it rolls back).
-- Seeding needs session_replication_role (superuser); where the project forbids
-- it, seeding and its reset are skipped without aborting and checks 1-3, 5 still run.

begin;

do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  t text;
  failures text[] := '{}';
  unproven text[] := '{}';
  has_tenant_write boolean;
  seeded boolean;
  n bigint;
  tables_checked int := 0;
  tables_seeded int := 0;
  proven_cross int := 0;
  proven_anon int := 0;
  state text;
  col record;
  cols text;
  vals_tpl text;   -- values list with {C} standing for the company id
  stmt text;
  lit text;
  priv text;
  -- tables whose tenant INSERT policy also fences the row's SHAPE (manual, queued
  -- research runs only): a complete generic row is rightly refused for tenants.
  shaped constant text[] := array['research_runs', 'research_requests'];
begin
  insert into companies (id, name) values (a, 'iso-A'), (b, 'iso-B');
  insert into auth.users (id) values (ua), (ub);
  insert into user_profiles (id, company_id, role) values (ua, a, 'owner'), (ub, b, 'owner');

  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'company_id'
    order by c.table_name
  loop
    tables_checked := tables_checked + 1;

    select exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t and p.cmd in ('INSERT', 'ALL')
        and (p.roles @> array['public']::name[] or p.roles @> array['authenticated']::name[])
    ) into has_tenant_write;

    -- the complete-row template: NOT NULL columns without a default get a type-appropriate value;
    -- text columns take the first literal of any check constraint that mentions them.
    cols := 'company_id';
    vals_tpl := '{C}::uuid';
    for col in
      select c.column_name, c.data_type from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = t and c.is_nullable = 'NO'
        and c.column_default is null and c.column_name <> 'company_id' and c.is_generated = 'NEVER'
        and coalesce(c.is_identity, 'NO') = 'NO'
    loop
      cols := cols || ', ' || quote_ident(col.column_name);
      -- documents (migration 00071): the reference trigger fires BEFORE RLS, so a complete row must
      -- carry a VALID reference - the company itself - or the probe would be stopped by the trigger.
      if t = 'documents' and col.column_name = 'related_entity_id' then vals_tpl := vals_tpl || ', {C}::uuid';
      elsif t = 'documents' and col.column_name = 'related_entity_type' then vals_tpl := vals_tpl || ', ''company''';
      elsif col.data_type = 'uuid' then vals_tpl := vals_tpl || ', gen_random_uuid()';
      elsif col.data_type in ('integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real') then vals_tpl := vals_tpl || ', 1';
      elsif col.data_type = 'boolean' then vals_tpl := vals_tpl || ', false';
      elsif col.data_type = 'date' then vals_tpl := vals_tpl || ', current_date';
      elsif col.data_type like 'timestamp%' then vals_tpl := vals_tpl || ', now()';
      elsif col.data_type in ('jsonb', 'json') then vals_tpl := vals_tpl || ', ''{}''::' || col.data_type;
      elsif col.data_type = 'ARRAY' then vals_tpl := vals_tpl || ', ''{}''';
      else
        select (regexp_match(pg_get_constraintdef(k.oid), '''([^'']+)'''))[1] into lit
        from pg_constraint k
        where k.conrelid = format('public.%I', t)::regclass and k.contype = 'c'
          and pg_get_constraintdef(k.oid) ilike '%' || col.column_name || '%'
        limit 1;
        vals_tpl := vals_tpl || ', ' || quote_literal(coalesce(lit, 'x'));
      end if;
    end loop;

    -- seed a company-B row (superuser only; FK triggers off). Never aborts the run.
    seeded := false;
    begin
      perform set_config('session_replication_role', 'replica', true);
      execute format('insert into public.%I (%s) values (%s)', t, cols, replace(vals_tpl, '{C}', quote_literal(b::text)));
      seeded := true;
      tables_seeded := tables_seeded + 1;
    exception when others then
      seeded := false;
    end;
    begin
      perform set_config('session_replication_role', 'origin', true);
    exception when others then
      null; -- a managed project may forbid touching the setting at all; nothing to restore then
    end;

    -- the anon probe must reach RLS: give anon INSERT for this transaction if the migrations revoked it
    begin
      execute format('grant insert, select on public.%I to anon', t);
    exception when others then
      null;
    end;

    -- ---- log in as A's user ----
    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', ua::text, true);

    -- 1. cross-company insert (complete row) must be refused by RLS
    begin
      stmt := format('insert into public.%I (%s) values (%s)', t, cols, replace(vals_tpl, '{C}', quote_literal(b::text)));
      execute stmt;
      failures := failures || format('%s: cross-company INSERT was ACCEPTED', t);
    exception when others then
      get stacked diagnostics state = returned_sqlstate;
      if state = '42501' then proven_cross := proven_cross + 1;
      elsif state like '23%' then unproven := unproven || format('%s: cross-company INSERT stopped by a constraint (%s) before RLS could decide', t, state);
      else failures := failures || format('%s: cross-company INSERT failed with %s (not an RLS refusal)', t, state);
      end if;
    end;

    -- 2. own-company insert: allowed by RLS iff tenant-writable
    begin
      stmt := format('insert into public.%I (%s) values (%s)', t, cols, replace(vals_tpl, '{C}', quote_literal(a::text)));
      execute stmt;
      if not has_tenant_write then failures := failures || format('%s: tenant-read-only table accepted a tenant INSERT', t); end if;
    exception when others then
      get stacked diagnostics state = returned_sqlstate;
      if has_tenant_write and state = '42501' and not (t = any (shaped)) then
        failures := failures || format('%s: own-company INSERT refused by RLS but the table should be tenant-writable', t);
      elsif not has_tenant_write and state <> '42501' then
        unproven := unproven || format('%s: tenant-read-only table: own INSERT failed with %s, not an RLS refusal', t, state);
      end if;
    end;

    -- 4. seeded B row: A cannot read / update / delete it
    if seeded then
      begin
        execute format('select count(*) from public.%I where company_id = $1', t) into n using b;
        if n <> 0 then failures := failures || format('%s: company A can READ %s company-B row(s)', t, n); end if;
        execute format('with u as (update public.%I set company_id = company_id where company_id = $1 returning 1) select count(*) from u', t) into n using b;
        if n <> 0 then failures := failures || format('%s: company A can UPDATE %s company-B row(s)', t, n); end if;
        execute format('with d as (delete from public.%I where company_id = $1 returning 1) select count(*) from d', t) into n using b;
        if n <> 0 then failures := failures || format('%s: company A can DELETE %s company-B row(s)', t, n); end if;
      exception when others then
        get stacked diagnostics state = returned_sqlstate;
        if state <> '42501' then failures := failures || format('%s: seeded-row check errored (%s)', t, state); end if;
      end;
    end if;

    -- ---- anon: log OUT first (the previous run left A's claim set, so the "anon" probe
    -- was really A's user - the artifact that made four tables look anon-writable) ----
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);
    execute 'set local role anon';
    begin
      stmt := format('insert into public.%I (%s) values (%s)', t, cols, replace(vals_tpl, '{C}', quote_literal(a::text)));
      execute stmt;
      failures := failures || format('%s: ANON insert was ACCEPTED', t);
    exception when others then
      get stacked diagnostics state = returned_sqlstate;
      if state = '42501' then proven_anon := proven_anon + 1;
      elsif state like '23%' then unproven := unproven || format('%s: anon INSERT stopped by a constraint (%s) before RLS could decide', t, state);
      else failures := failures || format('%s: anon INSERT failed with %s (not an access refusal)', t, state);
      end if;
    end;
    if seeded then
      begin
        execute format('select count(*) from public.%I', t) into n;
        if n <> 0 then failures := failures || format('%s: ANON can read %s row(s)', t, n); end if;
      exception when others then null; -- no SELECT privilege for anon is also isolation
      end;
    end if;

    execute 'reset role';
    raise notice '% | tenant-writable=% | seeded-B-row=%', rpad(t, 32), has_tenant_write, seeded;
  end loop;

  -- (Check 5, anon's table privileges, is the standalone tests/db/anon-privileges.sql.)
  raise notice 'checked % tenant tables; complete-row cross-company refusals proven by RLS: %; anon refusals proven by RLS: %; seeded a company-B row for %', tables_checked, proven_cross, proven_anon, tables_seeded;
  if array_length(unproven, 1) > 0 then
    raise notice E'UNPROVEN (% probes stopped by a constraint before RLS could decide):\n%', array_length(unproven, 1), array_to_string(unproven, E'\n');
  end if;
  if array_length(failures, 1) > 0 then
    raise exception E'TENANT ISOLATION VIOLATIONS (%):\n%', array_length(failures, 1), array_to_string(failures, E'\n');
  end if;
end
$$;

rollback;
