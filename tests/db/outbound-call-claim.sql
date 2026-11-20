-- Audit F-001 (migration 00108): claim_next_outbound_call refuses a logged-in
-- user claiming ANOTHER company's queued call, still lets them claim their own,
-- and still serves the service role for any company. One transaction; rolls back.
-- Scratch: run after tests/db/scratch-auth-shim.sql.
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/outbound-call-claim.sql

begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000b1');
insert into companies (id, name) values
  ('00000000-0000-0000-0000-00000000aa01', 'A'), ('00000000-0000-0000-0000-00000000bb01', 'B');
insert into user_profiles (id, company_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000bb01');
insert into outbound_calls (company_id, to_number, to_name, purpose, say) values
  ('00000000-0000-0000-0000-00000000aa01', '+15550000001', 'A shipper', 'test', 'hi'),
  ('00000000-0000-0000-0000-00000000bb01', '+15550000002', 'B shipper', 'test', 'hi'),
  ('00000000-0000-0000-0000-00000000bb01', '+15550000003', 'B broker', 'test', 'hi');

-- Logged in as company A's user.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}', true);

do $$
declare refused boolean := false; c record;
begin
  begin
    perform public.claim_next_outbound_call('00000000-0000-0000-0000-00000000bb01');
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'FAIL: company A''s user claimed company B''s call'; end if;
  raise notice 'ok: cross-company claim refused (42501)';

  select * into c from public.claim_next_outbound_call('00000000-0000-0000-0000-00000000aa01');
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
  select * into c from public.claim_next_outbound_call('00000000-0000-0000-0000-00000000bb01');
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
