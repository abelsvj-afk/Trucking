// Task 4.5 (TASKS.md), per docs/api-contracts.md: "the delete analog for
// this resource" - sets dismissed_at instead of a generic DELETE, since
// docs/schemas.md's industry_briefings uses dismissed_at as its own
// soft-delete-equivalent field.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import type { IndustryBriefing } from "@/types/entities";

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("industry_briefings")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", ctx.params.id!)
    .is("dismissed_at", null)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw notFound();

  return NextResponse.json(data as IndustryBriefing);
});
