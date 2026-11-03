-- Fresh-Eyes Gap Register (2026-11-02) — Cluster D: GAP-11
-- credential expiry watch.
--
-- A driver record displays cdl_expires_on and nothing anywhere
-- watches it; medical card, annual inspection, registration/IRP,
-- and insurance have no fields at all. credentials is the register:
-- one row per document with an expiry, attached to the driver,
-- truck, or company it belongs to, with the document photo itself
-- filed through GAP-01's pipeline (document_id). The watcher is
-- code (src/lib/credentials.ts + the day-wrap/Abel surfaces);
-- 60/30/7-day warnings, silent when all is well.

create table credentials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  kind text not null
    constraint credentials_kind_valid check (
      kind in ('cdl', 'medical_card', 'annual_inspection', 'registration_irp', 'insurance', 'other')
    ),
  label text not null,
  driver_id uuid references drivers (id),
  truck_id uuid references trucks (id),
  expires_on date not null,
  document_id uuid references documents (id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index credentials_company_expires_idx on credentials (company_id, expires_on);

alter table credentials enable row level security;

create policy "tenant isolation" on credentials
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
