-- Fresh-Eyes Gap Register (2026-11-02) — Cluster D: GAP-12
-- receivables. "Completed" is not "paid": a load ends at completed
-- and its rate counts as revenue, with no invoice date, due date,
-- or paid amount anywhere. load_invoices is the receivable
-- lifecycle (invoiced -> due -> paid / late, with aging), proposed
-- from the load's own facts at closeout (GAP-05) and aged against
-- the broker's terms (GAP-14). Dormant while he's lease-on — the
-- schema exists before the month he branches off, not during it.
-- Factoring, if ever elected, records fee + reserve per invoice so
-- its true cost is a number.

create table load_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  load_id uuid not null references loads (id),
  broker_id uuid references brokers (id),
  invoice_date date not null,
  due_date date not null,
  amount_cents integer not null,
  paid_amount_cents integer not null default 0,
  paid_on date,
  factored boolean not null default false,
  factor_fee_cents integer,
  factor_reserve_cents integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One LIVE invoice per load (soft-deleted rows don't block a
-- corrected re-issue).
create unique index load_invoices_one_live_per_load
  on load_invoices (load_id) where deleted_at is null;

create index load_invoices_company_due_idx on load_invoices (company_id, due_date);

alter table load_invoices enable row level security;

create policy "tenant isolation" on load_invoices
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());
