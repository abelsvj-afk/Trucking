// GAP-14 (Fresh-Eyes Register 2026-11-02): a broker's working
// scorecard — loads run, real days-to-pay, detention raised,
// money still outstanding. Computed from records, never entered.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { notFound } from "@/services/api/errors";
import { getBrokerScorecard } from "@/services/broker-scorecard";

export const GET = createApiHandler(async (_req: NextRequest, { auth, params }) => {
  const supabase = await createClient();
  const card = await getBrokerScorecard(supabase, auth.companyId, params.id as string);
  if (!card) throw notFound();
  return NextResponse.json({ data: card });
});
