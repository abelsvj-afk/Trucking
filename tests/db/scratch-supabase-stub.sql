-- SCRATCH ONLY (never run on the live project): the minimum of Supabase a migration replay needs -
-- the auth/storage schemas, the three API roles, auth.uid()/auth.jwt() stubs and pgcrypto.
create schema if not exists auth; create schema if not exists storage; create schema if not exists extensions; create schema if not exists vault;
do $$ begin
 perform 1; 
 if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
create or replace function storage.foldername(n text) returns text[] language sql as $$ select string_to_array(n,'/') $$;
create extension if not exists pgcrypto;
