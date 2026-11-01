// Marks one research briefing read (clears its unread state on the
// Research page). Same shape as the industry-briefings dismiss route:
// an update through the owner's session, RLS-scoped to his company -
// a briefing that isn't his is indistinguishable from a missing one
// (404, per docs/api-contracts.md).

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import type { ResearchBriefing } from "@/types/entities";

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("research_briefings")
    .update({ read_at: new Date().toISOString() })
    .eq("id", ctx.params.id!)
    .is("read_at", null)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw notFound();

  return NextResponse.json(data as ResearchBriefing);
});
