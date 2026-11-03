-- Fuel: derived total + labeled adjustments (Reliability & Completion
-- Program, Unit C - docs/reliability-wave1-design-package.md C.4,
-- ruling D-04, finding F-053).
--
-- Until now gallons, price_per_gallon_cents and total_cost_cents were
-- three independent fields: 100 gal x $3.50 with a $500 total passed
-- everywhere. From this migration the total is DERIVED -
-- total = round(gallons x price) + adjustment - and the database
-- enforces it for every writer, not just the API. Genuine receipt
-- differences (taxes, discounts, rebates) are recorded as an explicit
-- adjustment WITH a reason, never as a silently different total.
--
-- Precision contract (C.4 Rev 2): gallons are thousandths, stored as
-- numeric(10,3); Postgres numeric multiplication of a 3-dp value by an
-- integer is exact and round() on non-negative numerics is half-up, so
-- the DB value is provably the same function the API computes in
-- integer milligallons (src/lib/fuel-math.ts; tripwire: 2.675 gal x
-- 100c = 268c, where naive float math gives 267c).
--
-- Pre-flight determination, called out per the design: the gallons
-- column was found to be numeric(8,3) - already numeric, NOT floating
-- point, so no float conversion was needed; it is widened to
-- numeric(10,3) here to match the contract's stated precision exactly.
--
-- Existing rows: a pre-F-053 row whose stored total disagrees with
-- gallons x price is backfilled with the difference as a LABELED
-- legacy adjustment (reason 'Legacy variance (pre-F-053)') BEFORE the
-- invariant is added, so every historical total the owner has seen is
-- preserved to the cent while every row satisfies the invariant
-- afterwards. Recomputing and overwriting legacy totals was rejected
-- (it would silently restate recorded fuel spend); leaving legacy
-- rows exempt was rejected (a permanent two-tier truth).

alter table fuel_purchases
  add column adjustment_cents integer not null default 0;

alter table fuel_purchases
  add column adjustment_reason text;

alter table fuel_purchases
  alter column gallons type numeric(10, 3);

-- A nonzero adjustment always carries its reason (the API mirrors
-- this in Zod; this CHECK is the floor every writer must clear).
alter table fuel_purchases
  add constraint fuel_purchases_adjustment_reason_required
  check (
    adjustment_cents = 0
    or (adjustment_reason is not null and btrim(adjustment_reason) <> '')
  );

-- Legacy backfill: explain the difference, never erase it.
update fuel_purchases
set adjustment_cents = total_cost_cents - round(gallons * price_per_gallon_cents)::integer,
    adjustment_reason = 'Legacy variance (pre-F-053)'
where total_cost_cents <> round(gallons * price_per_gallon_cents)::integer;

-- The invariant itself, valid immediately: after the backfill every
-- row satisfies it by construction.
alter table fuel_purchases
  add constraint fuel_purchases_total_is_derived
  check (
    total_cost_cents = round(gallons * price_per_gallon_cents)::integer + adjustment_cents
  );
