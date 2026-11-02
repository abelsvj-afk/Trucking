-- Record lifecycle (Reliability & Completion Program, Unit A —
-- docs/reliability-wave1-design-package.md A.5/A.7). Three changes:
--
-- 1. Idempotent creates (F-006): every standard CRUD table gains a
--    nullable submission token + payload fingerprint, with a named
--    partial unique index per table. The index name is part of the
--    contract: the API layer enters its dedup path ONLY when a
--    violation names this index, so other unique violations keep their
--    own errors. Nullable + partial (WHERE submission_id IS NOT NULL)
--    means token-less writes — the bot's tools, older clients — are
--    completely unaffected.
--
-- 2. Documents gain a RETENTION delete (F-007): deletion tombstones
--    the row; the stored file is retained while retention_status =
--    'retained'. purged_at exists for a FUTURE purge process under an
--    owner-approved retention policy; nothing in this migration (or
--    the Unit A code) ever purges.
--
-- 3. cleanup_incidents: the record for a storage object with no owning
--    row — an upload whose rollback removal failed, or an object whose
--    compensating row insert failed (F-038 record shape). company_id
--    is nullable because an incident must be recordable even when the
--    company context is part of what failed; rows with a company_id
--    are tenant-visible under the standard policy, and the service
--    role sees all.

-- 1. Submission columns + named partial unique indexes ---------------

alter table trucks add column submission_id uuid;
alter table trucks add column submission_payload_hash text;
create unique index trucks_submission_idempotency
  on trucks (company_id, submission_id) where submission_id is not null;

alter table trailers add column submission_id uuid;
alter table trailers add column submission_payload_hash text;
create unique index trailers_submission_idempotency
  on trailers (company_id, submission_id) where submission_id is not null;

alter table drivers add column submission_id uuid;
alter table drivers add column submission_payload_hash text;
create unique index drivers_submission_idempotency
  on drivers (company_id, submission_id) where submission_id is not null;

alter table brokers add column submission_id uuid;
alter table brokers add column submission_payload_hash text;
create unique index brokers_submission_idempotency
  on brokers (company_id, submission_id) where submission_id is not null;

alter table customers add column submission_id uuid;
alter table customers add column submission_payload_hash text;
create unique index customers_submission_idempotency
  on customers (company_id, submission_id) where submission_id is not null;

alter table loads add column submission_id uuid;
alter table loads add column submission_payload_hash text;
create unique index loads_submission_idempotency
  on loads (company_id, submission_id) where submission_id is not null;

alter table expenses add column submission_id uuid;
alter table expenses add column submission_payload_hash text;
create unique index expenses_submission_idempotency
  on expenses (company_id, submission_id) where submission_id is not null;

alter table fuel_purchases add column submission_id uuid;
alter table fuel_purchases add column submission_payload_hash text;
create unique index fuel_purchases_submission_idempotency
  on fuel_purchases (company_id, submission_id) where submission_id is not null;

alter table duty_logs add column submission_id uuid;
alter table duty_logs add column submission_payload_hash text;
create unique index duty_logs_submission_idempotency
  on duty_logs (company_id, submission_id) where submission_id is not null;

alter table maintenance_events add column submission_id uuid;
alter table maintenance_events add column submission_payload_hash text;
create unique index maintenance_events_submission_idempotency
  on maintenance_events (company_id, submission_id) where submission_id is not null;

alter table maintenance_schedules add column submission_id uuid;
alter table maintenance_schedules add column submission_payload_hash text;
create unique index maintenance_schedules_submission_idempotency
  on maintenance_schedules (company_id, submission_id) where submission_id is not null;

alter table pretrip_inspections add column submission_id uuid;
alter table pretrip_inspections add column submission_payload_hash text;
create unique index pretrip_inspections_submission_idempotency
  on pretrip_inspections (company_id, submission_id) where submission_id is not null;

alter table equipment_checklist_items add column submission_id uuid;
alter table equipment_checklist_items add column submission_payload_hash text;
create unique index equipment_checklist_items_submission_idempotency
  on equipment_checklist_items (company_id, submission_id) where submission_id is not null;

alter table account_snapshots add column submission_id uuid;
alter table account_snapshots add column submission_payload_hash text;
create unique index account_snapshots_submission_idempotency
  on account_snapshots (company_id, submission_id) where submission_id is not null;

alter table dispatch_exchanges add column submission_id uuid;
alter table dispatch_exchanges add column submission_payload_hash text;
create unique index dispatch_exchanges_submission_idempotency
  on dispatch_exchanges (company_id, submission_id) where submission_id is not null;

alter table fund_entries add column submission_id uuid;
alter table fund_entries add column submission_payload_hash text;
create unique index fund_entries_submission_idempotency
  on fund_entries (company_id, submission_id) where submission_id is not null;

-- 2. Documents: retention delete --------------------------------------

alter table documents add column deleted_at timestamptz;
alter table documents add column retention_status text;
alter table documents add column retention_error text;
alter table documents add column purged_at timestamptz;

alter table documents add constraint documents_retention_status_valid
  check (retention_status is null or retention_status in
    ('retained', 'purge_pending', 'purged', 'purge_failed'));

-- 3. Cleanup incidents -------------------------------------------------

create table cleanup_incidents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id),
  storage_path text not null,
  kind text not null,
  constraint cleanup_incidents_kind_valid
    check (kind in ('upload_rollback', 'row_insert_failed')),
  status text not null default 'open',
  constraint cleanup_incidents_status_valid
    check (status in ('open', 'resolved', 'object_absent')),
  detail text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table cleanup_incidents enable row level security;

create policy "tenant isolation" on cleanup_incidents
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
