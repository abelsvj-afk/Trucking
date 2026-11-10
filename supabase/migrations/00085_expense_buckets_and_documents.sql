-- 00085 - Expense buckets + document creation metadata
-- (docs/design/expense-buckets-documents.md; owner spec 2026-11-09).
--
-- Three independent changes, all additive, no new tables:
--
-- 1. expenses.bucket: every expense is one of two kinds of money.
--    'business' (default) lives in his own company's books and never
--    touches driver pay; 'pay_deduction' is a cost the company he
--    drives for takes out of his check, and the paycheck picture nets
--    it as its own visible line. Existing rows default to 'business'
--    BY DESIGN: nothing already recorded changes buckets without the
--    owner's yes (a reclassification is a proposal, e.g. through
--    Abel's update_expense). Employer-agnostic: the bucket names a
--    kind of money, never an employer or a person.
--
-- 2. documents metadata for typed, created paperwork:
--    - doc_type CHECK widened with the bookkeeping kinds the books
--      need (receipt, agreement, invoice, statement) alongside the
--      existing paperwork kinds;
--    - situation: the bookkeeping situation the document belongs to
--      ('carrier' | 'own_authority' | 'business_records'), nullable -
--      legacy rows claim none;
--    - source: 'upload' (default; everything recorded so far) or
--      'generated' for documents Abel/the app created;
--    - generator: which backend made a generated document
--      ('app_pdf' today; the seam a future document backend plugs
--      into). Null on uploads.
--
-- 3. The 00071 reference trigger learns the 'expense' target type,
--    with the identical rejection (same message, same SQLSTATE) for
--    every failure, so it still cannot be used as an oracle.
--
-- RLS is unchanged: both tables already carry tenant isolation, and
-- the anon-write defaults from 00067 already apply.

alter table expenses
  add column bucket text not null default 'business'
  check (bucket in ('business', 'pay_deduction'));

create index expenses_company_bucket_date_idx
  on expenses (company_id, bucket, expense_date desc)
  where deleted_at is null;

alter table documents drop constraint documents_doc_type_check;
alter table documents
  add constraint documents_doc_type_check
  check (doc_type in (
    'bol', 'rate_confirmation', 'scale_ticket', 'fuel_receipt',
    'settlement', 'receipt', 'agreement', 'invoice', 'statement', 'other'
  ));

alter table documents
  add column situation text
  check (situation in ('carrier', 'own_authority', 'business_records'));

alter table documents
  add column source text not null default 'upload'
  check (source in ('upload', 'generated'));

alter table documents
  add column generator text;

create or replace function public.documents_validate_reference()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ok boolean := false;
begin
  if new.related_entity_type = 'truck' then
    ok := exists (select 1 from public.trucks t where t.id = new.related_entity_id and t.company_id = new.company_id and t.deleted_at is null);
  elsif new.related_entity_type = 'trailer' then
    ok := exists (select 1 from public.trailers t where t.id = new.related_entity_id and t.company_id = new.company_id and t.deleted_at is null);
  elsif new.related_entity_type = 'driver' then
    ok := exists (select 1 from public.drivers t where t.id = new.related_entity_id and t.company_id = new.company_id and t.deleted_at is null);
  elsif new.related_entity_type = 'load' then
    ok := exists (select 1 from public.loads t where t.id = new.related_entity_id and t.company_id = new.company_id and t.deleted_at is null);
  elsif new.related_entity_type = 'expense' then
    ok := exists (select 1 from public.expenses t where t.id = new.related_entity_id and t.company_id = new.company_id and t.deleted_at is null);
  elsif new.related_entity_type = 'company' then
    ok := new.related_entity_id = new.company_id;
  end if;
  if not ok then
    raise exception 'invalid document reference' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.documents_validate_reference() from public;
