-- Malik real tools (design docs/design/malik-real-tools.md).
-- Malik is the Telnyx phone voice. His webhook tools call the app; every
-- tool call is logged, and every call outcome is reported to Abel.
--
-- malik_tool_calls: one row per tool call Malik makes mid-conversation.
-- malik_call_reports: one row per message taken or per call summary, so
-- Abel (the coordinator) can read what Malik heard. A call summary is
-- keyed by telnyx_conversation_id — one report per conversation, upserted,
-- never duplicated.
--
-- Money is integer cents everywhere (no money in these tables at all).
-- Every table is RLS by company_id. Writes go through the service-role
-- client only (Telnyx webhook + tool endpoint); there are deliberately no
-- authenticated insert/update/delete policies here.
-- Policies use private.current_company_id(), the live form (00006 moved
-- the helper into the private schema).

create table if not exists malik_tool_calls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  tool_name text not null check (tool_name in (
    'malik_get_active_load',
    'malik_get_delivery_eta',
    'malik_get_hos_hours',
    'malik_get_trip_status',
    'malik_get_load_paperwork',
    'malik_take_message'
  )),
  args jsonb not null default '{}'::jsonb,
  result_text text check (result_text is null or char_length(result_text) <= 2000),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  conversation_ref text check (conversation_ref is null or char_length(conversation_ref) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists malik_tool_calls_company_idx on malik_tool_calls (company_id, created_at desc);

create table if not exists malik_call_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  kind text not null check (kind in ('message', 'call-summary')),
  telnyx_conversation_id text check (telnyx_conversation_id is null or char_length(telnyx_conversation_id) <= 120),
  caller_name text check (caller_name is null or char_length(caller_name) between 1 and 120),
  callback_number text check (callback_number is null or char_length(callback_number) between 1 and 40),
  title text not null check (char_length(title) between 1 and 240),
  body text not null check (char_length(body) between 1 and 4000),
  payload jsonb not null default '{}'::jsonb,
  reported_to_group boolean not null default false,
  telegram_message_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists malik_call_reports_company_idx on malik_call_reports (company_id, created_at desc);
create unique index if not exists malik_call_reports_conversation_uidx
  on malik_call_reports (company_id, telnyx_conversation_id)
  where kind = 'call-summary' and telnyx_conversation_id is not null;

alter table malik_tool_calls enable row level security;
alter table malik_call_reports enable row level security;

-- Company read for the app surfaces. Writes go through the
-- service-role client only (Telnyx webhook / tool endpoint).
create policy "malik_tool_calls: company read" on malik_tool_calls
  for select using (company_id = private.current_company_id());
create policy "malik_call_reports: company read" on malik_call_reports
  for select using (company_id = private.current_company_id());
