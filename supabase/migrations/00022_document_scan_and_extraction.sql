-- Document scan + AI-readable documents (docs/design/driver-mvp.md §8,
-- TASKS.md 7.12). Adds the scan-rendition pointer and the extraction
-- result columns to documents, plus the full-text search vector the
-- GET /api/v1/documents?q= search mode runs against. No new table -
-- RLS on documents is unchanged and already covers the new columns.

alter table documents
  add column scan_storage_path text,
  add column doc_type text
    check (doc_type in ('bol', 'rate_confirmation', 'scale_ticket', 'fuel_receipt', 'settlement', 'other')),
  add column extracted_text text,
  add column extracted_fields jsonb,
  add column extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'done', 'failed', 'disabled', 'not_applicable')),
  add column extraction_error text,
  add column extracted_at timestamptz,
  add column extracted_tsv tsvector
    generated always as (
      to_tsvector('english', coalesce(extracted_text, '') || ' ' || coalesce(file_name, ''))
    ) stored;

create index documents_extracted_tsv_idx on documents using gin (extracted_tsv);
