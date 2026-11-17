-- 00100 - Outbound phone calls (owner 2026-11-17; design docs/design/outbound-calling.md).
-- Abel can PLACE phone calls from one shared Telnyx number (drivers can't answer texts while
-- driving). One call at a time per company: calls queue in outbound_calls and are claimed
-- atomically (claim_next_outbound_call, per-company advisory lock) so two machines never dial
-- over each other. Transcript + outcome land on the row - the app is his proof vault.
-- companies.call_voice_id is the voice he picked in Settings -> Abel and AI (a Telnyx voice id;
-- null = the Telnyx default built-in voice). The ElevenLabs key itself lives in the Telnyx
-- portal as an Integration Secret, never here. Additive, tenant-isolated, soft delete, no seed.
-- NOTE: the F-001 declassify migration also wants 00100+ - if it lands first, renumber this one.

create table outbound_calls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  driver_id uuid references drivers (id),
  to_number text not null,
  to_name text not null,
  purpose text not null,
  say text not null,
  status text not null default 'queued'
    check (status in ('queued', 'dialing', 'in_progress', 'completed', 'failed', 'no_answer', 'voicemail')),
  telnyx_call_control_id text,
  telnyx_conversation_id text,
  transcript text,
  outcome text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index outbound_calls_company_status on outbound_calls (company_id, status, created_at);
create unique index outbound_calls_control_id on outbound_calls (telnyx_call_control_id)
  where telnyx_call_control_id is not null;

alter table outbound_calls enable row level security;

create policy "tenant isolation" on outbound_calls
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

alter table companies add column call_voice_id text;

-- Claim the oldest queued call for a company, but only when no call for that company is
-- already dialing or in progress. One statement per company, serialized by an advisory lock,
-- so two machines can never claim two calls at once on the one shared number. SECURITY
-- DEFINER: callers must pass only their own company id (the tool passes the store's
-- companyId; the Telnyx webhook passes the row's company). Returns the claimed row, or null.
create or replace function claim_next_outbound_call(p_company_id uuid)
returns outbound_calls
language plpgsql
security definer
as $$
declare
  claimed outbound_calls;
begin
  perform pg_advisory_xact_lock(hashtext('outbound-call-claim-' || p_company_id::text));
  if exists (
    select 1 from outbound_calls
    where company_id = p_company_id
      and status in ('dialing', 'in_progress')
      and deleted_at is null
  ) then
    return null;
  end if;
  select * into claimed from outbound_calls
    where company_id = p_company_id
      and status = 'queued'
      and deleted_at is null
    order by created_at asc
    limit 1
    for update skip locked;
  if claimed.id is null then
    return null;
  end if;
  update outbound_calls
    set status = 'dialing', updated_at = now()
    where id = claimed.id;
  select * into claimed from outbound_calls where id = claimed.id;
  return claimed;
end;
$$;
