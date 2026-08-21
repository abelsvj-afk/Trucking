// Task 4.3 (TASKS.md), per docs/runtime.md's refined design. Wakes up on
// a short, frequent check-in cadence (not the actual briefing interval -
// see run-industry-briefing.ts's getEligibleCompanies for why) and lets
// the database decide whether any company is actually due for a run.

import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import { OpenAiProvider } from "./providers/openai";
import { runIndustryBriefingJob, DEFAULT_INTERVAL_MS } from "./run-industry-briefing";

const CHECK_IN_MS = 60 * 60 * 1000; // hourly - frequent enough that a restart never delays a due run by more than ~an hour, infrequent enough to cost nothing.

let started = false;

async function tick(): Promise<void> {
  try {
    const pool = getIndustryBriefingPool();
    const provider = new OpenAiProvider();
    const intervalMs = Number(process.env.INDUSTRY_BRIEFING_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
    await runIndustryBriefingJob(pool, provider, intervalMs);
  } catch (err) {
    // getIndustryBriefingPool()/new OpenAiProvider() throw synchronously
    // when their required env vars aren't set - routine during local dev
    // (this capability is off by default and most environments won't have
    // these configured), not a crash-worthy error for the whole server.
    console.error("[industry-briefing] scheduler tick failed to start", err);
  }
}

/** Idempotent - safe to call more than once (e.g. if instrumentation.ts's register() ever runs more than once in some runtime). */
export function startIndustryBriefingScheduler(): void {
  if (started) return;
  started = true;

  setInterval(() => void tick(), CHECK_IN_MS);
  void tick();
}
