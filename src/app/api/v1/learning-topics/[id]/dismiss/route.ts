// Dismisses one PROPOSED learning-agenda topic (docs/design/
// autonomous-research.md §4): the owner's no. The row is kept
// (status 'dismissed', decided_at stamped) so the agenda pass can
// see the topic was declined and the record of what Abel proposed -
// and what he said no to - stays honest.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import type { LearningTopic } from "@/types/entities";

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("research_learning_topics")
    .update({ status: "dismissed", decided_at: new Date().toISOString() })
    .eq("id", ctx.params.id!)
    .eq("status", "proposed")
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw notFound();

  return NextResponse.json(data as LearningTopic);
});
