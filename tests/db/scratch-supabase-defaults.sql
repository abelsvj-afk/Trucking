-- SCRATCH ONLY. Run after the Supabase stub and BEFORE the migrations, so tables
-- are created with the grants a real Supabase project gives them (anon and
-- authenticated can write at the privilege level; row-level security is then
-- the only thing standing between them and the data). Without this the scratch
-- DB refuses anon writes for lack of privilege and the RLS check is never reached.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
