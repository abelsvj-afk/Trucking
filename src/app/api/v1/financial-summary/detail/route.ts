// GET /api/v1/financial-summary/detail?component=…&from&to
// (Reliability Unit C, task C3 - design C.3, finding F-010).
//
// The rows behind ONE component of the financial summary, so every
// total on the Money screen can be traced to the records that make
// it up. The filters come from the same shared module the summary
// uses (services/financial-summary/filter.ts) - the two endpoints
// cannot quietly use different months - and the read runs under the
// SAME snapshot mechanism as the summary (design condition 6: no
// quiet READ COMMITTED fallback). Inside the transaction the rows
// are reconciled against the component aggregate; a mismatch is the
// visible unverified state, never a rows list that disagrees with
// the total it claims to explain.
//
// The richer drill-down experience (cross-links, per-load grouping)
// is F-049, Wave 2 - this endpoint is the truthful contract it will
// build on.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError, validationError } from "@/services/api/errors";
import { resolveViewerTimeZone } from "@/lib/time";
import {
  componentWindow,
  isDateString,
  isSummaryComponent,
} from "@/services/financial-summary/filter";
import {
  readSummaryDetail,
  runSummarySnapshot,
  SummaryUnverifiedError,
} from "@/services/financial-summary/snapshot";

export const GET = createApiHandler(async (req, ctx) => {
  const url = new URL(req.url);
  const componentParam = url.searchParams.get("component");
  if (!isSummaryComponent(componentParam)) {
    throw validationError(
      "component must be one of: revenue, expenses, fuel, maintenance.",
    );
  }
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  if (!fromParam || !toParam || !isDateString(fromParam) || !isDateString(toParam)) {
    throw validationError("from and to must be dates in YYYY-MM-DD format.");
  }
  if (fromParam > toParam) throw validationError("from must not be after to.");

  const { timeZone } = resolveViewerTimeZone(url.searchParams.get("tz"));
  const range = { from: fromParam, to: toParam };
  const window = componentWindow(range, timeZone);

  let detail;
  try {
    detail = await runSummarySnapshot(ctx.auth, (q) =>
      readSummaryDetail(q, componentParam, window),
    );
  } catch (err) {
    if (err instanceof SummaryUnverifiedError) {
      throw new ApiError(
        503,
        "SUMMARY_UNVERIFIED",
        "Summary couldn't be verified — the detail rows did not reconcile inside a single snapshot, so nothing is shown rather than a wrong number. Try again.",
      );
    }
    throw err;
  }

  return NextResponse.json({
    component: componentParam,
    range,
    timeZone,
    total_cents: detail.total_cents,
    row_count: detail.row_count,
    rows: detail.rows,
  });
});
