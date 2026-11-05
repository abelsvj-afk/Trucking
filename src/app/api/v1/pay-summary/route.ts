// GET /api/v1/pay-summary - expected vs. received pay per load, the active
// load's expected pay and hours cost, and the HOS glance (items 3-4).
import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { loadPaySummary } from "@/services/api/pay-summary";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  return NextResponse.json({ data: await loadPaySummary(supabase, ctx.auth.companyId) });
});
