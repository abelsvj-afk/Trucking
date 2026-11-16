-- 00098 - Abel's daily check-in (owner 2026-11-16: "Morning and evening"; design
-- docs/design/abel-do-what-i-ask.md section 6). The check-in is sent at most once per
-- kind per day through the same once-only claim as the logging reminders, so
-- reminder_sends must accept kind 'checkin'.
--
-- Not required before deploy: until applied, the claim insert is refused, the
-- scheduler treats that as "cannot verify not-yet-sent" and sends no check-in
-- (the hours reminders are unaffected - they claim their own kinds).

alter table reminder_sends drop constraint if exists reminder_sends_kind_check;
alter table reminder_sends
  add constraint reminder_sends_kind_check check (kind in ('hos', 'stale_status', 'checkin'));
