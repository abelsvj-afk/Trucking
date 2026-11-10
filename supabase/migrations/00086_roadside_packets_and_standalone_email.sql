-- 00086 - Roadside inspection mode (owner spec 2026-11-09; docs/design/eld-roadside-overlay.md).
-- 00001-00083 are applied and frozen; 00084 (research) and 00085 (expense) are authored on their
-- branches and NOT applied; this file is authored on feature/eld-roadside-overlay-2026-11-09 and
-- is NOT applied by the build. Two additive changes:
--   1. Standalone email sends. The email machinery (00078/00082) sends REPLIES: a draft's
--      email_message_id is NOT NULL and the mailbox is derived from the original message. A
--      roadside send is a NEW email to an officer, so both anchor columns become nullable (the
--      composite tenant FKs are MATCH SIMPLE and pass on NULL, unchanged otherwise) and a
--      standalone draft records its mailbox explicitly on a new nullable column. Reply drafts
--      leave mailbox NULL and keep deriving it from the original, exactly as today.
--   2. roadside_packets: one row per inspection packet Abel/the app assembles - the period it
--      covers, the exact packet text (the audit copy of what an officer was shown/sent), the
--      documents row it was filed as, and where it went (officer email + the email_sent row,
--      and/or the owner's Telegram).
-- Tenant-isolated (RLS), anon grants 0 by the 00067 defaults. No seed.

alter table email_drafts alter column email_message_id drop not null;
alter table email_drafts add column mailbox text
  constraint email_drafts_mailbox_valid check (mailbox in ('dispatch', 'owner'));

alter table email_sent alter column email_message_id drop not null;

create table roadside_packets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  -- The documents row this packet was filed as (documents also links back via
  -- related_entity_type = 'roadside_packet', related_entity_id = this id).
  document_id uuid,
  -- The roadside look-back the packet covers (America/New_York calendar days, inclusive).
  period_start date not null,
  period_end date not null,
  -- The exact packet text assembled from the one HOS read. This is what was shown/sent.
  body text not null check (length(btrim(body)) > 0),
  -- Where it went (either, both, or neither yet).
  sent_to text,
  email_sent_id uuid,
  sent_at timestamptz,
  telegram_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint roadside_packets_company_id_id_key unique (company_id, id),
  constraint roadside_packets_period_order check (period_end >= period_start)
);

create index roadside_packets_recent_idx on roadside_packets (company_id, created_at desc) where deleted_at is null;

alter table roadside_packets enable row level security;
create policy "tenant isolation" on roadside_packets
  for all using (company_id = private.current_company_id()) with check (company_id = private.current_company_id());
