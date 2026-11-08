-- 00079 - Cash advances against a payday (docs/design/employer-pay-profile.md
-- section 9; owner order 2026-11-07). An advance is money a worker took out
-- of a pay period BEFORE payday; it is recorded when taken so every pay
-- figure can net against it (expected - advances = what should land).
--
-- Per-worker, per-pay-period data, employer-agnostic: driver_id names the
-- worker who took it (null = not assigned to a driver row), and the pay
-- week / payday an advance deducts from is derived at read time from its
-- advance_date and the pay terms in force on that date - the same rule
-- that groups finished loads into pay weeks. Nothing about any employer
-- or person is hardcoded or seeded here.
--
-- amount_cents is POSITIVE by design (the fund_entries convention): the
-- deduction sign comes from what an advance is, so a "negative advance"
-- can never be recorded by accident.
--
-- This is NOT settlement_lines: a settlement line (kind 'advance')
-- records what a statement DID deduct and needs a settlement row. This
-- table records the advance when it is taken, before any statement.
--
-- Anon writes: migration 00067 set the default privileges so tables
-- created later hold no anon INSERT/UPDATE/DELETE - this table inherits
-- that; RLS below is the tenant barrier, as on every table.

create table cash_advances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  driver_id uuid references drivers (id),
  amount_cents integer not null check (amount_cents > 0),
  advance_date date not null,
  note text,
  submission_id uuid,
  submission_payload_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index cash_advances_submission_idempotency
  on cash_advances (company_id, submission_id) where submission_id is not null;

create index cash_advances_company_date_idx
  on cash_advances (company_id, advance_date desc)
  where deleted_at is null;

alter table cash_advances enable row level security;

create policy "tenant isolation" on cash_advances
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
