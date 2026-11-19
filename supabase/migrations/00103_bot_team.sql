-- Bot team baseline (Phase 0; plan docs/bot-team-build-plan.md).
-- The dispatch bot team shares one Supabase backend: bot identities,
-- per-bot memory, a shared load ledger (the learn-from-every-load loop's
-- raw material), a proposal + audit log, the Telegram group room, and a
-- spend ledger for the hard model-spending cap.
--
-- Numbering: 00102 is claimed twice by unmerged branches (B1
-- duty_log_disputes, B8 location_voice_notes), so this build starts at
-- 00103. Nothing earlier is edited (migrations are frozen once applied).
--
-- Money is integer cents everywhere, decimal-exact, rounded once.
-- Miles are numeric(10,2) — they are measurements, not money.
-- Every table is RLS by company_id. Bots write through the service-role
-- client (the documented webhook exception, same as the Telegram bot);
-- the app reads through RLS. No authenticated insert/update policies:
-- nothing in this schema is ever written from a user session.
--
-- This migration is AUTHORED, NOT applied. The live apply is the
-- owner's tap, via King's lane, before any deploy that reads it.

create table if not exists bot_identities (
  slug text primary key check (slug in ('abel', 'dispatch-scout', 'tracker', 'compliance-watchdog', 'maintenance', 'billing', 'auditor')),
  display_name text not null check (char_length(display_name) between 1 and 60),
  seat text not null check (char_length(seat) between 1 and 80),
  status text not null default 'planned' check (status in ('planned', 'live', 'paused')),
  -- Tool scope per governing file (docs/bots/<slug>/CLAUDE.md):
  -- {"loads": "read"|"draft"|"read-write"|"flag"|"none", ...}.
  -- The gateway hides every tool group a bot is not allowed; a bot
  -- cannot call what it cannot see.
  tool_scope jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into bot_identities (slug, display_name, seat, status, tool_scope) values
  ('abel', 'Abel', 'day-to-day assistant', 'live',
   '{"loads": "read-write", "hos": "read-write", "money": "read-write", "documents": "read-write", "email": "read-write", "maps": "read-write", "app-actions": "read-write", "calls": "gated", "signature": "never"}'::jsonb),
  ('dispatch-scout', 'Dispatch Scout', 'load planner', 'planned',
   '{"loads": "read", "hos": "read", "money": "read", "documents": "read", "email": "read", "maps": "draft", "app-actions": "draft", "calls": "gated", "signature": "never"}'::jsonb),
  ('tracker', 'Tracker', 'check-calls and ETA', 'planned',
   '{"loads": "read", "hos": "read", "money": "none", "documents": "read", "email": "none", "maps": "read", "app-actions": "draft", "calls": "gated", "signature": "never"}'::jsonb),
  ('compliance-watchdog', 'Compliance Watchdog', 'HOS and safety alerts', 'planned',
   '{"loads": "read", "hos": "read", "money": "none", "documents": "read", "email": "none", "maps": "read", "app-actions": "flag", "calls": "never", "signature": "never"}'::jsonb),
  ('maintenance', 'Maintenance', 'PM and inspections', 'planned',
   '{"loads": "read", "hos": "none", "money": "read", "documents": "read", "email": "read", "maps": "none", "app-actions": "draft", "calls": "gated", "signature": "never"}'::jsonb),
  ('billing', 'Billing', 'invoice drafter', 'planned',
   '{"loads": "read", "hos": "none", "money": "read", "documents": "read", "email": "read", "maps": "none", "app-actions": "draft", "calls": "gated", "signature": "never"}'::jsonb),
  ('auditor', 'Auditor', 'fact-checker', 'planned',
   '{"loads": "read", "hos": "read", "money": "read", "documents": "read", "email": "read", "maps": "read", "app-actions": "flag", "calls": "never", "signature": "never"}'::jsonb)
on conflict (slug) do nothing;

-- Per-bot memory: the live counterpart of each bot's injectable
-- MEMORY.md (docs/bots/<slug>/MEMORY.md). The MD file is the owner's
-- editable copy; these rows are what a running bot reads. `kind` is
-- 'fact' | 'rule' | 'preference' | 'correction' | 'watch-out'.
create table if not exists bot_team_memories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  bot_slug text not null references bot_identities(slug) on delete cascade,
  kind text not null check (kind in ('fact', 'rule', 'preference', 'correction', 'watch-out')),
  content text not null check (char_length(content) between 1 and 4000),
  source text not null default 'owner' check (char_length(source) between 1 and 80),
  created_at timestamptz not null default now()
);
create index if not exists bot_team_memories_company_bot_idx on bot_team_memories (company_id, bot_slug, created_at desc);

-- Shared load ledger: one row per load outcome, booked or not. This is
-- the learn-from-every-load loop's raw material — a skipped load teaches
-- as much as a booked one, so `outcome` covers both. All money is
-- integer cents; miles are numeric. `rate_cents_per_loaded_mile` is
-- null when the broker quoted a flat total instead of a per-mile rate.
create table if not exists bot_load_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  load_ref text not null check (char_length(load_ref) between 1 and 120),
  broker_name text check (broker_name is null or char_length(broker_name) between 1 and 120),
  origin text check (origin is null or char_length(origin) between 1 and 120),
  destination text check (destination is null or char_length(destination) between 1 and 120),
  rate_cents_per_loaded_mile integer check (rate_cents_per_loaded_mile is null or rate_cents_per_loaded_mile >= 0),
  loaded_miles numeric(10, 2) check (loaded_miles is null or loaded_miles >= 0),
  deadhead_miles numeric(10, 2) check (deadhead_miles is null or deadhead_miles >= 0),
  pay_cents integer check (pay_cents is null or pay_cents >= 0),
  fuel_cents integer check (fuel_cents is null or fuel_cents >= 0),
  detention_cents integer check (detention_cents is null or detention_cents >= 0),
  outcome text not null check (outcome in ('booked', 'skipped', 'cancelled', 'completed', 'disputed')),
  outcome_at timestamptz not null default now(),
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists bot_load_ledger_company_outcome_idx on bot_load_ledger (company_id, outcome_at desc);

