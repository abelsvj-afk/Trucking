-- 00069 - Reliability Unit D (D3): the summary snapshot learns about fuel that is
-- assigned to a load (00068). Same function, same signature, two added keys:
--   assigned_fuel                    - every non-deleted load-assigned fuel purchase
--                                      (direct cost of that load, any date);
--   unassigned_fuel_in_period_cents  - the period's fuel assigned to no load.
-- Existing keys are unchanged, so older readers keep working.

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
    ),
    -- Unit D (00068): fuel the owner assigned to a load (any date) - direct costs
    -- of that load - and the period's fuel that is assigned to none.
    'assigned_fuel', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'load_id', load_id,
            'amount_cents', total_cost_cents,
            'purchased_at', purchased_at
          )
          order by created_at, id
        ),
        '[]'::jsonb
      )
      from fuel_purchases
      where deleted_at is null
        and load_id is not null
    ),
    'unassigned_fuel_in_period_cents', (
      select coalesce(sum(total_cost_cents), 0)
      from fuel_purchases
      where deleted_at is null
        and load_id is null
        and purchased_at >= p_from_ts
        and purchased_at < p_to_ts
    )
  );
$$;
