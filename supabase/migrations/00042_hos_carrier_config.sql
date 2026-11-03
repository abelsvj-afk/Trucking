-- HOS carrier configuration (Reliability & Completion Program,
-- Unit B — docs/reliability-wave1-design-package.md B.2.5/B.5, F-015).
--
-- FMCSA 60/7 and 70/8 limits run over consecutive 24-hour periods
-- anchored to the CARRIER's specified start time, in the carrier's
-- timezone. The HOS cycle engine needs those carrier parameters per
-- company; until now they existed nowhere and the summary silently
-- assumed a continuous rolling window.
--
-- The defaults are the owner-approved PROVISIONAL configuration —
-- anchor 00:00, 70/8, 34-hour restart enabled, America/New_York —
-- shipped labeled as provisional in the UI. They are starting values
-- to be replaced with the carrier's actual specified rules, never
-- verified carrier facts. Every existing company row backfills to
-- them by the column defaults; behavior for existing data is
-- therefore defined from the moment this lands.
--
-- No RLS changes: companies already carries its tenant policy, and
-- the new columns ride it. Adds only; no existing column is touched.

alter table companies
  add column hos_cycle text not null default '70/8';

alter table companies
  add constraint companies_hos_cycle_valid
  check (hos_cycle in ('70/8', '60/7'));

alter table companies
  add column hos_period_anchor text not null default '00:00';

alter table companies
  add constraint companies_hos_period_anchor_valid
  check (hos_period_anchor ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

alter table companies
  add column hos_restart_enabled boolean not null default true;

alter table companies
  add column hos_carrier_timezone text not null default 'America/New_York';