-- Proposals: EVERYTHING a bot wants to do that anyone outside the app
-- would see, or that changes the business, lands here first as a
-- proposal. Nothing executes from a proposal row on its own — the
-- owner's decision (tap in Telegram, or the app) moves it to
-- approved/denied, and execution of an approved proposal is a Phase 1
-- build. An approval unanswered by its deadline counts as denied;
-- the sweeper marks stale proposed rows expired (no job exists yet —
-- expiry is enforced in code at read time until one does).
create table if not exists bot_proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  bot_slug text not null references bot_identities(slug) on delete cascade,
  kind text not null check (kind in ('load-draft', 'load-shortlist', 'message-draft', 'record-draft', 'call-plan', 'other')),
  title text not null check (char_length(title) between 1 and 240),
  payload jsonb not null default '{}'::jsonb,
  source_ref text check (source_ref is null or char_length(source_ref) <= 240),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'denied', 'expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text check (decided_by is null or char_length(decided_by) <= 120)
);
create index if not exists bot_proposals_company_open_idx on bot_proposals (company_id, created_at desc) where status = 'proposed';

-- Audit log: every proposal and every owner decision, plus every
-- blocked attempt (a bot trying an execute-class action without an
-- approved proposal). Append-only — no update/delete policy on
-- purpose; corrections are new rows.
create table if not exists bot_audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  bot_slug text not null references bot_identities(slug) on delete cascade,
  actor text not null check (actor in ('bot', 'owner', 'system')),
  action text not null check (char_length(action) between 1 and 80),
  target_ref text check (target_ref is null or char_length(target_ref) <= 240),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists bot_audit_log_company_idx on bot_audit_log (company_id, created_at desc);

-- The Telegram group room: one private group, him + the bots. Only
-- the allowlisted chat id (TELEGRAM_GROUP_CHAT_ID) is ever served;
-- every other group is ignored, exactly like the 1:1 bot ignores
-- every chat that is not the allowlisted owner chat.
create table if not exists bot_group_rooms (
  telegram_chat_id bigint primary key,
  company_id uuid not null references companies(id) on delete cascade,
  name text not null default 'bot team' check (char_length(name) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now()
);

-- Every message in the room, so the room is reconstructable and the
-- routing is auditable: who said it, who it was routed to, what was
-- said. `sender_kind` is 'owner' | 'bot'; `sender_ref` is the bot
-- slug or the owner's Telegram user id as text.
create table if not exists bot_group_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  telegram_chat_id bigint not null references bot_group_rooms(telegram_chat_id) on delete cascade,
  telegram_message_id bigint not null,
  sender_kind text not null check (sender_kind in ('owner', 'bot')),
  sender_ref text not null check (char_length(sender_ref) between 1 and 120),
  text text not null check (char_length(text) between 1 and 4000),
  routed_to_bot_slug text references bot_identities(slug) on delete set null,
  created_at timestamptz not null default now(),
  unique (telegram_chat_id, telegram_message_id, sender_kind)
);
create index if not exists bot_group_messages_room_idx on bot_group_messages (telegram_chat_id, created_at desc);

-- Spend ledger: one row per model call, estimated cost in cents.
-- Estimates, not bills — OpenAI bills the account; the ledger tracks
-- estimates (see src/services/bots/spend.ts) so the cap trips early.
-- When the month's estimated spend hits BOT_MONTHLY_SPEND_CAP_CENTS
-- (default $10), bot model calls stop and the bots say so plainly.
create table if not exists bot_spend_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  bot_slug text not null references bot_identities(slug) on delete cascade,
  model text not null check (char_length(model) between 1 and 120),
  tier text not null check (tier in ('scan', 'rank')),
  estimated_cents integer not null check (estimated_cents >= 0),
  created_at timestamptz not null default now()
);
create index if not exists bot_spend_ledger_company_month_idx on bot_spend_ledger (company_id, created_at desc);

alter table bot_identities enable row level security;
alter table bot_team_memories enable row level security;
alter table bot_load_ledger enable row level security;
alter table bot_proposals enable row level security;
alter table bot_audit_log enable row level security;
alter table bot_group_rooms enable row level security;
alter table bot_group_messages enable row level security;
alter table bot_spend_ledger enable row level security;

-- Company read for the app surfaces. Writes go through the
-- service-role client only (bots + webhook); there are deliberately no
-- authenticated insert/update/delete policies here.
create policy "bot_identities: company read" on bot_identities
  for select using (true);
create policy "bot_team_memories: company read" on bot_team_memories
  for select using (company_id = current_company_id());
create policy "bot_load_ledger: company read" on bot_load_ledger
  for select using (company_id = current_company_id());
create policy "bot_proposals: company read" on bot_proposals
  for select using (company_id = current_company_id());
create policy "bot_audit_log: company read" on bot_audit_log
  for select using (company_id = current_company_id());
create policy "bot_group_rooms: company read" on bot_group_rooms
  for select using (company_id = current_company_id());
create policy "bot_group_messages: company read" on bot_group_messages
  for select using (company_id = current_company_id());
create policy "bot_spend_ledger: company read" on bot_spend_ledger
  for select using (company_id = current_company_id());
