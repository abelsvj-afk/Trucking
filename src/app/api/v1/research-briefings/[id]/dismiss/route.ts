// Dismisses one research briefing (its soft-delete analog, same as
// industry_briefings' dismissed_at - excluded from the active list,
// never physically erased: briefings are an archive, per vision §3).

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import type { ResearchBriefing } from "@/types/entities";

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("research_briefings")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", ctx.params.id!)
    .is("dismissed_at", null)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw notFound();

  return NextResponse.json(data as ResearchBriefing);
});
