// Check the wires now (Home News Banner design §4): the banner's
// light pull. Polls every watcher once, in this app-server process,
// through the job pool - free sources only, NO AI call, NO run-cap
// spend. Fresh signals land in research_signals and surface as the
// banner's Watching items; if the pressure later converges, the
// normal tick turns it into a briefing through the usual path.
//
// Checks, in the design's order: (1) deep_research capability on,
// else refuse plainly; (2) 30-minute cooldown from the newest
// watcher poll; (3) the tick's advisory lock, taken non-blocking -
// a tick mid-run means "busy", never a double poll; (4) poll.
// Every outcome is an honest state in the body - including
// `unavailable` (HTTP 200) when the job database URL is unset, the
// CD-7 pattern: Home never gets a 500 for an engine that simply
// isn't wired up yet.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import { RESEARCH_TICK_LOCK_KEY } from "@/services/research/scheduler";
import { pollAllWatchers } from "@/services/research/watchers";
import type { CheckWiresResult } from "@/types/entities";
import { isDeepResearchEnabled } from "../capability";

const COOLDOWN_MINUTES = 30;

// The dedicated-connection shape for the advisory lock, mirroring
// scheduler.ts (pg's connect() overloads don't type-narrow cleanly).
interface PoolClient {
  query: Queryable["query"];
  release: () => void;
}

interface ConnectablePool {
  connect: () => Promise<PoolClient>;
}

function result(body: CheckWiresResult) {
  return NextResponse.json(body);
}

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  // (1) Capability - the same fail-closed check the banner's
  // engine_enabled flag uses. Off is a plain refusal, not a state:
  // the button is unreachable in the UI when the engine is off.
  const enabled = await isDeepResearchEnabled(supabase, ctx.auth.companyId);
  if (!enabled) {
    throw new ApiError(
      403,
      "CAPABILITY_DISABLED",
      "Deep research is off - turn it on in Account & settings to check the wires.",
    );
  }

  // (2) Cooldown - the newest watcher poll across all watchers. A
  // fresh poll means the stored set IS the current set; answer with
  // when it was checked instead of polling again.
  const { data: watcherRows, error: watcherError } = await supabase
    .from("research_watcher_state")
    .select("last_polled_at");
  if (watcherError) throw new Error(watcherError.message);

  const pollTimes = ((watcherRows ?? []) as Array<{ last_polled_at: string | null }>)
    .map((row) => row.last_polled_at)
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  const newestPoll = pollTimes.length > 0 ? Math.max(...pollTimes) : null;
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  if (newestPoll !== null && Date.now() - newestPoll < cooldownMs) {
    const remainingMs = cooldownMs - (Date.now() - newestPoll);
    return result({
      state: "cooldown",
      available: true,
      new_signals: 0,
      checked_at: new Date(newestPoll).toISOString(),
      next_check_in_minutes: Math.max(1, Math.ceil(remainingMs / 60000)),
      reason: null,
    });
  }

  // The job pool is the only way to poll (watchers persist through
  // the scoped job credential). Unset URL = the engine isn't wired
  // up in this deployment yet - say so in the body, CD-7 style.
  let pool: ReturnType<typeof getIndustryBriefingPool>;
  try {
    pool = getIndustryBriefingPool();
  } catch (err) {
    console.error("[research] check-wires: job pool unavailable", err);
    return result({
      state: "unavailable",
      available: false,
      new_signals: 0,
      checked_at: null,
      next_check_in_minutes: null,
      reason:
        "The wires can't be checked yet - the research runner isn't fully set up in this deployment.",
    });
  }

  // (3) The tick's advisory lock, non-blocking, on a dedicated
  // connection (session locks die with the connection - same
  // discipline as runResearchTick).
  let client: PoolClient | null = null;
  try {
    client = await (pool as unknown as ConnectablePool).connect();
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [RESEARCH_TICK_LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      return result({
        state: "busy",
        available: true,
        new_signals: 0,
        checked_at: null,
        next_check_in_minutes: null,
        reason: "The engine is mid-check - give it a moment.",
      });
    }

    try {
      // (4) Poll. Watchers handle their own errors into visible
      // state rows; a throw here is a database-level failure.
      const fresh = await pollAllWatchers(pool);
      return result({
        state: fresh.length > 0 ? "fresh" : "quiet",
        available: true,
        new_signals: fresh.length,
        checked_at: new Date().toISOString(),
        next_check_in_minutes: null,
        reason: null,
      });
    } finally {
      await client
        .query("select pg_advisory_unlock($1)", [RESEARCH_TICK_LOCK_KEY])
        .catch(() => undefined);
    }
  } catch (err) {
    console.error("[research] check-wires failed", err);
    return result({
      state: "unavailable",
      available: false,
      new_signals: 0,
      checked_at: null,
      next_check_in_minutes: null,
      reason: "The wires couldn't be checked just now - try again in a bit.",
    });
  } finally {
    client?.release();
  }
});
