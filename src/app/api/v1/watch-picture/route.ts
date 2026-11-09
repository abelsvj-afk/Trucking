// Autonomous Research (docs/design/autonomous-research.md): the
// owner's read surface for the standing watch - what Abel is
// watching, how fresh each picture is, the newest stored knowledge,
// and the learning agenda's open rows. Owner session + RLS fences
// the company, exactly like the research-briefings route. On a
// database where migration 00084 hasn't landed, the route answers
// available:false (HTTP 200) instead of erroring - the Research page
// renders one honest line, never a broken panel.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import {
  knowledgeFreshness,
  WATCH_TOPIC_DEFS,
  WATCH_TOPICS,
  type WatchTopic,
} from "@/lib/watch-topics";
import type {
  LearningTopic,
  ResearchKnowledge,
  WatchPictureData,
} from "@/types/entities";

function isMissingTable(message: string): boolean {
  return (
    /research_knowledge|research_learning_topics/.test(message) &&
    /does not exist|could not find/i.test(message)
  );
}

export const GET = createApiHandler(async () => {
  const supabase = await createClient();

  const [knowledgeResult, topicsResult] = await Promise.all([
    supabase
      .from("research_knowledge")
      .select("watch_topic, title, content, source_title, source_url, observed_at")
      .order("observed_at", { ascending: false })
      .limit(50),
    supabase
      .from("research_learning_topics")
      .select("id, topic, reason, watch_topic, proposed_by, status, research_run_id, created_at, decided_at")
      .in("status", ["proposed", "queued"])
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const missing = [knowledgeResult.error, topicsResult.error].find(
    (e) => e && isMissingTable(e.message),
  );
  if (missing) {
    const empty: WatchPictureData = { available: false, topics: [], knowledge: [], learning_topics: [] };
    return NextResponse.json(empty);
  }
  if (knowledgeResult.error) throw new Error(knowledgeResult.error.message);
  if (topicsResult.error) throw new Error(topicsResult.error.message);

  const knowledge = (knowledgeResult.data ?? []) as ResearchKnowledge[];
  const now = new Date();
  const latestByTopic = new Map<string, ResearchKnowledge>();
  for (const row of knowledge) {
    if (!latestByTopic.has(row.watch_topic)) latestByTopic.set(row.watch_topic, row);
  }

  const data: WatchPictureData = {
    available: true,
    topics: WATCH_TOPICS.map((key: WatchTopic) => {
      const def = WATCH_TOPIC_DEFS[key];
      const latest = latestByTopic.get(key) ?? null;
      return {
        key,
        label: def.label,
        why: def.why,
        freshness: knowledgeFreshness(key, latest?.observed_at ?? null, now).label,
        latest,
      };
    }),
    knowledge: knowledge.slice(0, 20),
    learning_topics: (topicsResult.data ?? []) as LearningTopic[],
  };
  return NextResponse.json(data);
});
