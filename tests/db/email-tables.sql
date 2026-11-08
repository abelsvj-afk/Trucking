-- Company inbox tables (migration 00078; docs/design/company-inbox.md): constraints and tenant isolation, with
-- assertions that RAISE on any violation. One transaction, rolls back, leaves nothing. Run after the scratch setup
-- (stub -> scratch-supabase-defaults -> all migrations -> scratch-auth-shim):
--   psql -d scratch -f tests/db/scratch-auth-shim.sql -f tests/db/email-tables.sql
-- The generic rls-isolation.sql proves the cross-company INSERT refusals for every tenant table; this file ALSO proves
-- read / update / delete isolation on the inbox tables directly (their composite FKs keep the generic seeder from
-- building a company-B row), plus the properties that matter for a read-only inbox.
begin;
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  ma uuid; mb uuid; n bigint; refused boolean;
begin
  insert into companies (id, name) values (a, 'A'), (b, 'B');
  insert into auth.users (id) values (ua), (ub) on conflict do nothing;
  insert into user_profiles (id, company_id, role) values (ua, a, 'owner'), (ub, b, 'owner');

  insert into email_messages (company_id, message_id, subject, received_at) values (a, '<a1@x>', 'A mail', now()) returning id into ma;
  insert into email_messages (company_id, message_id, subject, received_at) values (b, '<b1@x>', 'B mail', now()) returning id into mb;
  insert into load_candidates (company_id, email_message_id, data, dedupe_key) values (a, ma, '{}', 'k-a'), (b, mb, '{}', 'k-b');
  insert into email_drafts (company_id, email_message_id, to_address, subject, body) values (a, ma, 'x@y.z', 'Re', 'body'), (b, mb, 'x@y.z', 'Re', 'body');
  insert into email_poll_state (company_id, mailbox) values (a, 'dispatch'), (a, 'owner'), (b, 'dispatch');

  -- ---- constraints (each must be REFUSED) ----
  begin insert into email_messages (company_id, message_id, received_at) values (a, '<a1@x>', now()); raise exception 'FAIL: duplicate Message-ID accepted';
  exception when unique_violation then raise notice 'ok: the same Message-ID is stored once per company'; end;
  insert into email_messages (company_id, message_id, received_at) values (b, '<a1@x>', now()); -- the same ID in ANOTHER company is fine
  begin insert into email_messages (company_id, message_id, received_at, classification) values (a, '<c@x>', now(), 'spam'); raise exception 'FAIL: bad classification accepted';
  exception when check_violation then raise notice 'ok: classification is a closed set'; end;
  -- 00082 (email sending): 'sent' and 'failed' now exist; anything else is still refused
  begin insert into email_drafts (company_id, email_message_id, to_address, subject, body, status) values (a, ma, 'x@y.z', 's', 'b', 'posted'); raise exception 'FAIL: an unknown draft status exists';
  exception when check_violation then raise notice 'ok: draft status is a closed set (draft, discarded, sending, sent, failed)'; end;
  insert into email_drafts (company_id, email_message_id, to_address, subject, body, status) values (a, ma, 'x@y.z', 's', 'b', 'sent');
  begin insert into email_sent (company_id, mailbox, email_message_id, to_address, subject, body, message_id, approved_body_hash) values (a, 'gmail', ma, 'x@y.z', 's', 'b', '<m1@x>', repeat('a', 64)); raise exception 'FAIL: unknown sending mailbox';
  exception when check_violation then raise notice 'ok: a message is sent from the dispatch or owner mailbox only'; end;
  begin insert into email_sent (company_id, mailbox, email_message_id, to_address, subject, body, message_id, approved_body_hash) values (a, 'owner', ma, 'x@y.z', 's', 'b', '<m1@x>', 'short'); raise exception 'FAIL: a sent row without a full approval hash';
  exception when check_violation then raise notice 'ok: every sent message carries the SHA-256 of the body the owner approved'; end;
  begin insert into email_sent (company_id, mailbox, email_message_id, to_address, subject, body, message_id, approved_body_hash) values (a, 'owner', mb, 'x@y.z', 's', 'b', '<m2@x>', repeat('a', 64)); raise exception 'FAIL: a sent row pointed at another company''s message';
  exception when foreign_key_violation then raise notice 'ok: a sent message cannot reference another company''s message (composite FK)'; end;
  insert into email_sent (company_id, mailbox, email_message_id, to_address, subject, body, message_id, approved_body_hash) values (a, 'owner', ma, 'x@y.z', 's', 'b', '<m1@x>', repeat('a', 64)), (b, 'owner', mb, 'x@y.z', 's', 'b', '<m1@x>', repeat('b', 64));
  begin insert into email_sent (company_id, mailbox, email_message_id, to_address, subject, body, message_id, approved_body_hash) values (a, 'owner', ma, 'x@y.z', 's', 'b', '<m1@x>', repeat('a', 64)); raise exception 'FAIL: the same Message-ID sent twice';
  exception when unique_violation then raise notice 'ok: one sent row per outgoing Message-ID'; end;
  begin insert into email_drafts (company_id, email_message_id, to_address, subject, body) values (a, mb, 'x@y.z', 's', 'b'); raise exception 'FAIL: a draft pointed at another company''s message';
  exception when foreign_key_violation then raise notice 'ok: a draft cannot reference another company''s message (composite FK)'; end;
  begin insert into load_candidates (company_id, email_message_id, data, dedupe_key) values (a, mb, '{}', 'k2'); raise exception 'FAIL: candidate pointed at another company''s message';
  exception when foreign_key_violation then raise notice 'ok: a load candidate cannot reference another company''s message (composite FK)'; end;
  begin insert into load_candidates (company_id, data, dedupe_key) values (a, '{}', 'k-a'); raise exception 'FAIL: duplicate candidate accepted';
  exception when unique_violation then raise notice 'ok: the same load from two sources is one candidate (dedupe key)'; end;
  begin insert into load_candidates (company_id, data, dedupe_key, status) values (a, '{}', 'k3', 'booked'); raise exception 'FAIL: a candidate can be "booked"';
  exception when check_violation then raise notice 'ok: a candidate is never a booked load'; end;
  begin insert into email_poll_state (company_id, mailbox) values (a, 'dispatch'); raise exception 'FAIL: two poll rows for one mailbox';
  exception when unique_violation then raise notice 'ok: one poll cursor per company and mailbox'; end;
  begin insert into email_poll_state (company_id, mailbox) values (a, 'gmail'); raise exception 'FAIL: unknown mailbox accepted';
  exception when check_violation then raise notice 'ok: only the dispatch and owner mailboxes exist'; end;
  begin insert into email_messages (company_id, message_id, received_at, mailbox) values (a, '<m@x>', now(), 'ceo'); raise exception 'FAIL: unknown mailbox on a message';
  exception when check_violation then raise notice 'ok: a message belongs to the dispatch or owner mailbox'; end;
  begin insert into email_poll_state (company_id, last_error_kind) values (gen_random_uuid(), 'x'); raise exception 'FAIL';
  exception when others then raise notice 'ok: poll state refuses a bad error kind / unknown company'; end;

  -- ---- isolation: company A's user ----
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', ua::text, true);
  select count(*) into n from email_messages where company_id = b; if n <> 0 then raise exception 'FAIL: A read % of B''s messages', n; end if;
  select count(*) into n from load_candidates where company_id = b; if n <> 0 then raise exception 'FAIL: A read B''s candidates'; end if;
  select count(*) into n from email_drafts where company_id = b; if n <> 0 then raise exception 'FAIL: A read B''s drafts'; end if;
  select count(*) into n from email_poll_state where company_id = b; if n <> 0 then raise exception 'FAIL: A read B''s poll state'; end if;
  select count(*) into n from email_sent where company_id = b; if n <> 0 then raise exception 'FAIL: A read B''s sent mail'; end if;
  select count(*) into n from email_messages; if n <> 1 then raise exception 'FAIL: A sees % messages, expected only its own 1', n; end if;
  update email_messages set subject = 'hacked' where id = mb; get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: A updated B''s message'; end if;
  delete from email_messages where id = mb; get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: A deleted B''s message'; end if;
  delete from email_drafts where company_id = b; get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: A deleted B''s drafts'; end if;
  begin insert into email_messages (company_id, message_id, received_at) values (b, '<evil@x>', now()); raise exception 'FAIL: A inserted into B';
  exception when insufficient_privilege then raise notice 'ok: A cannot insert into B (RLS)'; end;
  raise notice 'ok: company A cannot read, update or delete company B''s inbox rows';

  -- ---- anon ----
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  refused := false;
  begin insert into email_messages (company_id, message_id, received_at) values (a, '<anon@x>', now());
  exception when others then refused := true; end;
  if not refused then raise exception 'FAIL: anon wrote an email message'; end if;
  begin select count(*) into n from email_messages; if n <> 0 then raise exception 'FAIL: anon read % messages', n; end if;
  exception when insufficient_privilege then n := 0; end;
  raise notice 'ok: anon can neither write nor read the inbox tables';
  execute 'reset role';
end $$;
rollback;
