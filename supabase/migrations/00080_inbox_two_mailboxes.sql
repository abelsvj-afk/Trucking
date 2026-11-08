-- 00080 - Company inbox: the two-mailbox delta (owner scope decision 2026-11-07: Abel reads BOTH dispatch@ and owner@,
-- read-only; docs/design/abel-email-access.md). 00078 was APPLIED live as the dispatch@-only draft and is frozen; this
-- migration takes that applied schema to the final form, additively:
--   email_messages.mailbox       already exists (default 'dispatch'); add the closed-set check.
--   email_poll_state.mailbox     new column (existing row = the dispatch@ cursor, so default 'dispatch'), closed-set check.
--   email_poll_state primary key (company_id)  ->  (company_id, mailbox): one cursor and one health row per mailbox.
-- No data is rewritten except the new column's default for the existing row. Pre-flight: any email_messages row whose mailbox is not
-- 'dispatch'/'owner' aborts the migration (none can exist - the draft only ever wrote the default).

do $$
declare n bigint;
begin
  select count(*) into n from email_messages where mailbox not in ('dispatch', 'owner');
  if n > 0 then raise exception '00080 aborted: % email_messages row(s) have a mailbox outside (dispatch, owner)', n; end if;
end $$;

alter table email_messages
  add constraint email_messages_mailbox_valid check (mailbox in ('dispatch', 'owner'));

alter table email_poll_state
  add column mailbox text not null default 'dispatch'
    constraint email_poll_state_mailbox_valid check (mailbox in ('dispatch', 'owner'));

alter table email_poll_state drop constraint email_poll_state_pkey;
alter table email_poll_state add primary key (company_id, mailbox);
