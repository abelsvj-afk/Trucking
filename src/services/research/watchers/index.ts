// Deep Research Engine watcher registry (docs/design/research-
// engine.md §2). Polling every watcher persists two things through the
// scoped job credential: the watcher's health row in
// research_watcher_state (last poll, status, error - visible on the
// Research page, never silent) and any fresh signals in
// research_signals (deduped on dedupe_key, so a re-poll of unchanged
// source state stores nothing twice).

import type { Queryable } from "@/services/ai/run-industry-briefing";
import { eiaDieselWatcher } from "./eia-diesel";
import { federalRegisterWatcher } from "./federal-register";
import { industryNewsWatcher } from "./industry-news";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export type { PressureSignal, ResearchSourceItem, WatcherResult } from "./types";
export { TRACKED_TOPICS, matchTrackedTopics } from "./types";

export const WATCHERS: Watcher[] = [eiaDieselWatcher, federalRegisterWatcher, industryNewsWatcher];

interface WatcherStateRow extends Record<string, unknown> {
  watcher_key: string;
  state: Record<string, unknown>;
}

async function loadWatcherState(db: Queryable, watcherKey: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query<WatcherStateRow>(
    `select watcher_key, state from research_watcher_state where watcher_key = $1`,
    [watcherKey],
  );
  return rows[0]?.state ?? {};
}

async function persistWatcherResult(db: Queryable, result: WatcherResult): Promise<PressureSignal[]> {
  const stored: PressureSignal[] = [];
  for (const signal of result.signals) {
    const { rows } = await db.query<{ id: string }>(
      `insert into research_signals (watcher_key, kind, topic, magnitude, summary, items, data, dedupe_key, observed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (dedupe_key) do nothing
       returning id`,
      [
        signal.watcherKey,
        signal.kind,
        signal.topic,
        signal.magnitude,
        signal.summary,
        JSON.stringify(signal.items),
        JSON.stringify(signal.data),
        signal.dedupeKey,
        signal.observedAt,
      ],
    );
    if (rows[0]) stored.push(signal);
  }

  await db.query(
    `insert into research_watcher_state (watcher_key, last_polled_at, last_status, last_error, last_signal_at, state, updated_at)
     values ($1, now(), $2, $3, case when $4 > 0 then now() else null end, $5::jsonb, now())
     on conflict (watcher_key) do update set
       last_polled_at = now(),
       last_status = excluded.last_status,
       last_error = excluded.last_error,
       last_signal_at = coalesce(excluded.last_signal_at, research_watcher_state.last_signal_at),
       state = research_watcher_state.state || excluded.state,
       updated_at = now()`,
    [
      result.watcherKey,
      result.status,
      result.message,
      stored.length,
      JSON.stringify(result.state),
    ],
  );

  return stored;
}

/**
 * Polls every registered watcher once, persists health + signals, and
 * returns the signals that were actually newly stored this poll (the
 * trigger engine's fresh-pressure input). A watcher that throws past
 * its own error handling still lands as a visible 'error' state row.
 */
export async function pollAllWatchers(
  db: Queryable,
  watchers: Watcher[] = WATCHERS,
): Promise<PressureSignal[]> {
  const fresh: PressureSignal[] = [];
  for (const watcher of watchers) {
    let result: WatcherResult;
    try {
      const state = await loadWatcherState(db, watcher.key);
      result = await watcher.poll(state);
    } catch (err) {
      result = {
        watcherKey: watcher.key,
        status: "error",
        message: err instanceof Error ? err.message : "Unknown watcher failure.",
        signals: [],
        state: {},
      };
    }
    fresh.push(...(await persistWatcherResult(db, result)));
  }
  return fresh;
}
