-- 00060 - Latest driver position from Telegram Live Location
-- (docs/design/driver-usability.md §4). One row per company+source:
-- Telegram's own app streams the phone's position to the bot with the
-- screen off; the webhook upserts it here, derives speed and the
-- movement/stop episode, and may stage a duty-status PROPOSAL (never a
-- booking). Only the latest fix is kept - no location history.
--
-- RLS: company-scoped like every table. The webhook writes with the
-- service role; the app reads through GET /api/v1/position.

create table if not exists driver_positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  source text not null default 'telegram',
  constraint driver_positions_source_valid check (source in ('telegram')),
  lat double precision not null,
  lng double precision not null,
  accuracy_m double precision,
  heading_deg double precision,
  speed_mph double precision,
  recorded_at timestamptz not null,
  moving_since timestamptz,
  stopped_since timestamptz,
  last_prompt_at timestamptz,
  last_prompt_kind text,
  constraint driver_positions_prompt_kind_valid
    check (last_prompt_kind is null or last_prompt_kind in ('start_driving', 'stop_driving')),
  constraint driver_positions_lat_range check (lat between -90 and 90),
  constraint driver_positions_lng_range check (lng between -180 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, source)
);

alter table driver_positions enable row level security;

create policy "tenant isolation" on driver_positions
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
