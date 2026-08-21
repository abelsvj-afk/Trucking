-- Task 1.4 (TASKS.md), part 3 of 3. documents - per docs/schemas.md.
-- No deleted_at/updated_at: documents aren't edited in place and are
-- hard-deleted like any file, per docs/schemas.md.

create table documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  related_entity_type text not null,
  related_entity_id uuid not null,
  file_name text not null,
  storage_path text not null,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table documents enable row level security;

create policy "tenant isolation" on documents
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());
