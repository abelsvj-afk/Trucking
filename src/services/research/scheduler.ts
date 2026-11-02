// Deep Research Engine scheduler (docs/design/research-engine.md §9)
// + the Research Intelligence tick (2026-11-02 design, D-1).
//
// The tick body lives here as an exported runResearchTick() so BOTH
// invokers call the identical code path: the in-process interval
// below (kept - it covers the app-awake case and cold starts) and the
// secret-authenticated internal endpoint that Supabase pg_cron calls
// hourly (the always-on invoker - D-1.2). Due-ness is decided from
// database state, never in-memory timers.
//
// Every tick: take the advisory lock (two awake machines must not
// double-execute - D-1.4) -> let the watchdog judge the PREVIOUS
// heartbeat before this tick refreshes it -> refresh corridors ->
// poll watchers (signals are the archive; polling costs no AI spend)
// -> run the engine for eligible companies -> write the heartbeat.

import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { createTelegramNotifier, type TelegramNotifier } from "@/services/telegram/notify";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import { getResearchConfig } from "./config";
import { refreshCorridors } from "./corridor";
import { evaluateResearchHealth, reportResearchConfigFailure, type HealthSummary } from "./health";
import { getEligibleCompanyIds, runResearchJob } from "./run-research";
import { pollAllWatchers } from "./watchers";

const CHECK_IN_MS = 60 * 60 * 1000;

/** Constant advisory-lock key for the research tick (D-1.4). */
export const RESEARCH_TICK_LOCK_KEY = 727001;

export interface ResearchTickSummary {
  source: string;
  locked: boolean;
  freshSignals: number;
  health: HealthSummary | null;
}

interface PoolClient {
  query: Queryable["query"];
  release: () => void;
}

interface ConnectablePool {
  connect: () => Promise<PoolClient>;
}

async function writeHeartbeat(db: Queryable, source: string, detail: Record<string, unknown>): Promise<void> {
  await db.query(
    `insert into research_runner_heartbeat (id, last_tick_at, last_source, last_detail, updated_at)
     values (1, now(), $1, $2, now())
     on conflict (id) do update set
       last_tick_at = now(),
       last_source = excluded.last_source,
       last_detail = excluded.last_detail,
       updated_at = now()`,
    [source, JSON.stringify(detail)],
  );
}

/**
 * One full engine tick. `source` is recorded in the heartbeat
 * ('scheduler' | 'endpoint') so the proof-of-life record shows WHICH
 * invoker is keeping the engine alive. Never throws - a failed tick
 * logs and returns, exactly like the scheduler it replaces.
 */
export async function runResearchTick(source: "scheduler" | "endpoint"): Promise<ResearchTickSummary> {
  const summary: ResearchTickSummary = { source, locked: false, freshSignals: 0, health: null };
  let client: PoolClient | null = null;

  // CD-7: pool construction gets its own guard. It throws
  // synchronously when INDUSTRY_BRIEFING_DB_URL is unset - which used
  // to land in the tick's console-only catch, so no heartbeat was
  // written, the watchdog never ran, and the internal endpoint still
  // answered 200 with health: null. A watchdog that dies with the
  // engine watches nothing: this failure now reports itself (direct
  // Telegram alert, throttled) and rides back in summary.health as an
  // explicit failure state.
  let pool: ReturnType<typeof getIndustryBriefingPool>;
  try {
    pool = getIndustryBriefingPool();
  } catch (err) {
    console.error("[research] tick could not start - job database pool failed to construct", err);
    const message = err instanceof Error ? err.message : String(err);
    const detail = message.includes("INDUSTRY_BRIEFING_DB_URL")
      ? "The research runner cannot start: INDUSTRY_BRIEFING_DB_URL is not configured, so the engine cannot tick, poll watchers, or produce briefings. Set it on the app (Fly secret - see docs/runtime.md, 'Research engine invoker'). This alert repeats at most once a day."
      : `The research runner cannot start: the job database pool failed to construct (${message}). The engine cannot tick, poll watchers, or produce briefings until this is fixed. This alert repeats at most once a day.`;
    let notifier: TelegramNotifier | null = null;
    try {
      notifier = createTelegramNotifier();
    } catch {
      notifier = null; // even a broken notifier must not mask the failure state
    }
    summary.health = await reportResearchConfigFailure(notifier, detail);
    return summary;
  }

  try {
    const config = getResearchConfig();
    const notifier: TelegramNotifier = createTelegramNotifier();

    // Advisory lock on a dedicated connection - session-level locks
    // die with the connection, so the lock must be taken and released
    // on the same client, never the pool at large.
    client = await (pool as unknown as ConnectablePool).connect();
    const { rows } = await client.query<{ locked: boolean } & Record<string, unknown>>(
      `select pg_try_advisory_lock($1) as locked`,
      [RESEARCH_TICK_LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      summary.locked = true;
      return summary;
    }

    try {
      // Watchdog first: it judges the heartbeat of the PREVIOUS tick
      // (a fresh heartbeat written moments ago would mask staleness).
      summary.health = await evaluateResearchHealth(pool, notifier, config);

      const eligible = await getEligibleCompanyIds(pool);
      await refreshCorridors(pool, eligible);

      const freshSignals = await pollAllWatchers(pool);
      summary.freshSignals = freshSignals.length;

      const provider = new OpenAiProvider();
      await runResearchJob(pool, provider, notifier, freshSignals, config);

      await writeHeartbeat(pool, source, { freshSignals: freshSignals.length });
    } finally {
      await client.query(`select pg_advisory_unlock($1)`, [RESEARCH_TICK_LOCK_KEY]).catch(() => undefined);
    }
  } catch (err) {
    // Connect/provider failures land here (pool CONSTRUCTION failure
    // is handled above, CD-7) - logged, never a crash for the whole
    // server (same call Stage 4 made).
    console.error("[research] tick failed", err);
  } finally {
    client?.release();
  }
  return summary;
}

let started = false;

/** Idempotent - safe to call more than once. */
export function startResearchScheduler(): void {
  if (started) return;
  started = true;

  setInterval(() => void runResearchTick("scheduler"), CHECK_IN_MS);
  void runResearchTick("scheduler");
}
