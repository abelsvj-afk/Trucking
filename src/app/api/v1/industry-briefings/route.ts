// Task 4.5 (TASKS.md), per docs/api-contracts.md. No POST here - the
// client never creates an industry briefing directly (docs/automation.md:
// only the scheduled job's scoped credential writes industry_briefings),
// so this doesn't use createCrudRoutes. Runs through the normal
// authenticated owner session (anon key + RLS), unlike the scheduled
// job's own separate scoped credential (services/db/industry-briefing-pool.ts).

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import type { IndustryBriefing } from "@/types/entities";
import type { ServiceStatus } from "@/types/service-status";

// docs/automation.md leaves the exact escalation threshold as an
// implementation-time tuning decision, using "e.g. 3" as its own example -
// used verbatim here.
const ESCALATION_THRESHOLD = 3;
const RECENT_RUNS_TO_CHECK = 10;

interface RunRow {
  started_at: string;
  status: "success" | "failure" | "insufficient_data";
}

function computeServiceStatus(runs: RunRow[]): ServiceStatus {
  if (runs.length === 0) {
    return { consecutive_failures: 0, escalated: false, last_run_at: null };
  }

  let consecutiveFailures = 0;
  for (const run of runs) {
    if (run.status !== "failure") break;
    consecutiveFailures += 1;
  }

  return {
    consecutive_failures: consecutiveFailures,
    escalated: consecutiveFailures >= ESCALATION_THRESHOLD,
    last_run_at: runs[0]?.started_at ?? null,
  };
}

export const GET = createApiHandler(async () => {
  const supabase = await createClient();

  const [briefingsResult, runsResult] = await Promise.all([
    supabase
      .from("industry_briefings")
      .select("*")
      .is("dismissed_at", null)
      .order("generated_at", { ascending: false }),
    supabase
      .from("industry_briefing_runs")
      .select("started_at, status")
      .order("started_at", { ascending: false })
      .limit(RECENT_RUNS_TO_CHECK),
  ]);

  if (briefingsResult.error) throw new Error(briefingsResult.error.message);
  if (runsResult.error) throw new Error(runsResult.error.message);

  return NextResponse.json({
    data: (briefingsResult.data ?? []) as IndustryBriefing[],
    service_status: computeServiceStatus((runsResult.data ?? []) as RunRow[]),
  });
});
