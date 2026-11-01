-- Gaming System (docs/design/gaming-system.md) - the reserved
-- spare slot (design §6.2), used for what the build actually
-- discovered it needs: the indexes below, and one kind widening.
-- The capability row itself needs NO migration:
-- ai_capability_settings rows are runtime data written by the
-- Settings PATCH, and 'game_plan' fails closed (off) until the
-- owner creates the row by flipping the switch - the same
-- convention as every other capability (migration 00008).
--
-- Persistent assumption overrides (design §2.5) live in
-- bot_memories under a dedicated kind, 'game_assumption' - the
-- design names the kind, so this migration widens the kind check
-- (set by 00014, widened by 00028) to admit it. The rows are JSON
-- for the plan engine, excluded from conversational memory
-- retrieval in code (services/telegram/context.ts).

alter table bot_memories
  drop constraint bot_memories_kind_valid;

alter table bot_memories
  add constraint bot_memories_kind_valid
  check (kind in (
    'fact', 'note', 'expense_hint', 'instruction',
    'person_profile', 'business_fact', 'game_assumption'
  ));

-- Plan lookups are always "this target's versions, newest first"
-- (current plan, history, diff base) and "this company's runs
-- today" (the §2.4 daily re-game cap counted from the run log).
create index game_plans_target_version_idx
  on game_plans (company_id, target_id, version desc)
  where deleted_at is null;

create index game_plans_company_created_idx
  on game_plans (company_id, created_at desc)
  where deleted_at is null;

create index game_plan_runs_company_created_idx
  on game_plan_runs (company_id, created_at desc)
  where deleted_at is null;

create index game_checkpoints_company_month_idx
  on game_checkpoints (company_id, period_month desc)
  where deleted_at is null;

create index game_targets_company_active_idx
  on game_targets (company_id, is_active)
  where deleted_at is null;
