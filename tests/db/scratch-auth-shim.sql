-- SCRATCH ONLY (never run on the live project - Supabase already provides
-- these). Makes the stubbed auth.uid() read the request claim the way
-- Supabase's does, so tests/db/rls-isolation.sql can "log in" as a user.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), ''), '')::uuid
$$;
grant usage on schema auth, private to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
