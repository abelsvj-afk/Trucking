-- Image Intelligence + Smart Maintenance, Phase 1 (design:
-- Trucking-Telegram-Image-Maintenance-Design-2026-11-02.md §6,
-- Migration A). Numbering: main is through 00040 (research
-- intelligence); 00041 is the next free number, re-checked against
-- main at build time. (00034-00039 remain the Abel lanes' reserved
-- gap and are not used here; Wave 1 / Reliability re-derives its own
-- numbers at its pre-flight.)
--
-- What this migration adds:
--   documents.photo_purpose / photo_purpose_source /
--     photo_purpose_confidence - every photo Abel receives gets a
--     purpose before anything is filed under it (§3): what it is,
--     who settled it (the vision read, his caption, or the owner
--     himself), and how confident the read was. Null = legacy /
--     unclassified (a photo stored before this feature, or one whose
--     purpose question is still open).
--   trucks.current_mileage_source / current_mileage_at - mileage
--     provenance (§5.3): where the truck's current mileage came from
--     and when it was read, so a due-in-X-miles figure can always
--     say what it stands on. Written by the Phase 2 propagation
--     helper; the columns land here with the rest of Migration A.
--   fuel_purchases.odometer - GAP-09's missing field: a fuel stop
--     is a mileage reading, and until now the schema had nowhere to
--     put it. Nullable and optional forever - a fuel entry never
--     blocks on it.
--
-- No new tables, no RLS changes: these are columns on existing
-- tenant-isolated tables, and bot_pending_actions needs no change -
-- the photo-purpose ask rides its existing columns (design §6).

alter table documents
  add column photo_purpose text
    check (photo_purpose in ('paperwork', 'paper_log', 'truck_exterior', 'trailer', 'odometer_dash', 'pretrip', 'other')),
  add column photo_purpose_source text
    check (photo_purpose_source in ('vision', 'caption', 'owner')),
  add column photo_purpose_confidence numeric;

alter table trucks
  add column current_mileage_source text
    check (current_mileage_source in ('odometer_photo', 'duty_log', 'maintenance_event', 'fuel_entry', 'owner_said', 'form')),
  add column current_mileage_at timestamptz;

alter table fuel_purchases
  add column odometer integer check (odometer is null or odometer >= 0);
