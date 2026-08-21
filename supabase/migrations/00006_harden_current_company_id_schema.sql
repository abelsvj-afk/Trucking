-- Fixes a real finding from Supabase's own security advisor (get_advisors),
-- run immediately after applying 00001-00005: current_company_id() was
-- unintentionally reachable via PostgREST's auto-generated
-- /rest/v1/rpc/current_company_id endpoint, since Supabase exposes every
-- function in the public schema by default. Not an actual data leak (an
-- anonymous caller gets null back; an authenticated caller only gets their
-- own company_id, which they already know) - but it's needless public
-- surface for a function that only exists to be called from inside RLS
-- policies, not as an API.
--
-- Fix: move it to a schema PostgREST doesn't expose (Supabase only exposes
-- `public` by default). This does NOT break the RLS policies created in
-- 00001-00005 that reference it - Postgres resolves a function used inside
-- a policy expression to its OID at creation time, not by a fresh name
-- lookup on every query, so ALTER FUNCTION ... SET SCHEMA is safe here.

create schema if not exists private;

alter function public.current_company_id() set schema private;
