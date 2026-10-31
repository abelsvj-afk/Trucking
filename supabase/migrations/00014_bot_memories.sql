-- Driver MVP bot intelligence (docs/design/driver-mvp.md §6). The
-- bot's durable memory store: facts the owner dictates, notes,
-- expense hints (captured for review - NOT booked expenses), and his
-- standing instructions for the bot. Instruction rows double as the
-- bot's profile/settings store: they are injected into every prompt,
-- which is the fix for the known "bot ignores my custom instructions"
-- failure mode. Same conventions as every other table: company_id +
-- tenant-isolation RLS, soft delete, created_at/updated_at.

create table bot_memories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  kind text not null,
  constraint bot_memories_kind_valid check (kind in ('fact', 'note', 'expense_hint', 'instruction')),
  content text not null,
  source text not null,
  constraint bot_memories_source_valid check (source in ('telegram', 'web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table bot_memories enable row level security;

create policy "tenant isolation" on bot_memories
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
