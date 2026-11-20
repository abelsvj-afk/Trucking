-- Audit F-001 (2026-11-19 audit, verified 2026-11-20): claim_next_outbound_call
-- (00100) is SECURITY DEFINER with no search_path and no caller check, so any
-- logged-in user could claim — and start dialing — another company's queued
-- call by passing that company's id.
--
-- Fix (replaces the function; 00100 itself stays frozen):
--  - `set search_path = public, pg_temp` (no lookup hijack through a caller's path);
--  - a logged-in user (role anon / authenticated) may claim ONLY for their own
--    company; anything else is refused with 42501. The service role (webhook,
--    queue worker) and direct database sessions with no request claims keep
--    working for any company, as before.
--  - execute stays granted to authenticated: the web chat's call tool claims
--    with the user's own session.
-- Same body otherwise (advisory lock, one call at a time per company).

create or replace function public.claim_next_outbound_call(p_company_id uuid)
returns public.outbound_calls
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed public.outbound_calls;
  caller_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
begin
  if caller_role in ('anon', 'authenticated')
     and p_company_id is distinct from private.current_company_id() then
    raise exception 'not allowed to claim calls for this company' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('outbound-call-claim-' || p_company_id::text));
  if exists (
    select 1 from public.outbound_calls
    where company_id = p_company_id
      and status in ('dialing', 'in_progress')
      and deleted_at is null
  ) then
    return null;
  end if;
  select * into claimed from public.outbound_calls
    where company_id = p_company_id
      and status = 'queued'
      and deleted_at is null
    order by created_at asc
    limit 1
    for update skip locked;
  if claimed.id is null then
    return null;
  end if;
  update public.outbound_calls
    set status = 'dialing', updated_at = now()
    where id = claimed.id;
  select * into claimed from public.outbound_calls where id = claimed.id;
  return claimed;
end;
$$;

revoke execute on function public.claim_next_outbound_call(uuid) from public, anon;
grant execute on function public.claim_next_outbound_call(uuid) to authenticated, service_role;
