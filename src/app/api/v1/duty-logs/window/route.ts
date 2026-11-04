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
import { createClient } from "@/services/db/server";
import { loadHosWindow } from "@/services/api/hos-window";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  // The one server-side HOS read (services/api/hos-window.ts).
  const snapshot = await loadHosWindow(supabase, ctx.auth.companyId, new Date());
  const { cycle, config, rows } = snapshot;
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
