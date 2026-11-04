// GET /api/v1/paper-logs/{documentId} - the review payload: the photo,
// everything the reader returned (as an editable day with every hole
// explicit), the sheet's written totals, and the rows already in that
// day. 404 for a missing or other-company sheet.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { loadHosConfig } from "@/services/api/hos-config";
import { buildPaperLogReview } from "@/services/fleet/paper-log-review";

export const GET = createApiHandler(async (_req, ctx) => {
  const id = z.string().uuid().safeParse(ctx.params.id);
  if (!id.success) throw notFound();
  const supabase = await createClient();
  const { config } = await loadHosConfig(supabase, ctx.auth.companyId);
  const review = await buildPaperLogReview(supabase, ctx.auth.companyId, id.data, config.carrierTimeZone);
  if (!review) throw notFound();
  return NextResponse.json({ data: review });
});
