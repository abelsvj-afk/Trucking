-- driver_positions.last_prompt_kind (00060) only allowed 'start_driving' and
-- 'stop_driving', but the live-location code also saves:
--  - 'feed_stale' (since the stale-feed notice; that save was refused by the
--    check, so the position row stopped updating after a stale-feed notice), and
--  - 'rest_ask' (audit F-003, 2026-11-20): the "going off duty?" question asked
--    at 2 hours parked. Auto Off Duty now happens only after this question
--    goes unanswered (services/fleet/auto-motion.ts applyAutoRestSwitch).
-- Widens the check; no data changes.

alter table driver_positions drop constraint if exists driver_positions_prompt_kind_valid;
alter table driver_positions add constraint driver_positions_prompt_kind_valid
  check (last_prompt_kind is null or last_prompt_kind in ('start_driving', 'stop_driving', 'feed_stale', 'rest_ask'));
