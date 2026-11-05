-- Tenant-isolation check across EVERY table that has a company_id (audit Wave 4,
-- docs/reconciliation/wave-4-test-matrix.md). Pure SQL; runs in one transaction
-- and ROLLS BACK, so it leaves nothing behind. It creates two companies and two
-- users, "logs in" as company A's user, and proves for each tenant table:
--   1. cross-company INSERT (company_id = B) is refused by RLS (SQLSTATE 42501);
--   2. own-company INSERT is NOT refused by RLS where the table is tenant-writable,
--      and IS refused where it is read-only for tenants (the research family etc.);
--   3. anon cannot write;
--   4. where a company-B row could be seeded (best-effort: tables with extra
--      NOT NULL columns can't be), company A's user sees 0 B rows and can
--      update/delete 0 of them.
-- It prints a coverage line per table and RAISES on any violation.
--
-- Run (scratch):  psql -d scratch -f tests/db/scratch-auth-shim.sql -f tests/db/rls-isolation.sql
-- Run (live, King): paste into the Supabase SQL editor as-is (it rolls back).
-- A seeded-row step needs superuser (session_replication_role); on a managed
-- project that step reports "seed skipped" and parts 1-3 still run.

begin;

do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  t text;
  failures text[] := '{}';
  has_tenant_write boolean;
  seeded boolean;
  n bigint;
  tables_checked int := 0;
  tables_seeded int := 0;
  state text;
  col record;
  cols text;
  vals text;
  lit text;
  -- tables whose tenant INSERT policy also fences the row's SHAPE (manual, queued
  -- research runs only): a bare company_id row is rightly refused there.
  shaped constant text[] := array['research_runs', 'research_requests'];
begin
  -- fixtures (as the owner of the transaction)
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

    -- best-effort seed of a company-B row (superuser only; FK triggers off).
    -- Fills NOT NULL columns that have no default with a type-appropriate value;
    -- text columns take the first literal of any IN (...) check on the column.
    seeded := false;
    begin
      perform set_config('session_replication_role', 'replica', true);
      cols := 'company_id';
      vals := quote_literal(b::text) || '::uuid';
      for col in
        select c.column_name, c.data_type, c.udt_name from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = t and c.is_nullable = 'NO'
          and c.column_default is null and c.column_name <> 'company_id' and c.is_generated = 'NEVER'
          and coalesce(c.is_identity, 'NO') = 'NO'
      loop
        cols := cols || ', ' || quote_ident(col.column_name);
        if col.data_type = 'uuid' then vals := vals || ', gen_random_uuid()';
        elsif col.data_type in ('integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real') then vals := vals || ', 1';
        elsif col.data_type = 'boolean' then vals := vals || ', false';
        elsif col.data_type = 'date' then vals := vals || ', current_date';
        elsif col.data_type like 'timestamp%' then vals := vals || ', now()';
        elsif col.data_type in ('jsonb', 'json') then vals := vals || ', ''{}''::' || col.data_type;
        elsif col.data_type = 'ARRAY' then vals := vals || ', ''{}''';
        else
          select (regexp_match(pg_get_constraintdef(k.oid), '''([^'']+)'''))[1] into lit
          from pg_constraint k
          where k.conrelid = format('public.%I', t)::regclass and k.contype = 'c'
            and pg_get_constraintdef(k.oid) ilike '%' || col.column_name || '%'
          limit 1;
          vals := vals || ', ' || quote_literal(coalesce(lit, 'x'));
        end if;
      end loop;
      execute format('insert into public.%I (%s) values (%s)', t, cols, vals);
      seeded := true;
      tables_seeded := tables_seeded + 1;
    exception when others then
      seeded := false;
    end;
    perform set_config('session_replication_role', 'origin', true);

    -- log in as A's user
    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', ua::text, true);

    -- 1. cross-company insert must be refused by RLS
    begin
      execute format('insert into public.%I (company_id) values ($1)', t) using b;
      failures := failures || format('%s: cross-company INSERT was accepted', t);
    exception when others then
      get stacked diagnostics state = returned_sqlstate;
      if state <> '42501' then
        failures := failures || format('%s: cross-company INSERT failed with %s (not an RLS refusal) - policy let it past RLS', t, state);
      end if;
    end;

    -- 2. own-company insert: allowed by RLS iff tenant-writable
    begin
      execute format('insert into public.%I (company_id) values ($1)', t) using a;
      -- accepted outright (rare: no NOT NULL columns). Fine only if tenant-writable.
      if not has_tenant_write then failures := failures || format('%s: tenant-read-only table accepted a tenant INSERT', t); end if;
    exception when others then
      get stacked diagnostics state = returned_sqlstate;
      if has_tenant_write and state = '42501' and not (t = any (shaped)) then
        failures := failures || format('%s: own-company INSERT refused by RLS but the table should be tenant-writable', t);
      elsif not has_tenant_write and state <> '42501' then
        failures := failures || format('%s: tenant-read-only table did not refuse a tenant INSERT at RLS (got %s)', t, state);
      end if;
    end;

    -- 4. isolation of a seeded B row
    if seeded then
      begin
        execute format('select count(*) from public.%I where company_id = $1', t) into n using b;
        if n <> 0 then failures := failures || format('%s: company A can READ %s company-B row(s)', t, n); end if;
        execute format('with u as (update public.%I set company_id = company_id where company_id = $1 returning 1) select count(*) from u', t) into n using b;
        if n <> 0 then failures := failures || format('%s: company A can UPDATE %s company-B row(s)', t, n); end if;
        execute format('with d as (delete from public.%I where company_id = $1 returning 1) select count(*) from d', t) into n using b;
        if n <> 0 then failures := failures || format('%s: company A can DELETE %s company-B row(s)', t, n); end if;
      exception when others then
        -- a permission error on read is also isolation (not a leak); anything else is noted
        get stacked diagnostics state = returned_sqlstate;
        if state <> '42501' then failures := failures || format('%s: seeded-row check errored (%s)', t, state); end if;
      end;
    end if;

    -- 3. anon cannot write
    execute 'set local role anon';
    begin
      execute format('insert into public.%I (company_id) values ($1)', t) using a;
      failures := failures || format('%s: ANON insert was accepted', t);
    exception when others then
      get stacked diagnostics state = returned_sqlstate;
      if state <> '42501' then failures := failures || format('%s: anon INSERT failed with %s (not an access refusal)', t, state); end if;
    end;

    execute 'reset role';
    raise notice '% | tenant-writable=% | seeded-B-row=%', rpad(t, 32), has_tenant_write, seeded;
  end loop;

  raise notice 'checked % tenant tables; seeded a company-B row for %; violations: %', tables_checked, tables_seeded, coalesce(array_length(failures, 1), 0);
  if array_length(failures, 1) > 0 then
    raise exception E'TENANT ISOLATION VIOLATIONS:\n%', array_to_string(failures, E'\n');
  end if;
end
$$;

rollback;
