// GAP-16 (Fresh-Eyes Register 2026-11-02): the year-end tax packet
// (?year=2026; defaults to the current year, ET) — per-diem days at
// the labeled rate, fuel totals, expenses by category, load
// revenue: what his preparer actually asks for, assembled from his
// own records.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { getTaxPacket } from "@/services/tax-filings";
import { easternDate } from "@/lib/day-wrap";

export const GET = createApiHandler(async (req: NextRequest, { auth }) => {
  const supabase = await createClient();
  const param = new URL(req.url).searchParams.get("year");
  const year =
    param && /^\d{4}$/.test(param) ? Number(param) : Number(easternDate(new Date()).slice(0, 4));
  const packet = await getTaxPacket(supabase, auth.companyId, year);
  return NextResponse.json({ data: packet });
});
