-- Truck Fund + money visibility (docs/design/driver-mvp.md §9). Four
-- tables, same conventions as every other table: company_id +
-- tenant-isolation RLS, soft delete, created_at/updated_at. The app
-- only ever RECORDS money the owner moved himself - no table here
-- represents a transfer capability, because none exists (§9's law).

-- §9.1: one manual ledger for the owner's existing Finance Project
-- buckets (truck_fund = the transportation/car fund, business_credit,
-- emergency_fund). A fund's balance is computed on read from these
-- rows; nothing stores a balance.
create table fund_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  fund_key text not null,
  constraint fund_entries_fund_valid
    check (fund_key in ('truck_fund', 'business_credit', 'emergency_fund')),
  kind text not null,
  constraint fund_entries_kind_valid
    check (kind in ('deposit', 'withdrawal')),
  amount_cents integer not null,
  constraint fund_entries_amount_positive check (amount_cents > 0),
  entry_date date not null,
  lane text not null,
  constraint fund_entries_lane_valid
    check (lane in ('business', 'personal')),
  source text not null,
  constraint fund_entries_source_valid
    check (source in ('manual', 'sweep')),
  note text,
  load_id uuid references loads (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table fund_entries enable row level security;

create policy "tenant isolation" on fund_entries
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- §9.1: the per-company settings singleton - the sweep rule and the
-- Truck Fund target. sweep_mode defaults 'off': no rule exists until
-- the owner sets one, and no suggestion is computed without a rule.
create table fund_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  sweep_mode text not null default 'off',
  constraint fund_settings_sweep_mode_valid
    check (sweep_mode in ('off', 'percent', 'flat')),
  sweep_percent integer,
  constraint fund_settings_sweep_percent_valid
    check (sweep_percent is null or (sweep_percent >= 1 and sweep_percent <= 100)),
  sweep_flat_cents integer,
  constraint fund_settings_sweep_flat_valid
    check (sweep_flat_cents is null or sweep_flat_cents >= 0),
  target_band text,
  constraint fund_settings_target_band_valid
    check (target_band is null or target_band in ('budget', 'mid', 'upper')),
  target_cents integer,
  constraint fund_settings_target_positive
    check (target_cents is null or target_cents > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table fund_settings enable row level security;

create policy "tenant isolation" on fund_settings
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- §9.4: owner-tracked state for the business-finance ladder. Only
-- state lives here - the ladder's knowledge (order, titles, next
-- actions) is static in src/lib/truck-fund.ts.
create table business_ladder_steps (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  step_key text not null,
  constraint business_ladder_steps_key_valid
    check (step_key in ('ein', 'business_bank', 'duns', 'tradelines', 'paydex', 'real_credit')),
  state text not null default 'not_started',
  constraint business_ladder_steps_state_valid
    check (state in ('not_started', 'in_progress', 'done')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table business_ladder_steps enable row level security;

create policy "tenant isolation" on business_ladder_steps
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

-- §9.5: manual account snapshots - the v1 implementation behind the
-- account-visibility seam. A balance AS OF a date, entered by hand;
-- never a live balance or a sync. last4 is display-only (never a
-- full account number); balance may be negative (a card owed).
create table account_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  institution text not null,
  account_name text not null,
  last4 text not null,
  balance_cents integer not null,
  lane text not null,
  constraint account_snapshots_lane_valid
    check (lane in ('business', 'personal')),
  as_of_date date not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table account_snapshots enable row level security;

create policy "tenant isolation" on account_snapshots
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
