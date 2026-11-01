-- Gaming System (docs/design/gaming-system.md) - the monthly
-- scoreboard (design §§2.5/4.3). One row per month per target:
-- what the then-current plan said he'd be at, what actually
-- happened, the verdict, and the ONE lever named for next month.
-- A month with no records closes as 'no_data', never silently as
-- 'on_plan'. Checkpoint messages are information only - nothing in
-- this table is an action, and closing a checkpoint never edits a
-- target, a sweep, or a milestone (design §4.3).

create table game_checkpoints (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  target_id uuid not null references game_targets (id),
  -- First of the month, America/New_York (design §2.5).
  period_month date not null,
  -- What the then-current plan projected for this month (a
  -- projection, labeled as one wherever it renders).
  planned_value_cents bigint not null,
  -- Filled when the month closes; null until then.
  actual_value_cents bigint,
  verdict text,
  constraint game_checkpoints_verdict_valid
    check (verdict is null or verdict in ('on_plan', 'ahead', 'behind', 'no_data')),
  -- actual - planned for the primary metric.
  gap_cents bigint,
  -- The single lever named for next month (design §4.3).
  lever_note text,
  telegram_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One close per month per target - the scheduler's close is
-- idempotent because this index refuses a second row.
create unique index game_checkpoints_one_per_month
  on game_checkpoints (company_id, target_id, period_month)
  where deleted_at is null;

alter table game_checkpoints enable row level security;

create policy "tenant isolation" on game_checkpoints
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
