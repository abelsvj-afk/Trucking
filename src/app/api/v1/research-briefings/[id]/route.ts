// One research briefing by id (Home News Banner design §6.4): the
// deep-link fallback for a banner tap whose briefing is no longer
// in the list response - the realistic case is he dismissed it
// earlier (the list excludes dismissed). Returns the briefing
// INCLUDING dismissed ones, through the owner's session, so RLS
// scopes it to his company: another company's briefing is
// indistinguishable from a missing one (404).

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import type { ResearchBriefing } from "@/types/entities";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("research_briefings")
    .select("*")
    .eq("id", ctx.params.id!)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw notFound();

  return NextResponse.json(data as ResearchBriefing);
});
