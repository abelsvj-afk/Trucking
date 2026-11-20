-- Audit F-024 (migration 00109): reserve_bot_spend inserts a reservation only
-- while the month still has room under the cap, and is closed to logged-in
-- users. Privileged role; one transaction; rolls back.
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/bot-spend-reservation.sql

begin;

insert into companies (id, name) values ('00000000-0000-0000-0000-00000000aa01', 'A');
insert into bot_identities (slug, display_name)
  select 'abel', 'Abel' where not exists (select 1 from bot_identities where slug = 'abel');

do $$
declare a uuid := '00000000-0000-0000-0000-00000000aa01'; r1 uuid; r2 uuid; r3 uuid; total int;
begin
  r1 := public.reserve_bot_spend(a, 'abel', 'm', 'scan', 6, 10, now() - interval '1 day');
  r2 := public.reserve_bot_spend(a, 'abel', 'm', 'scan', 6, 10, now() - interval '1 day');
  if r1 is null then raise exception 'FAIL: first reservation under the cap was refused'; end if;
  if r2 is not null then raise exception 'FAIL: second reservation went over the cap'; end if;
  raise notice 'ok: a reservation that would pass the cap is refused';

  perform public.settle_bot_spend(a, r1, 2);
  r3 := public.reserve_bot_spend(a, 'abel', 'm', 'scan', 6, 10, now() - interval '1 day');
  if r3 is null then raise exception 'FAIL: settling down did not free the room'; end if;
  select sum(estimated_cents) into total from bot_spend_ledger where company_id = a;
  if total <> 8 then raise exception 'FAIL: ledger total % (expected 8)', total; end if;
  raise notice 'ok: settle replaces the reserved amount with the real one';

  if has_function_privilege('authenticated', 'public.reserve_bot_spend(uuid, text, text, text, integer, integer, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.reserve_bot_spend(uuid, text, text, text, integer, integer, timestamptz)', 'execute') then
    raise exception 'FAIL: logged-in users can call reserve_bot_spend';
  end if;
  raise notice 'ok: closed to anon and authenticated';
end $$;

rollback;
