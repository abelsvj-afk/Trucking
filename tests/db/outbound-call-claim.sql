-- Audit F-001 (migration 00108): claim_next_outbound_call refuses a logged-in
-- user claiming ANOTHER company's queued call, still lets them claim their own,
-- and still serves the service role for any company. One transaction; rolls back.
-- Scratch: run after tests/db/scratch-auth-shim.sql.
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/outbound-call-claim.sql
--
-- LIVE-SAFE FIXTURES (2026-11-20): the first live run of this check died in
-- setup. The original fixture used fixed company/user ids and only ever ran
-- against an empty scratch database; against a populated production database
-- a fixture must create every row it depends on and must not rely on specific
-- ids being free (a fixed id can already exist, or be left behind by an
-- earlier interrupted run). Fixture ids are now generated per run and carried
-- in transaction-local settings (occ.*), so the check runs against any
-- populated database and still undoes itself completely at rollback.
-- Assertions unchanged.

begin;

-- Fixture setup: two companies, one user each, queued calls for both -
-- every row created here, every id generated here, in FK order.
do $$
declare
  company_a uuid := gen_random_uuid();
  company_b uuid := gen_random_uuid();
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
begin
  perform set_config('occ.company_a', company_a::text, true);
  perform set_config('occ.company_b', company_b::text, true);
  perform set_config('occ.user_a', user_a::text, true);
  perform set_config('occ.user_b', user_b::text, true);

  insert into auth.users (id, email) values
    (user_a, 'occ-fixture-a@example.invalid'),
    (user_b, 'occ-fixture-b@example.invalid');
  insert into companies (id, name) values
    (company_a, 'OCC fixture A'), (company_b, 'OCC fixture B');
  insert into user_profiles (id, company_id) values
    (user_a, company_a),
    (user_b, company_b);
  insert into outbound_calls (company_id, to_number, to_name, purpose, say) values
    (company_a, '+15550000001', 'A shipper', 'test', 'hi'),
    (company_b, '+15550000002', 'B shipper', 'test', 'hi'),
    (company_b, '+15550000003', 'B broker', 'test', 'hi');
end $$;

-- Logged in as company A's user.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('occ.user_a'), true);
select set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', current_setting('occ.user_a')), true);

do $$
declare refused boolean := false; c record;
begin
  begin
    perform public.claim_next_outbound_call(current_setting('occ.company_b')::uuid);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'FAIL: company A''s user claimed company B''s call'; end if;
  raise notice 'ok: cross-company claim refused (42501)';

  select * into c from public.claim_next_outbound_call(current_setting('occ.company_a')::uuid);
  if c.id is null or c.status <> 'dialing' then raise exception 'FAIL: own-company claim did not work'; end if;
  raise notice 'ok: own-company claim works';
end $$;

-- The service role (webhook / queue worker) claims for any company.
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare c record;
begin
  select * into c from public.claim_next_outbound_call(current_setting('occ.company_b')::uuid);
  if c.id is null then raise exception 'FAIL: service role could not claim'; end if;
  raise notice 'ok: service role claims for any company';
end $$;

reset role;
do $$
begin
  if not exists (
    select 1 from pg_proc where proname = 'claim_next_outbound_call'
      and proconfig @> array['search_path=public, pg_temp']
  ) then raise exception 'FAIL: search_path not pinned'; end if;
  raise notice 'ok: search_path pinned';
end $$;

rollback;
