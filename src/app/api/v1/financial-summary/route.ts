// Computed, read-only endpoint per docs/api-contracts.md - not backed by
// a table, so this doesn't use createCrudRoutes. Revenue draws from
// confirmed/completed, non-deleted loads; expenses/fuel/maintenance are
// summed separately so the client can show a breakdown, not just a net
// figure.
//
// All four source tables are fetched (date-filtered where the column is a
// plain `date`) and summed in application code rather than with a SQL
// aggregate - reasonable at this project's single-company MVP scale,
// matching the "no caching yet, revisit only if it's actually slow" stance
// docs/schemas.md already takes for this same endpoint.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10),
  };
}

// purchased_at is a timestamptz, not a plain date - comparing it with
// lte(to) would mean "midnight on `to`", silently excluding purchases made
// later that day. Using an exclusive upper bound of the day after `to`
// includes the whole day regardless of time-of-day.
function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function sumCents<K extends string>(rows: Record<K, number | null>[], field: K): number {
  return rows.reduce((total, row) => total + (row[field] ?? 0), 0);
}

export const GET = createApiHandler(async (req) => {
  const url = new URL(req.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  let from: string;
  let to: string;
  if (fromParam && toParam) {
    if (!DATE_RE.test(fromParam) || !DATE_RE.test(toParam)) {
      throw validationError("from and to must be dates in YYYY-MM-DD format.");
    }
    if (fromParam > toParam) throw validationError("from must not be after to.");
    from = fromParam;
    to = toParam;
  } else {
    ({ from, to } = currentMonthRange());
  }

  const supabase = await createClient();

  const [loadsResult, expensesResult, fuelResult, maintenanceResult] = await Promise.all([
    supabase
      .from("loads")
      .select("rate_cents, pickup_date, delivery_date")
      .in("status", ["confirmed", "completed"])
      .is("deleted_at", null),
    supabase
      .from("expenses")
      .select("amount_cents")
      .is("deleted_at", null)
      .gte("expense_date", from)
      .lte("expense_date", to),
    supabase
      .from("fuel_purchases")
      .select("total_cost_cents")
      .is("deleted_at", null)
      .gte("purchased_at", from)
      .lt("purchased_at", dayAfter(to)),
    supabase
      .from("maintenance_events")
      .select("cost_cents")
      .is("deleted_at", null)
      .gte("service_date", from)
      .lte("service_date", to),
  ]);

  for (const result of [loadsResult, expensesResult, fuelResult, maintenanceResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const loadsInRange = (
    (loadsResult.data ?? []) as { rate_cents: number | null; pickup_date: string | null; delivery_date: string | null }[]
  ).filter((load) => {
    const effectiveDate = load.delivery_date ?? load.pickup_date;
    return effectiveDate != null && effectiveDate >= from && effectiveDate <= to;
  });

  const revenue_cents = sumCents(loadsInRange, "rate_cents");
  const expenses_cents = sumCents(
    (expensesResult.data ?? []) as { amount_cents: number | null }[],
    "amount_cents",
  );
  const fuel_cents = sumCents(
    (fuelResult.data ?? []) as { total_cost_cents: number | null }[],
    "total_cost_cents",
  );
  const maintenance_cents = sumCents(
    (maintenanceResult.data ?? []) as { cost_cents: number | null }[],
    "cost_cents",
  );

  return NextResponse.json({
    range: { from, to },
    revenue_cents,
    expenses_cents,
    fuel_cents,
    maintenance_cents,
    net_cents: revenue_cents - expenses_cents - fuel_cents - maintenance_cents,
  });
});
