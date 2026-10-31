-- Driver MVP bot intelligence (docs/design/driver-mvp.md §6). The
-- private Telegram bot's conversation history: every allowlisted turn
-- (his messages and the bot's replies) is persisted so future prompts
-- carry real history - a bot answering with empty history is a known
-- failure mode this table exists to prevent. Same conventions as
-- every other table: company_id + tenant-isolation RLS, soft delete,
-- created_at/updated_at. Written by the bot via its documented
-- service-role path (design §5/§6), read back the same way.

create table telegram_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  chat_id bigint not null,
  role text not null,
  constraint telegram_messages_role_valid check (role in ('user', 'assistant')),
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table telegram_messages enable row level security;

create policy "tenant isolation" on telegram_messages
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
