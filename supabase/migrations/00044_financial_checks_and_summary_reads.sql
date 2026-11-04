-- Financial invariants at the database boundary + the summary's
-- snapshot read SQL (Reliability & Completion Program, Unit C -
-- docs/reliability-wave1-design-package.md C.5/C.3, findings F-026
-- and F-033).
--
-- PART 1 - F-026 CHECK constraints, added NOT VALID.
-- These mirror the Zod rules the API has always enforced
-- (src/data/schemas/loads.ts, expenses.ts). Zod stays for error
-- quality; these constraints are the floor every writer must clear,
-- including writers that never pass through the API. Column names
-- confirmed at pre-flight against 00003: loads.rate_cents (integer,
-- nullable), loads.miles (integer, nullable), expenses.amount_cents
-- (integer, not null). Fuel's non-negatives are subsumed by 00043's
-- invariant. loads.status was also confirmed at pre-flight to carry
-- NO database CHECK (plain text since 00003), so the D-01 `cancelled`
-- value needs no amendment here - it is a Zod/UI value change only.
--
-- APPLICATION PROCEDURE (deliberate - do not improvise at apply
-- time): the constraints below are added NOT VALID so this migration
-- can never fail on legacy data and never silently rewrites it. The
-- owner-run application step then completes C.5's safe pattern:
--   1. Run the violator scans (below) and REPORT the counts + IDs to
--      the program checklist - bad legacy data is a finding, not
--      something to delete quietly.
--   2. Correct each offending row through the app's own edit UI
--      (Unit A), or except it by explicit owner decision.
--   3. Run the VALIDATE statements (below). If a violator will not be
--      corrected, the constraint stays NOT VALID and F-026 stays
--      open - the design refuses to fake closure.
--
-- Violator scans:
--   select id, rate_cents from loads where rate_cents < 0;
--   select id, miles from loads where miles < 0;
--   select id, pickup_date, delivery_date from loads
--     where delivery_date is not null and pickup_date is not null
--       and delivery_date < pickup_date;
--   select id, amount_cents from expenses where amount_cents < 0;
--
-- Validation (after step 2 reports zero violators):
--   alter table loads validate constraint loads_rate_cents_nonnegative;
--   alter table loads validate constraint loads_miles_nonnegative;
--   alter table loads validate constraint loads_delivery_not_before_pickup;
--   alter table expenses validate constraint expenses_amount_cents_nonnegative;

alter table loads
  add constraint loads_rate_cents_nonnegative
  check (rate_cents >= 0) not valid;

alter table loads
  add constraint loads_miles_nonnegative
  check (miles >= 0) not valid;

alter table loads
  add constraint loads_delivery_not_before_pickup
  check (delivery_date is null or pickup_date is null or delivery_date >= pickup_date) not valid;

alter table expenses
  add constraint expenses_amount_cents_nonnegative
  check (amount_cents >= 0) not valid;

-- PART 2 - the summary's read logic (C.3 Rev 6 / task C6).
-- These functions are READ LOGIC ONLY. They claim nothing about
-- isolation: the snapshot property comes from the caller's dedicated
-- transaction, whose first statement is BEGIN ISOLATION LEVEL
-- REPEATABLE READ (src/services/financial-summary/snapshot.ts). They
-- are SECURITY INVOKER (the Postgres default - deliberately NOT
-- security definer): executed inside that transaction under
-- SET LOCAL ROLE authenticated with the caller's verified JWT claims,
-- the existing tenant-isolation RLS policies evaluate exactly as they
-- do on the PostgREST path. Converting either function to SECURITY
-- DEFINER would bypass RLS and break the design's tenant guarantee.
--
-- The filters below are the single SQL expression of the shared
-- filter module (src/services/financial-summary/filter.ts): revenue
-- is recognized on delivery (completed + delivery_date in range),
-- costs are incurred-in-period, fuel's timestamptz uses the
-- viewer-local-midnight window [p_from_ts, p_to_ts) the module
-- computes. Deterministic (created_at, id) ordering governs every
-- ID list and detail read.

