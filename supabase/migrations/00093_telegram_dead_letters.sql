-- 00093 - Telegram dead letters (Telegram review fix, owner order
-- 2026-11-12; defect D12).
--
-- APPLY BEFORE DEPLOY: the D12 code writes here whenever a message or
-- pending-burst persist fails after its one retry. Until this migration
-- is applied the dead-letter write itself fails (logged, never thrown)
-- and the owner still gets the one-line warning, but the failed record
-- has no durable copy - apply this first so nothing is only in memory.
--
-- telegram_dead_letters: the durable copy of a message or pending burst
-- the bot could not store in its normal table - kind, the payload
-- verbatim, and the error that stopped the write. A dead letter is
-- evidence for a human to re-file, not a queue the bot replays on its
-- own: replaying a stale burst could double-send. Additive,
-- tenant-isolated, soft-delete, no seed, like every bot table.

create table telegram_dead_letters (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  chat_id text,
  kind text not null check (kind in ('message', 'pending_burst')),
  -- The record verbatim: a message row {role, text, channel} or a
  -- pending burst {items, due_at}.
  payload jsonb not null default '{}'::jsonb,
  -- The error that stopped the normal write, in the database's words.
  error text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index telegram_dead_letters_company_created
  on telegram_dead_letters (company_id, created_at desc)
  where deleted_at is null;

alter table telegram_dead_letters enable row level security;

create policy "tenant isolation" on telegram_dead_letters
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
