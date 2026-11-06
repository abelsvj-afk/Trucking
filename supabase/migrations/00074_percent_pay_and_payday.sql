-- 00074 - Percent-of-load pay, a per-load pay override, pay week and payday
-- (docs/design/employer-pay-profile.md section 8). ADDITIVE and nullable: no
-- existing row changes meaning, no seed, nothing hardcoded to any employer.
--
--   percent_of_load_bps  basis points of the load's rate (8500 = 85.00%); null = no percent part
--   pay_week_ends_on     0 = Sunday .. 6 = Saturday; null = visibly UNSET (Monday-Sunday shown)
--   payday_weekday       same numbering; null = visibly UNSET (no payday date shown)
--   loads.pay_override_cents  the driver's own figure for what THIS load pays him; null = use the terms

alter table employer_pay_profiles
  add column percent_of_load_bps integer
    constraint employer_pay_profiles_percent_valid check (percent_of_load_bps is null or (percent_of_load_bps between 0 and 10000)),
  add column pay_week_ends_on smallint
    constraint employer_pay_profiles_week_end_valid check (pay_week_ends_on is null or (pay_week_ends_on between 0 and 6)),
  add column payday_weekday smallint
    constraint employer_pay_profiles_payday_valid check (payday_weekday is null or (payday_weekday between 0 and 6));

alter table loads
  add column pay_override_cents integer
    constraint loads_pay_override_valid check (pay_override_cents is null or pay_override_cents >= 0);
