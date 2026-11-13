-- 00095 - Telegram quote targets (Telegram review fix, owner order
-- 2026-11-12; defect D4).
--
-- APPLY AFTER 00094: this migration is numbered after 00094
-- (tax_set_aside_bps, claimed by the tax-set-aside branch) and
-- 00093 (telegram_dead_letters, merged to main), and applies after
-- them in sequence. There is no foreign-key or data dependency on
-- 00093 or 00094 - the ordering is sequence-only.
-- Apply before deploy: until this migration is applied, the quote
-- lookup fails (logged, fail-closed - a quoted yes/no executes
-- nothing), so quotes do not resolve. Apply this first and the
-- mapping works from the first deploy.
--
-- telegram_quote_targets: the quote IS the pointer (owner rule).
-- When Abel sends a message that renders one or more proposal
-- groups, the bot records (Telegram message id -> the group keys
-- rendered in that message) here. A group is a dump batch (key =
-- batch_id) or a lone single proposal (key = the pending row's id).
-- One message can render several groups and one group is rendered
-- in several messages (first staged, then re-listed in "Still
-- waiting" footers), so this is a many-to-many mapping table - not
-- a column on bot_pending_actions. `position` is the group's order
-- as rendered in that message, so a numbered answer means the same
-- thing when shown and when answered. Rows are resolved only
-- against groups that are still open, so a settled or expired
-- group naturally yields the one-line "already settled" answer;
-- no pruning job, the rows are the audit trail of what a message
-- rendered. Additive, tenant-isolated, soft-delete, no seed, like
-- every bot table.

create table telegram_quote_targets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  chat_id text not null,
  message_id bigint not null,
  group_key text not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint telegram_quote_targets_unique unique (company_id, chat_id, message_id, group_key)
);

create index telegram_quote_targets_lookup
  on telegram_quote_targets (company_id, chat_id, message_id, position)
  where deleted_at is null;

alter table telegram_quote_targets enable row level security;

create policy "tenant isolation" on telegram_quote_targets
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
