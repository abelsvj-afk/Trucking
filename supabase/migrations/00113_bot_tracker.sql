-- Tracker bot (Phase 2; plan docs/bot-team-build-plan.md).
-- The check-call log, the detention clocks, the POD/BOL packet state,
-- and the team-room handoff queue (bot_handoffs — the durable,
-- claimable work queue bots hand each other; with Bot-to-Bot
-- Communication Mode on, the target bot also receives the room post,
-- and without the mode this row is the only path).
--
-- This migration is AUTHORED, NOT applied. The live apply is the
-- owner's tap, via King's lane, before any deploy that reads it.
-- Nothing earlier is edited (migrations are frozen once applied).

-- Tracker identity: tool scope corrected to its governing file
-- (docs/bots/tracker/CLAUDE.md). Status stays 'planned' until the
-- seat goes live — the code is built, the deploy is a separate tap.
update bot_identities
set tool_scope = '{"loads": "read-write", "hos": "read", "money": "none", "documents": "read-write", "email": "read-write", "maps": "read", "app-actions": "read-write", "calls": "gated", "signature": "never"}'::jsonb
where slug = 'tracker';

-- Check-call log: one row per check call the owner reports or Tracker
-- confirms (picked up, en route, delivered, arrived, departed).
-- load_ref is null when the message named no load — the text is the
-- record. This is Tracker's episodic memory: what happened, where,
-- when, per load.
create table if not exists bot_check_calls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  load_ref text check (load_ref is null or char_length(load_ref) between 1 and 120),
  kind text not null check (kind in ('arrived', 'picked_up', 'en_route', 'delivered', 'departed')),
  place text check (place is null or char_length(place) between 1 and 120),
  note text check (note is null or char_length(note) <= 2000),
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists bot_check_calls_company_idx on bot_check_calls (company_id, created_at desc);

-- Detention clocks: one row per stop where Tracker started the clock.
-- started_at is arrival (or appointment, whichever is later) + free
-- time; ended_at null while the truck is still waiting. Free time is
-- 2 hours, the same rule as Abel's detention.ts — the code computes
-- started_at, the table only stores it.
create table if not exists bot_detention_clocks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  load_ref text check (load_ref is null or char_length(load_ref) between 1 and 120),
  stop_label text not null check (char_length(stop_label) between 1 and 120),
  arrived_at timestamptz not null,
  appointment_at timestamptz,
  free_minutes integer not null check (free_minutes >= 0),
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists bot_detention_clocks_company_open_idx on bot_detention_clocks (company_id, created_at desc) where ended_at is null;

-- POD/BOL packet state: one row per load (null load_ref = the current
-- load, one truck). bol_received / pod_received flip as the paperwork
-- lands; the packet is complete when both are true.
create table if not exists bot_doc_packets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  load_ref text check (load_ref is null or char_length(load_ref) between 1 and 120),
  bol_received boolean not null default false,
  pod_received boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists bot_doc_packets_company_idx on bot_doc_packets (company_id, updated_at desc);

-- Team-room handoff queue: work one bot hands another. With
-- Bot-to-Bot Communication Mode on (BotFather, per bot), the target
-- bot also receives the room post itself; without the mode, a handoff
-- is a ROW the target bot claims — the room post is only its visible
-- face either way. status: open -> claimed -> done. Only the named
-- bot may claim, only while open (enforced in code; the claim update
-- is conditional on status = 'open'). idempotency_key dedupes a
-- redelivered trigger. depth caps handoff chains at 3
-- (MAX_HANDOFF_DEPTH in src/services/bots/tracker.ts) — a chain past
-- the cap escalates to Abel instead of handing off again.
create table if not exists bot_handoffs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  from_bot text not null references bot_identities(slug) on delete cascade,
  to_bot text not null references bot_identities(slug) on delete cascade,
  title text not null check (char_length(title) between 1 and 240),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'claimed', 'done')),
  parent_id uuid references bot_handoffs(id) on delete set null,
  depth integer not null default 0 check (depth between 0 and 3),
  idempotency_key text not null,
  claimed_by text references bot_identities(slug) on delete set null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz,
  unique (company_id, idempotency_key)
);
create index if not exists bot_handoffs_company_open_idx on bot_handoffs (company_id, to_bot, created_at asc) where status = 'open';

alter table bot_check_calls enable row level security;
alter table bot_detention_clocks enable row level security;
alter table bot_doc_packets enable row level security;
alter table bot_handoffs enable row level security;

-- Company read for the app surfaces. Writes go through the
-- service-role client only (bots + webhook); there are deliberately no
-- authenticated insert/update/delete policies here.
create policy "bot_check_calls: company read" on bot_check_calls
  for select using (company_id = private.current_company_id());
create policy "bot_detention_clocks: company read" on bot_detention_clocks
  for select using (company_id = private.current_company_id());
create policy "bot_doc_packets: company read" on bot_doc_packets
  for select using (company_id = private.current_company_id());
create policy "bot_handoffs: company read" on bot_handoffs
  for select using (company_id = private.current_company_id());
