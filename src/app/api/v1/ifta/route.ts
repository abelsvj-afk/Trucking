// GAP-15 (Fresh-Eyes Register 2026-11-02): the IFTA worksheet for
// a quarter (?quarter=2026Q4; defaults to the current quarter, ET).
// Gallons by state are exact from the records; interstate miles
// are reported unallocated rather than split by a guessed formula
// (see src/lib/ifta.ts for the honesty rules).

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { getIftaWorksheet } from "@/services/tax-filings";
import { quarterOf } from "@/lib/ifta";
import { easternDate } from "@/lib/day-wrap";

export const GET = createApiHandler(async (req: NextRequest, { auth }) => {
  const supabase = await createClient();
  const param = new URL(req.url).searchParams.get("quarter");
  const quarter = param && /^\d{4}Q[1-4]$/.test(param) ? param : quarterOf(easternDate(new Date()));
  const worksheet = await getIftaWorksheet(supabase, auth.companyId, quarter);
  return NextResponse.json({ data: worksheet });
});