create or replace function public.financial_summary_snapshot(
  p_from date,
  p_to date,
  p_from_ts timestamptz,
  p_to_ts timestamptz
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'revenue', (
      select jsonb_build_object(
        'total_cents', coalesce(sum(rate_cents), 0),
        'row_count', count(*),
        'record_ids', coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      )
      from loads
      where deleted_at is null
        and status = 'completed'
        and delivery_date is not null
        and delivery_date >= p_from
        and delivery_date <= p_to
    ),
    'expenses', (
      select jsonb_build_object(
        'total_cents', coalesce(sum(amount_cents), 0),
        'row_count', count(*),
        'record_ids', coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      )
      from expenses
      where deleted_at is null
        and expense_date >= p_from
        and expense_date <= p_to
    ),
    'fuel', (
      select jsonb_build_object(
        'total_cents', coalesce(sum(total_cost_cents), 0),
        'row_count', count(*),
        'record_ids', coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      )
      from fuel_purchases
      where deleted_at is null
        and purchased_at >= p_from_ts
        and purchased_at < p_to_ts
    ),
    'maintenance', (
      select jsonb_build_object(
        'total_cents', coalesce(sum(cost_cents), 0),
        'row_count', count(*),
        'record_ids', coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      )
      from maintenance_events
      where deleted_at is null
        and service_date >= p_from
        and service_date <= p_to
    ),
    'pipeline', (
      select jsonb_build_object(
        'total_cents', coalesce(sum(rate_cents), 0),
        'row_count', count(*),
        'record_ids', coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb),
        'loads_without_rate_count', count(*) filter (where rate_cents is null)
      )
      from loads
      where deleted_at is null
        and status in ('draft', 'confirmed')
    ),
    'completed_missing_delivery_date', (
      select jsonb_build_object(
        'count', count(*),
        'record_ids', coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      )
      from loads
      where deleted_at is null
        and status = 'completed'
        and delivery_date is null
    ),
    'assigned_expenses', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'load_id', load_id,
            'amount_cents', amount_cents,
            'expense_date', expense_date
          )
          order by created_at, id
        ),
        '[]'::jsonb
      )
      from expenses
      where deleted_at is null
        and load_id is not null
    ),
    'unassigned_expenses_in_period_cents', (
      select coalesce(sum(amount_cents), 0)
      from expenses
      where deleted_at is null
        and load_id is null
        and expense_date >= p_from
        and expense_date <= p_to
    )
  );
$$;

create or replace function public.financial_summary_detail(
  p_component text,
  p_from date,
  p_to date,
  p_from_ts timestamptz,
  p_to_ts timestamptz
)
returns setof jsonb
language plpgsql
stable
as $$
begin
  if p_component = 'revenue' then
    return query
      select to_jsonb(x)
      from loads x
      where x.deleted_at is null
        and x.status = 'completed'
        and x.delivery_date is not null
        and x.delivery_date >= p_from
        and x.delivery_date <= p_to
      order by x.created_at, x.id;
  elsif p_component = 'expenses' then
    return query
      select to_jsonb(x)
      from expenses x
      where x.deleted_at is null
        and x.expense_date >= p_from
        and x.expense_date <= p_to
      order by x.created_at, x.id;
  elsif p_component = 'fuel' then
    return query
      select to_jsonb(x)
      from fuel_purchases x
      where x.deleted_at is null
        and x.purchased_at >= p_from_ts
        and x.purchased_at < p_to_ts
      order by x.created_at, x.id;
  elsif p_component = 'maintenance' then
    return query
      select to_jsonb(x)
      from maintenance_events x
      where x.deleted_at is null
        and x.service_date >= p_from
        and x.service_date <= p_to
      order by x.created_at, x.id;
  else
    raise exception 'unknown financial summary component: %', p_component;
  end if;
end;
$$;
