-- Abel Intelligence Upgrade, Phase D — pay truth (design
-- docs: Trucking-Abel-Intelligence-Upgrade-Design-2026-11-02 §5).
-- Numbered 00044 deliberately: main tops out at 00040 (Research),
-- 00041-00043 are taken by the parallel image/maintenance lane, and
-- this lane's phases stack after them (threads and twin take the
-- next free numbers when they land). This migration is independent
-- of all of them and may apply before or after any of them safely.
--
-- Settlements: the pay record Abel never had. One row per settlement
-- statement (what the carrier actually paid, load by load in the
-- lines), the code-computed true-pay figures on the same row (tax
-- set-aside / spendable / effective $ per ALL miles and per duty
-- hour - computed in services/bot/pay-truth.ts, never by a model),
-- and the pin-check verdict: does this settlement's math reproduce
-- under the pinned pay structure? A mismatch is stored as data and
-- raised to the owner, never absorbed (design §3.4).
--
-- The pay PIN itself is NOT a table: it is a business_fact memory
-- ("Pay structure" subject, services/bot/pay-pin.ts) so it rides
-- the Lane 2 lifecycle - supersession, provenance, retrieval -
-- instead of inventing a second fact store.
--
-- pay_report_runs: the weekly true-pay report's due-ness state
-- (the consolidation_runs pattern), so a restart or a second
-- machine can never double-send a week's report.

create table settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  /** Who issued the settlement (the carrier on the statement). */
  issuer_name text not null,
  period_start date not null,
  period_end date not null,
  /** Total load gross the period's loads paid the truck/carrier. */
  gross_cents integer not null,
  /** The carrier's cut, when the statement shows it. */
  carrier_cut_cents integer,
  /** What the truck's side netted after deductions, when shown. */
  net_to_truck_cents integer,
  /** HIS pay line - what this settlement paid the driver. */
  driver_pay_cents integer not null,
  /** All miles in the period (loaded + deadhead); eff-CPM divides by this. */
  miles_total integer,
  miles_loaded integer,
  /** Duty minutes in the period (from his duty logs at record time); eff-hourly divides by this. */
  duty_minutes integer,
  /** The paperwork photo this settlement was read from, when there is one. */
  source_document_id uuid references documents (id),
  /** Pin check at record time: fits | mismatch | unpinned | insufficient_data. */
  pin_check text not null default 'unpinned',
  pin_check_detail text,
  /** Code-computed true pay (services/bot/pay-truth.ts) at record time. */
  tax_setaside_cents integer,
  spendable_cents integer,
  effective_cpm_cents integer,
  effective_hourly_cents integer,
  /** The same pay converted to the other employment model's terms (W2 <-> 1099, tax-only). */
  other_model_pay_cents integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint settlements_period_order check (period_end >= period_start),
  constraint settlements_pin_check_valid
    check (pin_check in ('fits', 'mismatch', 'unpinned', 'insufficient_data'))
);

create index settlements_company_period_idx
  on settlements (company_id, period_end desc)
  where deleted_at is null;

alter table settlements enable row level security;

create policy "tenant isolation" on settlements
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create table settlement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  settlement_id uuid not null references settlements (id),
  kind text not null default 'other_earning',
  /** Signed cents: earnings positive, deductions negative. */
  amount_cents integer not null,
  /** What the line is, in the statement's own label. */
  label text not null,
  /** The load this line belongs to, when the statement ties them. */
  load_id uuid references loads (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint settlement_lines_kind_valid check (kind in (
    'load_pay', 'carrier_cut', 'fuel', 'tolls', 'advance', 'factoring',
    'detention', 'layover', 'escrow', 'insurance', 'dispatch_fee',
    'other_earning', 'other_deduction'
  ))
);

create index settlement_lines_settlement_idx
  on settlement_lines (settlement_id)
  where deleted_at is null;

alter table settlement_lines enable row level security;

create policy "tenant isolation" on settlement_lines
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create table settlement_load_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  settlement_id uuid not null references settlements (id),
  load_id uuid not null references loads (id),
  /** How the link was made: 'line' (a settlement line names the load) or 'owner' (he confirmed it). */
  matched_by text not null default 'line',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint settlement_load_links_matched_by_valid
    check (matched_by in ('line', 'owner')),
  constraint settlement_load_links_unique unique (settlement_id, load_id)
);

alter table settlement_load_links enable row level security;

create policy "tenant isolation" on settlement_load_links
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create table pay_report_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  /** Monday (America/New_York) of the week this report covers. */
  week_start date not null,
  /** True only when the report was actually accepted by Telegram. */
  sent boolean not null default false,
  /** The report's headline figures, for audit (spendable is the point). */
  figures jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint pay_report_runs_week_unique unique (company_id, week_start)
);

alter table pay_report_runs enable row level security;

create policy "tenant isolation" on pay_report_runs
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
