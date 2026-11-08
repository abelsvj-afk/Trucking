-- 00082 - Abel email SENDING (owner decision 2026-11-07; docs/design/abel-email-access.md addendum). owner@ sends are active and dispatch@
-- is gated off in code (EMAIL_SEND_DISPATCH_ENABLED). 00078-00081 are applied and frozen; this is additive:
--   email_drafts.status   widens from (draft, discarded) to (draft, discarded, sending, sent, failed); 'sending' is the atomic claim that stops a double yes sending twice; new columns record the attempt.
--   email_sent            one row per message actually sent: mailbox, recipient, subject, body, our Message-ID, what it replies to,
--                         the SHA-256 of the exact body the owner approved, and whether the Sent-folder copy was stored.
-- Tenant-isolated (RLS), composite (company_id, fk) FK like 00070, anon grants 0 by the 00067 defaults. No seed.

alter table email_drafts drop constraint email_drafts_status_valid;
alter table email_drafts add constraint email_drafts_status_valid check (status in ('draft', 'discarded', 'sending', 'sent', 'failed'));
alter table email_drafts add column send_attempted_at timestamptz;
alter table email_drafts add column send_error text;
alter table email_drafts add column sent_at timestamptz;

create table email_sent (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  /** Which mailbox it was sent FROM. */
  mailbox text not null constraint email_sent_mailbox_valid check (mailbox in ('dispatch', 'owner')),
  /** The inbox message this replies to; the thread anchor. */
  email_message_id uuid not null,
  draft_id uuid,
  to_address text not null check (length(btrim(to_address)) > 0),
  subject text not null,
  body text not null check (length(btrim(body)) > 0),
  /** The Message-ID we gave the outgoing message. */
  message_id text not null check (length(btrim(message_id)) > 0),
  in_reply_to text,
  /** SHA-256 (hex) of the exact body text the owner approved - the audit link between his yes and what left. */
  approved_body_hash text not null check (length(approved_body_hash) = 64),
  sent_at timestamptz not null default now(),
  /** False when the IMAP APPEND to the Sent folder failed (the DB record still stands). */
  stored_in_sent_folder boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint email_sent_message_unique unique (company_id, message_id),
  constraint email_sent_company_id_id_key unique (company_id, id),
  constraint email_sent_message_tenant_fkey
    foreign key (company_id, email_message_id) references email_messages (company_id, id)
);

create index email_sent_recent_idx on email_sent (company_id, sent_at desc) where deleted_at is null;

alter table email_sent enable row level security;
create policy "tenant isolation" on email_sent
  for all using (company_id = private.current_company_id()) with check (company_id = private.current_company_id());
