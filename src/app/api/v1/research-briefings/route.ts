// Deep Research Engine (docs/design/research-engine.md §5), per
// docs/api-contracts.md. The owner's read surface for the engine:
// briefings (newest first, dismissed excluded), the unread count, the
// recent run log, watcher health, and run-cap usage. No POST here -
// creating a briefing is the engine's job; the owner's one write is
// the fenced manual queue insert in ./research-now/route.ts.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { getResearchConfig } from "@/services/research/config";
import type { ResearchBriefing, ResearchRun, ResearchWatcherState } from "@/types/entities";

const RECENT_RUNS_TO_SHOW = 10;

export const GET = createApiHandler(async () => {
  const supabase = await createClient();
  const config = getResearchConfig();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [briefingsResult, unreadResult, runsResult, watchersResult, todayResult, monthResult] =
    await Promise.all([
      supabase
        .from("research_briefings")
        .select("*")
        .is("dismissed_at", null)
        .order("created_at", { ascending: false }),
      supabase
        .from("research_briefings")
        .select("id", { count: "exact", head: true })
        .is("dismissed_at", null)
        .is("read_at", null),
      supabase
        .from("research_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(RECENT_RUNS_TO_SHOW),
      supabase.from("research_watcher_state").select("*").order("watcher_key", { ascending: true }),
      supabase
        .from("research_runs")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "running", "success", "failure", "insufficient_data"])
        .gte("created_at", dayAgo),
      supabase
        .from("research_runs")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "running", "success", "failure", "insufficient_data"])
        .gte("created_at", monthAgo),
    ]);

  for (const result of [briefingsResult, unreadResult, runsResult, watchersResult, todayResult, monthResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  return NextResponse.json({
    data: (briefingsResult.data ?? []) as ResearchBriefing[],
    unread_count: unreadResult.count ?? 0,
    runs: (runsResult.data ?? []) as ResearchRun[],
    watchers: (watchersResult.data ?? []) as ResearchWatcherState[],
    usage: {
      runs_today: todayResult.count ?? 0,
      runs_this_month: monthResult.count ?? 0,
      max_runs_per_day: config.maxRunsPerDay,
      max_runs_per_month: config.maxRunsPerMonth,
    },
  });
});
