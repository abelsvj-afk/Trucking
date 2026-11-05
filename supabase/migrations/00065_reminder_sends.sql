-- 00065 - Proactive logging reminders (docs/design/logging-reminders.md).
-- One row per reminder actually sent, so a reminder is never sent twice
-- (the unique key is the dedupe: insert first, send second, delete if the
-- send fails). Holds no content beyond the key and its kind.

create table reminder_sends (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  dedupe_key text not null,
  kind text not null check (kind in ('hos', 'stale_status')),
  sent_at timestamptz not null default now(),
  unique (company_id, dedupe_key)
);

alter table reminder_sends enable row level security;

create policy "tenant isolation" on reminder_sends
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
