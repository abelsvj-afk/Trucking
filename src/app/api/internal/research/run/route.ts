// Deep Research Engine internal run endpoint (2026-11-02 design,
// D-1.1/D-1.2): the always-on invoker's door. Supabase pg_cron +
// pg_net calls this hourly (migration 00040 ships the guarded job
// setup; docs/runtime.md carries the runbook) so the engine ticks
// even while Fly machines sleep - the in-process interval alone only
// ever ran while the app was awake (audit §3 / F-020).
//
// Secret-authenticated (RESEARCH_RUN_CRON_SECRET), not
// session-authenticated - there is no user session for a database
// cron to hold, which is why proxy.ts carves /api/internal out as
// public and this route does its own check, mirroring the Stage-4
// industry-briefing run route. Deliberately absent from
// docs/api-contracts.md's resource list: no client ever calls this.

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runResearchTick } from "@/services/research/scheduler";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.RESEARCH_RUN_CRON_SECRET;
  if (!secret) return false; // fails closed - no configured secret means no caller can be verified

  const provided = request.headers.get("x-research-secret") ?? "";
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (secretBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(secretBuf, providedBuf);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    // Same generic-message discipline as every other route - no
    // detail about what was wrong with the provided secret.
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, { status: 401 });
  }

  try {
    const summary = await runResearchTick("endpoint");
    // CD-1 piggyback: the hourly invoker that wakes the research tick
    // also gives Abel's night shift its due-check, so consolidation
    // no longer depends on the app happening to be awake. A failure
    // here never fails the research tick's own answer.
    try {
      const { runConsolidationIfDue } = await import("@/services/bot/consolidation-scheduler");
      await runConsolidationIfDue();
    } catch (err) {
      console.error("[research] consolidation piggyback failed", err);
    }
    // Image Intelligence §5.6: the maintenance watcher's second
    // door - the same hourly invoker gives it its due-check, so
    // reminders don't depend on the app process staying awake.
    try {
      const { runMaintenanceWatchIfDue } = await import("@/services/fleet/maintenance-watch");
      await runMaintenanceWatchIfDue();
    } catch (err) {
      console.error("[research] maintenance watch piggyback failed", err);
    }
    // CD-7: a tick whose health carries an explicit failure (e.g. the
    // job database is not configured, so the engine never ran) must
    // not dress itself as "ok" - the HTTP contract stays 200 (the
    // invoker reached the app and the tick machinery answered), but
    // the body says "degraded" and health.failure says why.
    const status = summary.health?.failure ? "degraded" : "ok";
    return NextResponse.json({ status, tick: summary });
  } catch (err) {
    console.error("[research] internal run route failed", err);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
      { status: 500 },
    );
  }
}
