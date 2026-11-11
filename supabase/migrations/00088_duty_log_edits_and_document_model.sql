-- 00088 - Duty-log edit trail + document model storage
-- (UI/UX redesign spec 2026-11-10 §2.2/§2.3; the spec text names this
-- migration 00087, but 00087 belongs to a concurrent build - this build
-- takes 00088. 00001-00086 are frozen; this file is authored on
-- feature/uiux-editing-navigation-2026-11-10 and is NOT applied by the
-- build - the coordinator applies migrations.)
--
-- 1. duty_log_edits: the edit trail for the day log. The honesty model
--    (ELD-shaped, 49 CFR 395.30 in spirit - this app remains a
--    paper-log helper, not an ELD, and claims no certification):
--    a duty entry's current row is never the whole story. Every
--    CORRECTION - an update, a backfilled insert, a delete, a restore -
--    writes one row here carrying WHY it happened (reason, never null),
--    WHAT the entry was before (before, full row snapshot; null for an
--    insert - there was nothing before) and WHAT it became (after,
--    full row snapshot; null for a delete), plus WHERE the fix came
--    from (source: the app, a conversation with Abel, or a paper-log
--    save). Live logging - a new entry for the status starting now -
--    is not a correction and writes NO trail row. The trail is
--    additive storage only: the HOS clocks compute from duty_logs
--    exactly as before and never read this table.
--    Existing duty rows have no trail; their history honestly starts
--    at "Original entry created" from duty_logs.created_at. Nothing
--    is backfilled or invented.
--    Tenant-isolated like every table (RLS, private.current_company_id()).
--
-- 2. documents.model: the stored DocumentModel for app-created
--    documents (spec §2.3 - one source, three faces). Nullable: only
--    Phase 3's generator writes it; uploads and every existing row
--    stay null and keep rendering from their file, honestly.
--    This build only adds the column.

create table duty_log_edits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  duty_log_id uuid not null references duty_logs (id),
  kind text not null check (kind in ('update', 'insert', 'delete', 'restore')),
  reason text not null,
  before jsonb,
  after jsonb,
  source text not null default 'app' check (source in ('app', 'conversation', 'paper')),
  edited_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index duty_log_edits_company_log_edited_idx
  on duty_log_edits (company_id, duty_log_id, edited_at);

alter table duty_log_edits enable row level security;

create policy "tenant isolation" on duty_log_edits
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

alter table documents add column if not exists model jsonb;
