-- Bot intelligence v2 (docs/design/driver-mvp.md §8). Write actions
-- the bot PROPOSES (as opposed to writes the owner directly orders,
-- which execute immediately) wait here for his yes. One row per
-- proposal: the tool name, its validated arguments, and the
-- human-readable summary he was shown. Resolution (execute or drop)
-- soft-deletes the row; proposals older than 2 hours are treated as
-- expired by the bot and never executed, so a stale "yes" can't
-- write a time-wrong duty log. Same conventions as every other
-- table: company_id + tenant-isolation RLS, soft delete, timestamps.

create table bot_pending_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  channel text not null,
  constraint bot_pending_actions_channel_valid check (channel in ('telegram', 'web')),
  tool_name text not null,
  arguments jsonb not null,
  summary text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table bot_pending_actions enable row level security;

create policy "tenant isolation" on bot_pending_actions
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
