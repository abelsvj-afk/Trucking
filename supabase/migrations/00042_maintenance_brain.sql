-- 00042 - Image Intelligence + Smart Maintenance (design
-- 2026-11-02 §5.1/§5.5/§5.6, migration B): the maintenance brain's
-- state. Three pieces:
--
-- 1. maintenance_schedules learns WHERE a schedule came from:
--    template_key ties it to the interval library
--    (src/lib/maintenance-templates.ts) so a recorded event can
--    find and advance its schedule (§5.4), and origin says whether
--    the row came from the template pack, the owner's own words,
--    or Abel's suggestion - the honesty label travels with the row.
--
-- 2. vehicle_defects: the tracked-defect lifecycle (§5.5). A
--    defect is an observed problem (failed pre-trip, damage
--    photo, his words) - distinct from a maintenance EVENT (work
--    done) and a SCHEDULE (future work). Closure is proposed when
--    a matching maintenance event lands, never automatic.
--
-- 3. The watcher's state (§5.6): maintenance_watch_runs is the
--    due-check ledger (consolidation_runs' shape), and the
--    reminder columns on maintenance_schedules make reminder
--    dedupe STATE rather than memory - last_reminder_key is the
--    schedule's next-due signature when it was last reminded
--    about, so a reminder re-fires only when the due point moves
--    or the tier changes.

alter table maintenance_schedules
  add column template_key text,
  add column origin text not null default 'owner'
    check (origin in ('template', 'owner', 'abel')),
  add column last_reminded_at timestamptz,
  add column last_reminder_key text;

create table vehicle_defects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  truck_id uuid references trucks (id),
  trailer_id uuid references trailers (id),
  description text not null,
  source text not null check (source in ('pretrip', 'photo', 'conversation')),
  source_inspection_id uuid references pretrip_inspections (id),
  source_document_id uuid references documents (id),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'closed', 'dismissed')),
  -- Set when a maintenance event is accepted as the fix (§5.5:
  -- closure is a staged proposal, not a side effect).
  maintenance_event_id uuid references maintenance_events (id),
  last_follow_up_at timestamptz,
  follow_up_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint vehicle_defects_exactly_one_vehicle
    check ((truck_id is not null) <> (trailer_id is not null))
);

create index vehicle_defects_company_status_idx
  on vehicle_defects (company_id, status, created_at desc);

alter table vehicle_defects enable row level security;

create policy "tenant isolation" on vehicle_defects
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

create table maintenance_watch_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  ran_at timestamptz not null default now(),
  reminders_sent integer not null default 0,
  detail jsonb not null default '{}'::jsonb
);

create index maintenance_watch_runs_company_ran_idx
  on maintenance_watch_runs (company_id, ran_at desc);

alter table maintenance_watch_runs enable row level security;

create policy "tenant isolation" on maintenance_watch_runs
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
