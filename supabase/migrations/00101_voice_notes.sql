-- Location voice notes (owner 2026-11-18/19; design docs/design/voice-notes.md).
-- A driver taps the mic and leaves a short voice note tied to a spot on the map.
-- Coworkers coming up on it see a shaking, pulsing bubble on the map and in the
-- upcoming list, can listen from far ahead, and it clears FOR THAT DRIVER once
-- he has listened AND passed it (or 30 minutes after listening, if a pass is
-- never detected). It stays for the next driver.
--
-- Owner decisions (2026-11-19):
--   * lifetime by type: traffic 2 h, road work 7 days, bridge / hazard until
--     cleared, tip 30 days (expires_at set by the API from `kind`);
--   * coworkers can report a hazard GONE and clear it for everyone, gated by
--     fleet size so one driver cannot wipe a real warning once the company has
--     more drivers (threshold computed in lib/voice-notes.ts from
--     company_member_count() below);
--   * a note never pesters its own author; its author can remove it.
--
-- Audio lives in the existing private `documents` bucket under
-- <company_id>/voice-notes/..., so 00007's tenant-isolation storage policies
-- apply unchanged — no new bucket, no new storage policy.
--
-- New migration number; nothing earlier is edited (migrations are frozen once applied).

create table if not exists voice_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('traffic', 'roadwork', 'bridge', 'hazard', 'tip')),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  -- Direction of travel when it was left: a note is for drivers going the same way.
  heading_deg double precision check (heading_deg is null or (heading_deg >= 0 and heading_deg < 360)),
  road_ref text check (road_ref is null or char_length(road_ref) <= 20),
  storage_path text not null check (char_length(storage_path) <= 300),
  duration_s double precision not null check (duration_s > 0 and duration_s <= 60),
  created_at timestamptz not null default now(),
  -- null = lives until cleared (bridge / hazard)
  expires_at timestamptz,
  -- set only by the author removing his own note
  removed_at timestamptz
);

create index if not exists voice_notes_company_live_idx on voice_notes (company_id, created_at desc) where removed_at is null;

-- Per-driver state: listened / passed. One row per (note, driver).
create table if not exists voice_note_views (
  note_id uuid not null references voice_notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  listened_at timestamptz,
  passed_at timestamptz,
  primary key (note_id, user_id)
);

-- "It's gone" / "this note is wrong" reports. One of each kind per driver per note.
create table if not exists voice_note_reports (
  note_id uuid not null references voice_notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  kind text not null check (kind in ('gone', 'bad')),
  created_at timestamptz not null default now(),
  primary key (note_id, user_id, kind)
);

alter table voice_notes enable row level security;
alter table voice_note_views enable row level security;
alter table voice_note_reports enable row level security;

-- Notes: everyone in the company reads them; a driver creates notes as himself;
-- only the author may update (remove) his own note. No delete policy: removal
-- is a timestamp, so reports and views keep their history.
create policy "voice_notes: company read" on voice_notes
  for select using (company_id = private.current_company_id());
create policy "voice_notes: author insert" on voice_notes
  for insert with check (company_id = private.current_company_id() and author_id = auth.uid());
create policy "voice_notes: author update" on voice_notes
  for update using (company_id = private.current_company_id() and author_id = auth.uid())
  with check (company_id = private.current_company_id() and author_id = auth.uid());

-- Views: a driver reads and writes only his own rows.
create policy "voice_note_views: own read" on voice_note_views
  for select using (company_id = private.current_company_id() and user_id = auth.uid());
create policy "voice_note_views: own insert" on voice_note_views
  for insert with check (company_id = private.current_company_id() and user_id = auth.uid());
create policy "voice_note_views: own update" on voice_note_views
  for update using (company_id = private.current_company_id() and user_id = auth.uid())
  with check (company_id = private.current_company_id() and user_id = auth.uid());

-- Reports: the company reads them (the count clears a note); a driver files only his own.
create policy "voice_note_reports: company read" on voice_note_reports
  for select using (company_id = private.current_company_id());
create policy "voice_note_reports: own insert" on voice_note_reports
  for insert with check (company_id = private.current_company_id() and user_id = auth.uid());

-- How many people are in the caller's company — the ONLY thing it returns (no
-- names, no ids), so the "gone" threshold can grow with the fleet while
-- user_profiles stays readable only row-by-row ("read own profile", 00001).
create or replace function company_member_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from user_profiles where company_id = private.current_company_id()
$$;

revoke all on function company_member_count() from public;
grant execute on function company_member_count() to authenticated;
