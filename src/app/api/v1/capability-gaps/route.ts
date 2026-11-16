// Abel's "can't do that yet" list (docs/design/abel-do-what-i-ask.md section 1). Session-authenticated owner
// requests: GET lists the open asks, DELETE marks one dismissed ("drop it"). Before migration 00096 is applied
// the table is missing; GET then says so plainly instead of failing the page.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { dismissCapabilityGap, listOpenCapabilityGaps } from "@/services/bot/capability-gaps";

const dismissSchema = z.object({ id: z.string().uuid() });

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  try {
    const gaps = await listOpenCapabilityGaps(supabase, ctx.auth.companyId);
    return NextResponse.json({ data: gaps, ready: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/abel_capability_gaps|does not exist|schema cache/i.test(message)) {
      return NextResponse.json({ data: [], ready: false });
    }
    throw err;
  }
});

export const DELETE = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, dismissSchema);
  await dismissCapabilityGap(supabase, ctx.auth.companyId, body.id);
  return NextResponse.json({ data: { id: body.id, dismissed: true } });
});
