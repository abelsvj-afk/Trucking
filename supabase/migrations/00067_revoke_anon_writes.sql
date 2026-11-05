-- 00067 - No anonymous write path on ANY table (owner order 2026-11-05).
-- Supabase gives the `anon` role full table privileges by default and leaves
-- row-level security as the only barrier. RLS is correct on every table
-- (tests/db/rls-isolation.sql proves it with complete rows), but an anonymous
-- caller has no business holding write privileges at all, so a future policy
-- mistake could never become an anonymous write. Defense in depth:
--   1. revoke INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER from
--      anon on every existing table in public;
--   2. make that the default for tables created later.
-- SELECT is left as granted (RLS still scopes it; the world-readable research
-- health tables are read by design). The signed-in role (`authenticated`) and
-- the server's service role are untouched.
-- Idempotent.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
    alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;
  end if;
end
$$;
