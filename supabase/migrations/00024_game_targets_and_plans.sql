-- Gaming System (docs/design/gaming-system.md). The owner's target
-- and the versioned plans gamed against it. Migration range 00024-
-- 00026 is reserved for this system (00024 = targets + plans + the
-- run log, 00025 = checkpoints, 00026 = indexes). Same conventions
-- as every other table: company_id + tenant-isolation RLS, soft
-- delete, created_at/updated_at. NOTHING in these tables moves
-- money, changes a target by itself, or executes a plan - a plan is
-- a projection he aims at, stored so reality can be diffed against
-- it (design §0).

-- One row per target he has ever set; is_active marks the live one.
-- Old targets are deactivated, never deleted - they are the history
-- of what he was aiming at (design §1.1).
create table game_targets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  metric text not null,
  constraint game_targets_metric_valid
    check (metric in
      ('monthly_net_cents', 'truck_fund_cents', 'business_value_cents', 'net_worth_cents')),
  target_value_cents bigint not null,
  constraint game_targets_value_positive check (target_value_cents > 0),
  -- null = open-ended ("no deadline, just maximize the trajectory");
  -- the engine then games a rolling 24-month horizon (design §1.1).
  target_date date,
  posture text not null,
  constraint game_targets_posture_valid
    check (posture in ('conservative', 'mixed')),
  -- 0 = pure conservative, 100 = fully mixed. The slider weights how
  -- much of the gap the RECOMMENDED plan may assign to side-income
  -- levers; the mixed scenario itself always renders (design §1.1).
  posture_mix_pct integer not null default 0,
  constraint game_targets_mix_range
    check (posture_mix_pct between 0 and 100),
  notes text,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- At most one active target per company (design §1.1).
create unique index game_targets_one_active
  on game_targets (company_id) where is_active and deleted_at is null;

alter table game_targets enable row level security;

create policy "tenant isolation" on game_targets
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- One row per generated plan VERSION. Never updated in place after
-- creation except status: a re-game inserts a new row and the prior
-- current plan becomes 'superseded' - never a silent overwrite
-- (design §§2.5/4.2). A plan that fails the Finance Project's
-- STABILIZE validity checks is stored as 'invalid_rules' with the
-- violated rules recorded in scenarios.validity, alongside the
-- nearest valid plan that replaced it (design §5.5).
create table game_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  target_id uuid not null references game_targets (id),
  -- Per-target, monotonically increasing across all statuses.
  version integer not null,
  status text not null,
  constraint game_plans_status_valid
    check (status in ('current', 'superseded', 'what_if', 'invalid_rules')),
  trigger text not null,
  constraint game_plans_trigger_valid
    check (trigger in
      ('target_set', 'target_edit', 'checkpoint', 'settlement', 'fund_milestone',
       'research_briefing', 'maintenance_event', 'manual', 'what_if')),
  -- The §2.2 actuals, frozen at generation - every figure in the
  -- narration must trace to this snapshot, the assumption sheet, or
  -- engine arithmetic on those two (design §5.3).
  snapshot jsonb not null,
  -- The §2.3 assumption sheet: [{key, value, source, adjustable}].
  -- An assumption with no source is invalid output (design §2.3).
  assumptions jsonb not null,
  -- The §3 engine output: three trajectory lines, the gap block,
  -- milestone spine, demands block, validity verdict.
  scenarios jsonb not null,
  -- The model's plain-language plan (grounded + banned-phrase
  -- checked before this row may become 'current', design §§2.4/5).
  narration text not null,
  -- Code-computed comparison vs the previous current version:
  -- what changed and why (design §4.2). Null on version 1.
  diff_summary text,
  -- {completed_loads, weeks_of_history, thin_data} - the stamp
  -- rides every rendering of the plan (design §§2.2/5.6).
  data_sufficiency jsonb not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table game_plans enable row level security;

create policy "tenant isolation" on game_plans
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- The run log (design §2.4): every generation attempt lands here -
-- success, failure, and the governance outcomes (skipped_cap,
-- skipped_disabled) that must be visible rather than silent, the
-- same discipline as research_runs. Caps are counted from this
-- table, never from memory.
create table game_plan_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  target_id uuid references game_targets (id),
  trigger text not null,
  constraint game_plan_runs_trigger_valid
    check (trigger in
      ('target_set', 'target_edit', 'checkpoint', 'settlement', 'fund_milestone',
       'research_briefing', 'maintenance_event', 'manual', 'what_if')),
  status text not null,
  constraint game_plan_runs_status_valid
    check (status in
      ('success', 'failure', 'skipped_cap', 'skipped_disabled', 'invalid_replaced')),
  plan_id uuid references game_plans (id),
  detail text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table game_plan_runs enable row level security;

create policy "tenant isolation" on game_plan_runs
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
