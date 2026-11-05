-- 00071 - Reliability Unit E (F-024 boundary, ruling D-03): documents carry a polymorphic
-- reference (related_entity_type + related_entity_id) that no foreign key can express, so a
-- trigger enforces it. On INSERT, and on UPDATE of the reference or company, the document's
-- target must (a) be an allowed type, (b) exist, (c) belong to the document's company, and
-- (d) not be soft-deleted. Existing rows are untouched (a trigger only fires on writes).
--
-- Allowlist = the types the app writes today: truck, trailer, driver, load (the documents
-- API's own enum) and company (Telegram photos are filed under the company itself until a
-- proposal links them). Adding a type later is a deliberate migration, not a code-only change.
--
-- Execution-security terms (design E.3.3):
--   * SECURITY DEFINER only because it must read target rows across RLS to check ownership;
--   * search_path fixed to pg_catalog, public (never caller-influenced);
--   * returns no data - it raises or it does not;
--   * EVERY rejection raises the IDENTICAL error (same message, same SQLSTATE) whether the target
--     is nonexistent, another company's, soft-deleted, or of a disallowed type, so the trigger can
--     never be used as an oracle for whether another company's record exists.
-- The function is owned by the migration role and is not callable by API roles directly.

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

create trigger documents_validate_reference
  before insert or update of related_entity_type, related_entity_id, company_id
  on public.documents
  for each row execute function public.documents_validate_reference();
