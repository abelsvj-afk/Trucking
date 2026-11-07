-- 00078 - Company inbox for Abel, RUNG 1 READ-ONLY (docs/design/company-inbox.md; owner direction 2026-11-07).
-- Abel reads the dispatch@ and owner@ INBOXes over IMAP (owner scope decision 2026-11-07: both, read-only) and stores what he reads; nothing here can send, delete or change mail.
--   email_messages     one row per message read (unique on the server Message-ID per company); body is plain text, untrusted
--   load_candidates    the canonical load candidate (build plan 2.3) extracted from a load offer - NOT a load
--   email_drafts       UNSENT reply drafts; the status column has no 'sent' value - the schema has no send state
--   email_poll_state   one row per company + mailbox (dispatch, owner): cursor, last good poll, last failure (the honest health state)
-- ADDITIVE, tenant-isolated (RLS), anon grants 0 by the 00067 defaults, composite (company_id, fk) FKs like 00070, no seed.

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  /** The server's Message-ID header (a stable hash of from+date+subject when it is missing). */
  message_id text not null check (length(btrim(message_id)) > 0),
  /** Which of the two company mailboxes received it. */
  mailbox text not null default 'dispatch'
    constraint email_messages_mailbox_valid check (mailbox in ('dispatch', 'owner')),
  uid bigint,
  uidvalidity bigint,
  from_address text,
  from_name text,
  reply_to text,
  to_addresses text,
  subject text,
  received_at timestamptz not null,
  body_text text,
  /** File names only - attachments are never downloaded or interpreted. */
  attachments jsonb not null default '[]'::jsonb,
  classification text not null default 'unclassified'
    constraint email_messages_classification_valid check (classification in ('load_offer', 'payment', 'facility', 'other', 'junk', 'unclassified')),
  summary text,
  /** When Abel told the owner about it in Telegram; null = not surfaced (junk waits for the digest). */
  surfaced_at timestamptz,
  digest_sent_at timestamptz,
  /** The pending proposal staged for this message (a load offer's draft-load proposal). No FK: proposals are transient. */
  linked_proposal_id uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint email_messages_message_unique unique (company_id, message_id),
  constraint email_messages_company_id_id_key unique (company_id, id)
);

create index email_messages_received_idx on email_messages (company_id, received_at desc) where deleted_at is null;
create index email_messages_unsurfaced_idx on email_messages (company_id, created_at) where deleted_at is null and surfaced_at is null;

create table load_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  email_message_id uuid,
  source text not null default 'email'
    constraint load_candidates_source_valid check (source in ('email', 'pasted', 'board')),
  /** The canonical candidate (build plan 2.3): broker, lane, windows, money as posted, requirements verbatim, provenance. */
  data jsonb not null,
  /** broker + lane + windows + rate - the same load from two sources is one candidate. */
  dedupe_key text not null check (length(btrim(dedupe_key)) > 0),
  status text not null default 'new'
    constraint load_candidates_status_valid check (status in ('new', 'proposed', 'taken', 'passed', 'expired')),
  first_seen_at timestamptz not null default now(),
  expires_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint load_candidates_dedupe_unique unique (company_id, dedupe_key),
  constraint load_candidates_company_id_id_key unique (company_id, id),
  constraint load_candidates_email_tenant_fkey
    foreign key (company_id, email_message_id) references email_messages (company_id, id)
);

create table email_drafts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  email_message_id uuid not null,
  /** Derived by code from the original message (Reply-To, else From) - never from model text. */
  to_address text not null check (length(btrim(to_address)) > 0),
  subject text not null,
  body text not null check (length(btrim(body)) > 0),
  /** There is deliberately NO 'sent' status: rung 1 cannot send. */
  status text not null default 'draft'
    constraint email_drafts_status_valid check (status in ('draft', 'discarded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint email_drafts_message_tenant_fkey
    foreign key (company_id, email_message_id) references email_messages (company_id, id)
);

create index email_drafts_message_idx on email_drafts (company_id, email_message_id) where deleted_at is null;

create table email_poll_state (
  company_id uuid not null references companies (id),
  /** One cursor / health row per mailbox - a failing box never takes the other down. */
  mailbox text not null default 'dispatch'
    constraint email_poll_state_mailbox_valid check (mailbox in ('dispatch', 'owner')),
  uidvalidity bigint,
  last_uid bigint,
  last_attempt_at timestamptz,
  last_ok_at timestamptz,
  last_error_kind text
    constraint email_poll_state_error_kind_valid check (last_error_kind is null or last_error_kind in ('auth', 'network', 'tls', 'other')),
  last_error_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  /** What Abel last told the owner about the connection ('ok' | 'auth' | 'network' | 'tls' | 'other') - so a failure is announced once. */
  last_notified_state text,
  last_digest_date date,
  updated_at timestamptz not null default now(),
  primary key (company_id, mailbox)
);

alter table email_messages enable row level security;
alter table load_candidates enable row level security;
alter table email_drafts enable row level security;
alter table email_poll_state enable row level security;

create policy "tenant isolation" on email_messages
  for all using (company_id = private.current_company_id()) with check (company_id = private.current_company_id());
create policy "tenant isolation" on load_candidates
  for all using (company_id = private.current_company_id()) with check (company_id = private.current_company_id());
create policy "tenant isolation" on email_drafts
  for all using (company_id = private.current_company_id()) with check (company_id = private.current_company_id());
create policy "tenant isolation" on email_poll_state
  for all using (company_id = private.current_company_id()) with check (company_id = private.current_company_id());
