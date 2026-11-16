-- 00096 - Abel's "can't do that yet" list (owner 2026-11-16: "It should be able
-- to do whatever I ask"; design docs/design/abel-do-what-i-ask.md).
--
-- When the owner asks Abel for something no tool can do, Abel says plainly what
-- is missing AND records the ask here, so nothing he wanted is silently dropped
-- and the list becomes the build backlog he can see in the app
-- (More -> What Abel can't do yet). Recording a gap changes no business record.
--
-- APPLY BEFORE DEPLOY is not required: until it is applied, the record write
-- fails (logged, never thrown) and Abel still tells him what it can't do.
-- Additive, tenant-isolated, soft-delete, no seed, like every bot table.

create table abel_capability_gaps (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  -- His words, as he said them.
  asked text not null check (char_length(asked) between 1 and 1000),
  -- What is missing, in plain words (Abel's account).
  missing text not null check (char_length(missing) between 1 and 500),
  -- How many times he has asked for this same thing (re-asks bump it).
  times_asked integer not null default 1 check (times_asked >= 1),
  -- open -> built (the capability shipped) or dismissed (he said drop it).
  status text not null default 'open' check (status in ('open', 'built', 'dismissed')),
  created_at timestamptz not null default now(),
  last_asked_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index abel_capability_gaps_company_status
  on abel_capability_gaps (company_id, status, last_asked_at desc)
  where deleted_at is null;

alter table abel_capability_gaps enable row level security;

create policy "tenant isolation" on abel_capability_gaps
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
