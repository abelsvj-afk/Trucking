-- Fresh-Eyes Gap Register (2026-11-02) — Cluster D: GAP-14
-- broker working memory. Brokers are address-book entries; the
-- scorecard (src/lib/broker-scorecard.ts) fills itself from loads,
-- invoices (GAP-12), detention (GAP-04), and dispatch exchanges —
-- but exchanges today carry no broker/load link, so no per-broker
-- history can be computed at all. This migration adds the links,
-- the broker's payment terms (which GAP-12 ages against) and
-- setup requirements, and dated follow-ups Abel can nudge about
-- in the day-wrap (GAP-08).

alter table brokers
  add column payment_terms_days integer,
  add column setup_notes text;

alter table dispatch_exchanges
  add column broker_id uuid references brokers (id),
  add column load_id uuid references loads (id);

create table broker_followups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  broker_id uuid not null references brokers (id),
  note text not null,
  due_on date not null,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index broker_followups_company_due_idx on broker_followups (company_id, due_on);

alter table broker_followups enable row level security;

create policy "tenant isolation" on broker_followups
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());
