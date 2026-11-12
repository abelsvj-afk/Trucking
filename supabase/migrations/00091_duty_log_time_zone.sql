-- 00091 - Duty logs record the zone where the entry happened
-- (timezone transitions, owner order 2026-11-11).
--
-- The bug: every Telegram-facing clock was hardcoded to Eastern, and
-- a Nov 8 duty proposal was quoted back to the owner as raw UTC
-- ("2026-11-08T13:40:37.858Z"). The display zone now follows the
-- truck (lib/display-zone.ts: latest position fix, home Eastern
-- fallback), and every duty entry records the IANA zone where it
-- happened alongside its timestamp, so the log shows the zone and no
-- render ever has to guess it back from a bare instant.
--
-- Nullable, no backfill: rows written before this lands simply don't
-- carry a zone, and renders fall back to labeled home Eastern for
-- them. Writers that run against a database where this hasn't landed
-- yet drop the column and retry (same pattern as the 00047 source
-- columns), restating the zone in the note so it is not lost.
-- NUMBER: 00091 is the next free number on main at the time of
-- writing - if another branch has claimed it, renumber this file
-- before applying.

alter table duty_logs add column if not exists time_zone text;

comment on column duty_logs.time_zone is
  'IANA zone where the duty entry happened (e.g. America/Chicago), recorded at insert time from the truck''s latest position fix; home America/New_York fallback. Renders show the zone label; NULL = written before 00091, shown in labeled home time.';
