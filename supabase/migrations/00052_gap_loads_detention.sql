-- Fresh-Eyes Gap Register (2026-11-02) — Cluster A: GAP-04 detention,
-- GAP-05 paperwork closeout inputs, GAP-02 appointment windows.
-- Renumbered in the union fix round (2026-11-02): GAP files now run
-- 00052-00057 (img-maint holds 00042-00044, Abel 00045-00047, R-6 00048;
-- main's 00041 record_lifecycle is untouched). File only — applied by the
-- owner through the dashboard like every migration before it.
--
-- GAP-02: a load stores only pickup/delivery DATES; the appointment
-- WINDOWS (which the rate con and dispatch forward already carry)
-- live nowhere, so Smart Path re-asks for them on every check and
-- detention math has no appointment to measure against. Windows are
-- full timestamps; the dates stay for the day-level views.
--
-- GAP-04: the app teaches "times written down are how detention gets
-- paid" and then gives the times nowhere to live. detention_stamps
-- is the facility clock: one row per stamp (arrival / door /
-- loading_done / departure), pre-filled with now, correctable later.
-- Detention TERMS ride on the load (from the rate con, captured by
-- GAP-01 proposals or typed once): free minutes before the clock
-- bills, and the per-hour rate.
--
-- GAP-05: a scale ticket's weight needs a home on the load
-- (weight_lbs) — it is also what makes "scale ticket required"
-- computable in the paperwork checklist.

alter table loads
  add column pickup_window_start timestamptz,
  add column pickup_window_end timestamptz,
  add column delivery_window_start timestamptz,
  add column delivery_window_end timestamptz,
  add column detention_free_minutes integer
    constraint loads_detention_free_nonnegative
      check (detention_free_minutes is null or detention_free_minutes >= 0),
  add column detention_rate_cents_per_hour integer
    constraint loads_detention_rate_nonnegative
      check (detention_rate_cents_per_hour is null or detention_rate_cents_per_hour >= 0),
  add column weight_lbs integer
    constraint loads_weight_nonnegative
      check (weight_lbs is null or weight_lbs > 0);

create table detention_stamps (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  load_id uuid not null references loads (id),
  stamp_type text not null
    constraint detention_stamps_type_valid
      check (stamp_type in ('arrival', 'door', 'loading_done', 'departure')),
  -- Which end of the run the stamp belongs to; a load has a pickup
  -- clock and a delivery clock, and detention is argued at both.
  stop_kind text not null default 'delivery'
    constraint detention_stamps_stop_valid
      check (stop_kind in ('pickup', 'delivery')),
  occurred_at timestamptz not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index detention_stamps_load_idx
  on detention_stamps (company_id, load_id, occurred_at);

alter table detention_stamps enable row level security;

create policy "tenant isolation" on detention_stamps
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
