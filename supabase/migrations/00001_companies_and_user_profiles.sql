-- Task 1.3 (TASKS.md). Implements the companies/user_profiles tables from
-- docs/schemas.md, plus the current_company_id() helper every later
-- migration's RLS policies rely on. See docs/design/security.md: RLS, not
-- application code, is the actual tenant-isolation boundary.

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table user_profiles (
  id uuid primary key references auth.users (id),
  company_id uuid not null references companies (id),
  role text not null default 'owner',
  display_name text,
  created_at timestamptz not null default now()
);

alter table companies enable row level security;
alter table user_profiles enable row level security;

-- Resolves the calling user's company_id once. Every other table's RLS
-- policy calls this instead of repeating the same subquery (docs'
-- "one source of truth beats duplicated state" principle, applied to SQL).
-- security definer + a pinned search_path is the standard safe pattern for
-- a function that needs to read auth.uid()/user_profiles under RLS.
create or replace function current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from user_profiles where id = auth.uid()
$$;

-- No insert/update policy on companies: company creation isn't a client
-- action in the MVP (docs/user-stories.md has no signup/onboarding
-- workflow yet) - only readable by its own members.
create policy "read own company" on companies
  for select using (id = current_company_id());

-- Profile editing isn't an MVP requirement either - read-only via RLS for
-- now; extend with an update policy if/when that becomes a real need.
create policy "read own profile" on user_profiles
  for select using (id = auth.uid());
