// Deep Research Engine trigger engine (docs/design/research-engine.md
// §3). Pure decision logic: given the clock, a company's run history,
// fresh signals, and the config, decide which research runs are due.
// The runner (run-research.ts) enforces caps and kill switches against
// the database; this module decides *intent*, and is unit-tested
// without a database or a clock mock beyond the `now` it's handed.

import type { ResearchConfig } from "./config";
import type { PressureSignal } from "./watchers/types";

export interface RunDecision {
  // evaluateTriggers only ever produces 'scheduled' | 'pressure';
  // 'manual' exists so the runner can treat the owner's queued
  // requests as the same shape of decision.
  kind: "scheduled" | "pressure" | "manual";
  topic: string;
  reason: string;
  signalDedupeKeys: string[];
}

export interface CompanyRunHistory {
  /** ISO time of the last baseline ('scheduled') run attempt, or null if never. */
  lastBaselineRunAt: string | null;
  runsToday: number;
  runsThisMonth: number;
}

/** How many more runs the caps allow right now (0 = capped). */
export function capHeadroom(history: CompanyRunHistory, config: ResearchConfig): number {
  return Math.max(
    0,
    Math.min(config.maxRunsPerDay - history.runsToday, config.maxRunsPerMonth - history.runsThisMonth),
  );
}

export function isBaselineDue(history: CompanyRunHistory, config: ResearchConfig, now: Date): boolean {
  if (!history.lastBaselineRunAt) return true;
  const elapsedMs = now.getTime() - Date.parse(history.lastBaselineRunAt);
  return elapsedMs >= config.baselineIntervalDays * 24 * 60 * 60 * 1000;
}

/** The week-over-week diesel move a signal carries (structured data, never parsed prose). */
export function signalDieselPct(signal: PressureSignal): number | null {
  if (signal.watcherKey !== "eia_diesel") return null;
  const pct = signal.data.wowPct;
  return typeof pct === "number" && Number.isFinite(pct) ? pct : null;
}

/** Does this one signal, on its own, cross its pressure threshold? */
export function signalCrossesThreshold(signal: PressureSignal, config: ResearchConfig): boolean {
  if (signal.watcherKey === "eia_diesel") {
    const pct = signalDieselPct(signal);
    return pct !== null && Math.abs(pct) >= config.dieselThresholdPct;
  }
  if (signal.watcherKey === "federal_register") {
    return signal.magnitude >= config.federalRegisterTriggerMagnitude;
  }
  if (signal.kind === "news_burst") {
    return true; // a burst only exists because it already crossed its floor
  }
  return false;
}

/**
 * The decision list for one company for one tick, in priority order:
 * pressure first (it's time-sensitive), baseline second. One pressure
 * decision per triggering topic - several signals on one topic queue a
 * single run that reads all of them.
 */
export function evaluateTriggers(input: {
  now: Date;
  history: CompanyRunHistory;
  freshSignals: PressureSignal[];
  config: ResearchConfig;
}): RunDecision[] {
  const { now, history, freshSignals, config } = input;
  const decisions: RunDecision[] = [];

  const triggering = freshSignals.filter((signal) => signalCrossesThreshold(signal, config));
  const byTopic = new Map<string, PressureSignal[]>();
  for (const signal of triggering) {
    const list = byTopic.get(signal.topic) ?? [];
    list.push(signal);
    byTopic.set(signal.topic, list);
  }
  for (const [topic, signals] of byTopic) {
    decisions.push({
      kind: "pressure",
      topic,
      reason: signals.map((s) => s.summary).join(" "),
      signalDedupeKeys: signals.map((s) => s.dedupeKey),
    });
  }

  if (isBaselineDue(history, config, now)) {
    decisions.push({
      kind: "scheduled",
      topic: "industry",
      reason: history.lastBaselineRunAt
        ? `Baseline cadence: last scheduled briefing ${config.baselineIntervalDays}+ days ago.`
        : "Baseline cadence: no scheduled briefing has ever run for this company.",
      signalDedupeKeys: [],
    });
  }

  return decisions;
}
