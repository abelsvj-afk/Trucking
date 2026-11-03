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
import type {
  ResearchBriefing,
  ResearchRun,
  ResearchSignal,
  ResearchWatcherState,
} from "@/types/entities";
import { isDeepResearchEnabled } from "./capability";

const RECENT_RUNS_TO_SHOW = 10;

export const GET = createApiHandler(async (_req, ctx) => {
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

  // Runner proof-of-life (2026-11-02 design, D-1.3). Read-tolerant:
  // on a database where migration 00040 hasn't run yet the table
  // doesn't exist - the page gets runner: null instead of an error,
  // so the read surface never breaks on the engine's upgrade state.
  let runner: { last_tick_at: string | null; last_source: string | null; stale: boolean } | null = null;
  try {
    const { data: heartbeatRows, error: heartbeatError } = await supabase
      .from("research_runner_heartbeat")
      .select("last_tick_at, last_source")
      .eq("id", 1)
      .limit(1);
    if (!heartbeatError) {
      const row = (heartbeatRows ?? [])[0] as { last_tick_at: string; last_source: string } | undefined;
      runner = {
        last_tick_at: row?.last_tick_at ?? null,
        last_source: row?.last_source ?? null,
        stale:
          !row || Date.now() - new Date(row.last_tick_at).getTime() > config.heartbeatStaleHours * 3600 * 1000,
      };
    }
  } catch {
    runner = null;
  }

  // Banner "Watching" signals (Home News Banner design §5): the same
  // unconsumed predicate loadUnconsumedSignals() runs in SQL -
  // observed within 7 days and the dedupe key present in no
  // non-skipped run's trigger_detail - tightened for banner use to
  // observed within 72h and magnitude >= 0.5. Computed here through
  // the owner session (RLS scopes both tables to his company +
  // global signals), so "consumed" means consumed by HIS runs - the
  // only briefings his banner could ever show. Read-tolerant like
  // the heartbeat above: any failure degrades to no Watching items,
  // never a broken read surface.
  let signals: ResearchSignal[] = [];
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const [signalsResult, consumedResult] = await Promise.all([
      supabase
        .from("research_signals")
        .select("id, watcher_key, kind, topic, magnitude, summary, items, observed_at, dedupe_key")
        .gte("observed_at", sevenDaysAgo)
        .order("observed_at", { ascending: false })
        .limit(100),
      supabase
        .from("research_runs")
        .select("trigger_detail")
        .not("status", "in", "(skipped_cap,skipped_disabled)")
        .gte("created_at", sevenDaysAgo)
        .limit(200),
    ]);
    if (!signalsResult.error && !consumedResult.error) {
      const consumed = new Set<string>();
      for (const row of (consumedResult.data ?? []) as Array<{
        trigger_detail?: { signal_dedupe_keys?: unknown };
      }>) {
        const keys = row.trigger_detail?.signal_dedupe_keys;
        if (Array.isArray(keys)) {
          for (const key of keys) {
            if (typeof key === "string") consumed.add(key);
          }
        }
      }
      const cutoff72h = Date.now() - 72 * 3600 * 1000;
      signals = ((signalsResult.data ?? []) as ResearchSignal[]).filter(
        (signal) =>
          !consumed.has(signal.dedupe_key) &&
          new Date(signal.observed_at).getTime() >= cutoff72h &&
          signal.magnitude >= 0.5,
      );
    }
  } catch {
    signals = [];
  }

  const engineEnabled = await isDeepResearchEnabled(supabase, ctx.auth.companyId);

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
    runner,
    signals,
    engine_enabled: engineEnabled,
  });
});
