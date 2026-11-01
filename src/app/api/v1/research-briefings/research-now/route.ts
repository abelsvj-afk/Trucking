// Deep Research Engine manual trigger (docs/design/research-
// engine.md §6): the owner's "research this now". The ONLY client-side
// insert into the engine's tables - it queues a run row (manual /
// queued, fenced by migration 00019's RLS policy to exactly that
// shape) and the engine's scheduler tick executes it under the same
// caps and kill switch as every other run. This route never calls the
// AI provider itself.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { researchNowSchema } from "@/data/schemas/research";
import type { ResearchRun } from "@/types/entities";

export const POST = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, researchNowSchema);

  const { data, error } = await supabase
    .from("research_runs")
    .insert({
      company_id: ctx.auth.companyId,
      trigger_kind: "manual",
      topic: body.topic,
      trigger_detail: { reason: "Owner requested this research from the app." },
      status: "queued",
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  return NextResponse.json(data as ResearchRun, { status: 201 });
});
