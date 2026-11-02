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
    return NextResponse.json({ status: "ok", tick: summary });
  } catch (err) {
    console.error("[research] internal run route failed", err);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
      { status: 500 },
    );
  }
}
