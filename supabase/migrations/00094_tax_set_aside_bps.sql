-- 00094 - Tax set-aside percent on the pay profile.
--
-- Owner order 2026-11-12: the owner is a 1099 contractor (Independent
-- Contractor Agreement dated Nov 9, 2026; no escrow withheld; paid via
-- Zelle), and the app must show a per-check tax-savings recommendation.
-- The percent is per-company DATA on the pay profile, never hardcoded:
-- the owner edits it in Settings -> Pay.
--
-- tax_set_aside_bps is NULL until he sets it. NULL means "use the
-- 25% default" (2500 bps: covers the 15.3% self-employment tax plus an
-- income-tax slice) and the UI labels it as a default. The
-- recommendation NEVER moves money - display only.
--
-- No backfill: existing rows keep NULL so the labelled default applies.
-- The set-aside shows only when the profile's worker_type is '1099';
-- a NULL worker_type shows no set-aside line at all (existing UNSET
-- behavior is unchanged).
--
-- Migration replay NOT run on this VM (no Postgres: no psql /
-- pg_ctl / initdb) - validated by review against 00063/00074 and
-- covered by unit tests of the math + display conditions.

alter table employer_pay_profiles
  add column tax_set_aside_bps integer
    constraint employer_pay_profiles_tax_set_aside_valid
      check (tax_set_aside_bps is null or (tax_set_aside_bps >= 0 and tax_set_aside_bps <= 10000));
