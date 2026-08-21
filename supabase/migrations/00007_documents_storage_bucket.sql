-- Task 3.10 (TASKS.md). Creates the private "documents" Storage bucket
-- and RLS policies scoping objects to the uploading company, matching
-- every table's tenant-isolation model. Storage path convention:
-- {company_id}/{document_id}-{file_name} - the leading folder segment is
-- what these policies check via storage.foldername().

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "tenant isolation: select" on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = private.current_company_id()::text
  );

create policy "tenant isolation: insert" on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = private.current_company_id()::text
  );

create policy "tenant isolation: delete" on storage.objects
  for delete using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = private.current_company_id()::text
  );
