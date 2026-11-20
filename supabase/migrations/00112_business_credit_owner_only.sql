-- 00112 - Audit F-002 (verified 2026-11-20): Business Credit is owner-only business (the app's
-- page rule and API already say so), but the database policies from 00087 were company-wide, so
-- any logged-in member of the company - a driver, once drivers get logins - could read and write
-- it straight through the API. This makes the database itself enforce it: same company AND the
-- caller's role is 'owner'. The server-side service role (Abel's Telegram turns, the email watch)
-- bypasses RLS as before. Today the company has one member (the owner), so nothing he sees changes.

create or replace function private.current_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and role = 'owner'
  )
$$;
revoke execute on function private.current_user_is_owner() from public, anon;
grant execute on function private.current_user_is_owner() to authenticated, service_role;

drop policy if exists "tenant isolation" on public.business_credit_profiles;
drop policy if exists "owner only" on public.business_credit_profiles;
create policy "owner only" on public.business_credit_profiles
  for all
  using (company_id = (select private.current_company_id()) and (select private.current_user_is_owner()))
  with check (company_id = (select private.current_company_id()) and (select private.current_user_is_owner()));

drop policy if exists "tenant isolation" on public.business_credit_accounts;
drop policy if exists "owner only" on public.business_credit_accounts;
create policy "owner only" on public.business_credit_accounts
  for all
  using (company_id = (select private.current_company_id()) and (select private.current_user_is_owner()))
  with check (company_id = (select private.current_company_id()) and (select private.current_user_is_owner()));

drop policy if exists "tenant isolation" on public.business_credit_events;
drop policy if exists "owner only" on public.business_credit_events;
create policy "owner only" on public.business_credit_events
  for all
  using (company_id = (select private.current_company_id()) and (select private.current_user_is_owner()))
  with check (company_id = (select private.current_company_id()) and (select private.current_user_is_owner()));
