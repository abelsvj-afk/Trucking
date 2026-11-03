// GET /api/v1/duty-logs/window (Reliability Unit B - design B.2.4,
// F-013). The HOS summary's dedicated data path, replacing the generic
// newest-first list page the summary used to be computed from (200-row
// cap, created_at order): that path silently truncated exactly the
// oldest history the cycle depends on.
//
// Returns every non-deleted duty log in the calculation window - from
// the carrier-anchored period (cycle periods + 2) before the current
// period through now - in started_at ASCENDING order (the order the
// HOS engines consume), plus the server-computed cycle summary and
// the window actually used, so the surface can state its own basis.
//
// The fetch is capped at 5000 rows as a tripwire: a window that full
// is a data anomaly, and the endpoint fails explicitly (500) rather
// than ever returning a partial window that would understate hours.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { loadHosConfig } from "@/services/api/hos-config";
import { hosCalculationWindowStartMs } from "@/lib/hos-periods";
import { summarizeHosCycle } from "@/lib/hos-cycle";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

const WINDOW_ROW_LIMIT = 5000;

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const { config } = await loadHosConfig(supabase, ctx.auth.companyId);

  const now = new Date();
  const windowStart = new Date(hosCalculationWindowStartMs(now.getTime(), config));

  const { data, error } = await supabase
    .from("duty_logs")
    .select("*")
    .eq("company_id", ctx.auth.companyId)
    .is("deleted_at", null)
    .gte("started_at", windowStart.toISOString())
    .order("started_at", { ascending: true })
    .limit(WINDOW_ROW_LIMIT + 1);

  if (error) {
    throw new ApiError(500, "HOS_WINDOW_UNAVAILABLE", "The HOS duty-log window could not be loaded.");
  }

  const rows = data ?? [];
  if (rows.length > WINDOW_ROW_LIMIT) {
    throw new ApiError(
      500,
      "HOS_WINDOW_TOO_LARGE",
      `The HOS window holds more than ${WINDOW_ROW_LIMIT} duty logs; the summary cannot be computed completely, so nothing is shown rather than a partial total.`,
    );
  }

  const cycle = summarizeHosCycle(rows, now, config);
  const hos: DutyLogWindowSummary = {
    cycle: cycle.cycle,
    cycleLimitMinutes: cycle.cycleLimitMinutes,
    periodAnchor: cycle.periodAnchor,
    restartEnabled: config.restartEnabled,
    carrierTimeZone: cycle.carrierTimeZone,
    windowStart: cycle.windowStart,
    windowEnd: cycle.windowEnd,
    currentPeriodStart: cycle.currentPeriodStart,
    onDutyMinutesInCycle: cycle.onDutyMinutesInCycle,
    restartApplied: cycle.restartApplied,
    restartUnverified: cycle.restartUnverified,
    warnings: cycle.warnings,
  };

  return NextResponse.json({ data: rows, hos });
});
