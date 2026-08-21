// Task 4.3 (TASKS.md), per docs/runtime.md: an operational debug
// convenience for forcing an industry-intelligence run without waiting
// for the schedule - NOT part of the scheduling mechanism itself (that's
// the in-process scheduler, services/ai/scheduler.ts) and deliberately
// absent from docs/api-contracts.md's resource list, since no client ever
// calls this. Secret-authenticated (INDUSTRY_BRIEFING_CRON_SECRET), not
// session-authenticated - there's no user session for this to check
// against, which is also why proxy.ts carves /api/internal out as public
// and relies on this route's own check instead.

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { runIndustryBriefingJob } from "@/services/ai/run-industry-briefing";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.INDUSTRY_BRIEFING_CRON_SECRET;
  if (!secret) return false; // fails closed - no configured secret means no caller can be verified, per CLAUDE.md

  const provided = request.headers.get("x-industry-briefing-secret") ?? "";
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (secretBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(secretBuf, providedBuf);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    // Same generic-message discipline as every other route (CLAUDE.md) -
    // no detail about what was wrong with the provided secret.
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, { status: 401 });
  }

  try {
    const pool = getIndustryBriefingPool();
    const provider = new OpenAiProvider();
    // intervalMs=0 deliberately bypasses the rate-limit gate - forcing a
    // run on demand is the entire point of this debug route.
    await runIndustryBriefingJob(pool, provider, 0);
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[industry-briefing] manual-trigger route failed", err);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
      { status: 500 },
    );
  }
}
