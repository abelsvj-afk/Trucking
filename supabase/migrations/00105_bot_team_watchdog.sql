-- Compliance Watchdog (Phase 2; plan docs/bot-team-build-plan.md).
-- The deadline checklist the Watchdog keeps current: one row per
-- deadline kind + subject (driver / truck). Plus the registry scope
-- correction for the Watchdog's identity, to match its governing file
-- (docs/bots/compliance-watchdog/CLAUDE.md): documents READ + WRITE
-- (file, never approve), email WRITE-GATED as "draft" (reminders are
-- drafts; sending is an execute-class proposal), Maps NO ACCESS.
--
-- This migration is AUTHORED, NOT applied. The live apply is the
-- owner's tap, via King's lane, before any deploy that reads it.
-- Nothing earlier is edited (migrations are frozen once applied).
--
-- Money is integer cents everywhere (no money in this table).
-- Every table is RLS by company_id. Bots write through the
-- service-role client (the documented webhook exception, same as the
-- Telegram bot); the app reads through RLS. No authenticated
-- insert/update policies: nothing in this schema is ever written
-- from a user session.

create table if not exists bot_compliance_deadlines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  kind text not null check (kind in (
    'medical_card', 'cdl', 'mvr', 'clearinghouse_query',
    'drug_test_pool', 'ucr', 'irp', 'mcs_150',
    'annual_inspection', 'dvir_defect'
  )),
  subject_ref text check (subject_ref is null or char_length(subject_ref) between 1 and 120),
  due_date date,
  status text not null default 'unknown' check (status in ('filed', 'missing', 'unknown')),
  source text check (source is null or char_length(source) between 1 and 120),
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One writer per kind + subject: the code upsert reads then writes;
-- this index is the backstop that keeps two rows from existing.
create unique index if not exists bot_compliance_deadlines_company_kind_subject_idx
  on bot_compliance_deadlines (company_id, kind, coalesce(subject_ref, ''));
create index if not exists bot_compliance_deadlines_company_due_idx
  on bot_compliance_deadlines (company_id, due_date);

alter table bot_compliance_deadlines enable row level security;

create policy "bot_compliance_deadlines: company read" on bot_compliance_deadlines
  for select using (company_id = current_company_id());

-- Registry scope correction for the Watchdog (baseline 00103 seeded
-- documents "read", email "none", maps "read" — the governing file
-- says documents READ + WRITE, email WRITE-GATED, maps NO ACCESS).
update bot_identities
  set tool_scope = '{"loads": "read", "hos": "read", "money": "none", "documents": "read-write", "email": "draft", "maps": "none", "app-actions": "flag", "calls": "never", "signature": "never"}'::jsonb
  where slug = 'compliance-watchdog';
