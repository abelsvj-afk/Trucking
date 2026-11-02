-- Lane 1 — Abel trust fixes (Telegram/Abel Audit 2026-11-02, B-2/B-6).
-- Numbered 00033 deliberately: 00029-00032 are reserved by the Abel
-- Intelligence Upgrade design (memory lifecycle / threads /
-- settlements / summaries, Lane 2). This migration is independent of
-- all of them and may apply before or after any of them safely.
--
-- B-6: a Telegram photo's caption is stored ON the document row and
-- folded into the full-text search vector, so "scale ticket for the
-- Georgia load" stays findable after the chat scrolls past it. The
-- generated tsvector column is rebuilt to include the caption (the
-- 00022 GIN index is recreated with it).
--
-- B-2: processed Telegram update ids. The webhook claims an
-- update_id BEFORE processing (primary key = the claim); a Telegram
-- redelivery of the same update hits the unique constraint and is
-- ignored, so a retry can never double-log a write or double-store
-- a photo. Rows are never read back for content - existence is the
-- whole record - and there is no soft delete: this is a claim log,
-- not a business record.

alter table documents
  add column caption text;

alter table documents
  drop column extracted_tsv;

alter table documents
  add column extracted_tsv tsvector
    generated always as (
      to_tsvector('english', coalesce(extracted_text, '') || ' ' || coalesce(file_name, '') || ' ' || coalesce(caption, ''))
    ) stored;

create index documents_extracted_tsv_idx on documents using gin (extracted_tsv);

create table telegram_processed_updates (
  company_id uuid not null references companies (id),
  update_id bigint not null,
  processed_at timestamptz not null default now(),
  primary key (company_id, update_id)
);

alter table telegram_processed_updates enable row level security;

create policy "tenant isolation" on telegram_processed_updates
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
