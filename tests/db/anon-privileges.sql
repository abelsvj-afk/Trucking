-- Check 5 of the isolation work: the `anon` role holds NO write privilege on any
-- table in public (migration 00067). Read-only catalog query; changes nothing.
-- Returns one row per offending table/privilege; an empty result is a pass.
-- Paste into the Supabase SQL editor (live) or run with psql (scratch).
select c.relname as table_name, p.priv as anon_can
from pg_class c
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
where c.relkind in ('r', 'p')
  and has_table_privilege('anon', c.oid, p.priv)
order by 1, 2;
