-- Fresh-Eyes Gap Register (2026-11-02) — Cluster D: GAP-13
-- recurring obligations / cash calendar. Money arrives in lumps
-- (settlements) and leaves on schedules; today expenses are
-- one-off rows with no recurrence anywhere, so every collision is
-- a surprise. recurring_obligations is the small register the
-- 30-day projection (src/lib/obligations.ts) runs against.

create table recurring_obligations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  amount_cents integer not null,
  cadence text not null
    constraint recurring_obligations_cadence_valid check (
      cadence in ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual')
    ),
  -- monthly/quarterly/annual: day of month (1-31, clamped to the
  -- month's length by the projection). weekly/biweekly: weekday
  -- (0 = Sunday .. 6 = Saturday, America/New_York).
  day_of_month integer,
  weekday integer,
  -- Anchor for biweekly cadence (a known occurrence date).
  anchor_date date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index recurring_obligations_company_idx on recurring_obligations (company_id);

alter table recurring_obligations enable row level security;

create policy "tenant isolation" on recurring_obligations
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());
