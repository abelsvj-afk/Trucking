-- 00083 - Durable Telegram bursts + the conversation thread's entity index
-- (Telegram fix round, owner order 2026-11-09; brief fixes 7-11A + ChatGPT
-- audit T-002).
--
-- telegram_pending_bursts: the burst collector used to live only in process
-- memory, so a Fly restart between Telegram's HTTP 200 and the bundle flush
-- lost acknowledged messages forever, and two machines could split one
-- forwarded conversation. One row per (company, chat): the pending bundle's
-- items as jsonb, when it is due to flush, and a claim stamp so exactly one
-- processor flushes it. Written best-effort by the bot: a missing table or a
-- failed write degrades to the old in-memory behavior, never a lost turn.
--
-- bot_thread_entities: Abel's live context is only the last ~20 turns plus
-- keyword-picked memories, so "trip 1874" stopped resolving as the
-- conversation scrolled. This is the durable index of every record a
-- conversation thread has touched - each load by trip number AND broker
-- reference AND lane, each document by file name AND the identifiers read
-- from it (trailer #, pickup #, seal #), each truck/trailer by unit number -
-- plus the thread's current subject (the record "this load" means). Rows are
-- keyed by the keys the owner actually says; resolution consults this index
-- first, then the wider database. Additive, tenant-isolated, soft-delete,
-- no seed, like every bot table.

create table telegram_pending_bursts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  chat_id text not null,
  -- The bundle's items verbatim (text items and media descriptors), in arrival order.
  items jsonb not null default '[]'::jsonb,
  -- When the bundle should flush (quiet window / max-wait computed by the collector).
  due_at timestamptz not null,
  -- Set while a processor is flushing this bundle; a stale claim may be taken over.
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index telegram_pending_bursts_one_open_per_chat
  on telegram_pending_bursts (company_id, chat_id)
  where deleted_at is null;

create index telegram_pending_bursts_due
  on telegram_pending_bursts (due_at)
  where deleted_at is null;

alter table telegram_pending_bursts enable row level security;

create policy "tenant isolation" on telegram_pending_bursts
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create table bot_thread_entities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  channel text not null default 'telegram',
  chat_id text not null,
  entity_type text not null check (entity_type in ('load', 'document', 'truck', 'trailer', 'driver')),
  -- Null while the record is only staged (a trip waiting for his yes); filled when the record exists.
  entity_id uuid,
  -- Every way the owner might name this record: [{kind, value}] with kind in
  -- trip_number | broker_reference | unit_number | file_name | pickup_number |
  -- trailer_number | seal_number | lane. Values stored as said (matching is
  -- case-insensitive in code).
  keys jsonb not null default '[]'::jsonb,
  -- The record in words, as the owner would say it ("Trip 1874, Panama City, FL -> Seminole, OK").
  label text not null check (length(btrim(label)) > 0),
  -- The thread's current subject: what "this load" / "that trip" resolves to.
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index bot_thread_entities_thread
  on bot_thread_entities (company_id, chat_id, last_seen_at desc)
  where deleted_at is null;

create unique index bot_thread_entities_one_current_per_thread
  on bot_thread_entities (company_id, chat_id)
  where is_current and deleted_at is null;

alter table bot_thread_entities enable row level security;

create policy "tenant isolation" on bot_thread_entities
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
