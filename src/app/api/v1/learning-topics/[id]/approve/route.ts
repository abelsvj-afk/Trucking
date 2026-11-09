// Approves one PROPOSED learning-agenda topic (docs/design/
// autonomous-research.md §4): queues a manual Deep Research run -
// the same fenced insert shape the research-now route writes
// (migration 00019) - and marks the topic queued with that run's id.
// The engine's tick executes it under its normal caps; the runner
// settles the topic to 'done' when the run finishes. This route
// never calls the AI provider itself.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { researchNowSchema } from "@/data/schemas/research";
import type { LearningTopic } from "@/types/entities";

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const id = ctx.params.id!;

  const { data: topic, error: readError } = await supabase
    .from("research_learning_topics")
    .select("*")
    .eq("id", id)
    .eq("status", "proposed")
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!topic) throw notFound();

  const row = topic as LearningTopic;
  researchNowSchema.parse({ topic: row.topic });

  const { data: run, error: runError } = await supabase
    .from("research_runs")
    .insert({
      company_id: ctx.auth.companyId,
      trigger_kind: "manual",
      topic: row.topic,
      trigger_detail: {
        reason: row.reason || "Owner approved Abel's proposed learning topic.",
        learning_topic_id: row.id,
      },
      status: "queued",
    })
    .select("id")
    .single();
  if (runError) throw new Error(runError.message);

  const { data, error } = await supabase
    .from("research_learning_topics")
    .update({
      status: "queued",
      research_run_id: (run as { id: string }).id,
      decided_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "proposed")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound();

  return NextResponse.json(data as LearningTopic);
});
