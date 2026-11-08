// GET /api/v1/financial-summary (Reliability Unit C - design C.2/C.3,
// findings F-008/F-010/F-033, ruling D-01).
//
// Revenue is OPERATIONAL LOAD REVENUE RECOGNIZED ON DELIVERY: a load
// counts when it is completed AND has a delivery_date, in the
// viewer-local month of that date. It is not cash received, not
// settled revenue, and not a tax figure - this system holds no invoice
// or settlement records, and no surface may word it as any of those
// (the C.3 labeling rule). Draft/confirmed loads are pipeline, shown
// separately and never added to revenue or net; completed loads with
// no delivery date are a surfaced exception, never silently dropped;
// cancelled loads are in neither figure.
//
// Every number comes from ONE database snapshot: the reads run inside
// a dedicated direct-connection transaction whose first statement is
// BEGIN ISOLATION LEVEL REPEATABLE READ, with the caller's RLS context
// re-established from the verified session (services/financial-
// summary/snapshot.ts). Totals are computed by SQL inside the
// snapshot and carry their row counts and record IDs; the in-snapshot
// count assertion must hold, or the answer is the visible
// SUMMARY_UNVERIFIED state - never a partial or blended total.
//
// Superseded here (kept honest in the design record): the previous
// implementation fetched the four tables through PostgREST and summed
// in application code with a pickup-date fallback - no snapshot, no
// counts, silent truncation exposure (F-033) and revenue attributed
// to the wrong month and the wrong event (F-008).

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError, validationError } from "@/services/api/errors";
import { resolveViewerTimeZone } from "@/lib/time";
import {
  componentWindow,
  isDateString,
  monthRangeInZone,
  type SummaryRange,
} from "@/services/financial-summary/filter";
import {
  readSummarySnapshot,
  runSummarySnapshot,
  SummaryUnverifiedError,
} from "@/services/financial-summary/snapshot";
import { computeSummaryMeasures } from "@/services/financial-summary/summary";
import { REVENUE_CONVENTION } from "@/types/financial-summary";
import { createClient } from "@/services/db/server";
import { fetchPayTerms } from "@/services/api/pay-terms";
import { totalEarnings } from "@/lib/load-earnings";

export const GET = createApiHandler(async (req, ctx) => {
  const url = new URL(req.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  // Unit B's plumbing, now consumed: the client carries the viewer's
  // zone; absent/invalid falls back to America/New_York, reported in
  // the response; the period bounds are computed in this zone (C1).
  const { timeZone } = resolveViewerTimeZone(url.searchParams.get("tz"));

  let range: SummaryRange;
  if (fromParam && toParam) {
    if (!isDateString(fromParam) || !isDateString(toParam)) {
      throw validationError("from and to must be dates in YYYY-MM-DD format.");
    }
    if (fromParam > toParam) throw validationError("from must not be after to.");
    range = { from: fromParam, to: toParam };
  } else if (fromParam || toParam) {
    throw validationError("from and to must be provided together.");
  } else {
    range = monthRangeInZone(timeZone, Date.now());
  }

  const window = componentWindow(range, timeZone);

  let data;
  try {
    data = await runSummarySnapshot(ctx.auth, (q) => readSummarySnapshot(q, window));
  } catch (err) {
    if (err instanceof SummaryUnverifiedError) {
      throw new ApiError(
        503,
        "SUMMARY_UNVERIFIED",
        "Summary couldn't be verified — the totals did not check out inside a single snapshot, so nothing is shown rather than a wrong number. Try again.",
      );
    }
    throw err;
  }

  const measures = computeSummaryMeasures(data, range, window);

  // Delivered loads whose rate is $0.00/missing count as $0 in the verified revenue above (that rule is unchanged and never
  // blended). Beside it, a SEPARATE estimate values those same loads from miles x the pay terms in force, labelled as an
  // estimate, so a lease-on month with no typed rates reads as what it earned instead of a bare zero. Best-effort: it never
  // blocks or alters the verified totals.
  let estimatedPay: { cents: number; loadCount: number; unvaluedCount: number } | null = null;
  try {
    const supabase = await createClient();
    const [{ data: delivered, error }, terms] = await Promise.all([
      supabase
        .from("loads")
        .select("id, origin, destination, status, miles, loaded_miles, deadhead_miles, pay_override_cents, rate_cents, pickup_date, delivery_date")
        .eq("company_id", ctx.auth.companyId)
        .eq("status", "completed")
        .is("deleted_at", null)
        .gte("delivery_date", range.from)
        .lte("delivery_date", range.to),
      fetchPayTerms(supabase, ctx.auth.companyId),
    ]);
    if (!error) {
      const unrated = ((delivered ?? []) as Parameters<typeof totalEarnings>[0]).filter((l) => !(l.rate_cents && l.rate_cents > 0));
      const t = totalEarnings(unrated, terms);
      if (unrated.length > 0) estimatedPay = { cents: t.estimatedCents, loadCount: t.estimatedCount, unvaluedCount: t.noValueCount };
    }
  } catch {
    estimatedPay = null;
  }
  const { revenue, expenses, fuel, maintenance } = data.components;

  return NextResponse.json({
    range,
    timeZone,
    revenueConvention: REVENUE_CONVENTION,
    revenue_cents: revenue.total_cents,
    expenses_cents: expenses.total_cents,
    fuel_cents: fuel.total_cents,
    maintenance_cents: maintenance.total_cents,
    net_cents: measures.periodOperatingResultCents,
    components: data.components,
    pipeline: data.pipeline,
    estimatedPay,
    exceptions: {
      completedMissingDeliveryDate: data.completedMissingDeliveryDate,
    },
    measures: {
      recognizedRevenue: measures.recognizedRevenueCents,
      periodOperatingResult: measures.periodOperatingResultCents,
      aggregateContributionMargin: measures.aggregateContributionMarginCents,
      // Unit D: the period's fuel assigned to no load (all of it until 00069 is applied).
      fuelNotAssigned: data.unassignedFuelInPeriodCents ?? fuel.total_cents,
    },
  });
});
