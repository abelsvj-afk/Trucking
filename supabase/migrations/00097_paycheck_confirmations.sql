-- 00097 - Paycheck confirmations (owner 2026-11-16; design docs/design/confirm-paycheck.md).
--
-- "I've already got my paychecks, yet they still show unconfirmed in the app." A paycheck
-- counted as received only when a settlement statement with per-load pay lines was recorded,
-- and nothing offered that. This is his word for what landed: one row per paycheck (one
-- payday's pay week), the take-home deposit, and optionally the statement he attached.
--
-- Not required before deploy: until applied, the paycheck picture reads exactly as before and
-- the confirm action says the database update is not applied yet.
-- Additive, tenant-isolated, soft-delete (Undo), no seed.

create table paycheck_confirmations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  -- The pay week this paycheck covers (calendar days, never through a time zone).
  period_start date not null,
  period_end date not null,
  payday date,
  -- What hit his bank, in cents.
  received_cents integer not null check (received_cents >= 0),
  statement_document_id uuid references documents (id),
  source text not null default 'app' check (source in ('app', 'abel')),
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint paycheck_confirmations_period check (period_end >= period_start)
);

-- One live confirmation per paycheck; confirming again soft-deletes the old one first.
create unique index paycheck_confirmations_one_live
  on paycheck_confirmations (company_id, period_start)
  where deleted_at is null;

alter table paycheck_confirmations enable row level security;

create policy "tenant isolation" on paycheck_confirmations
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
