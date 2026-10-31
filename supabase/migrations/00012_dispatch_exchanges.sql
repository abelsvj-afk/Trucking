-- Driver MVP (docs/design/driver-mvp.md §5). Captures dispatch-helper
-- exchanges - what came in, what the AI produced, and what the owner
-- actually sent - as the raw material for learning how the owner
-- writes. Same conventions as every other table: company_id +
-- tenant-isolation RLS, soft delete, created_at/updated_at.

create table dispatch_exchanges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  incoming_message text not null,
  ai_translation text,
  ai_suggested_reply_en text,
  ai_suggested_reply_es text,
  actual_reply_sent text,
  source text not null,
  constraint dispatch_exchanges_source_valid
    check (source in ('web', 'telegram')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table dispatch_exchanges enable row level security;

create policy "tenant isolation" on dispatch_exchanges
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
