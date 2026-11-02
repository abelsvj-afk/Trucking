// GAP-08 (Fresh-Eyes Register 2026-11-02): the day-wrap — one
// reconciliation pass over the day's records. ?date=YYYY-MM-DD
// (America/New_York); defaults to today ET.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { getDayWrap } from "@/services/day-wrap";
import { easternDate } from "@/lib/day-wrap";

export const GET = createApiHandler(async (req: NextRequest, { auth }) => {
  const supabase = await createClient();
  const dateParam = new URL(req.url).searchParams.get("date");
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : easternDate(new Date());
  const result = await getDayWrap(supabase, auth.companyId, date);
  return NextResponse.json({ data: result });
});
