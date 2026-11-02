// Deep Research Engine trigger engine (docs/design/research-engine.md
// §3). Pure decision logic: given the clock, a company's run history,
// fresh signals, and the config, decide which research runs are due.
// The runner (run-research.ts) enforces caps and kill switches against
// the database; this module decides *intent*, and is unit-tested
// without a database or a clock mock beyond the `now` it's handed.

import type { ResearchConfig } from "./config";
import { marketPressureSignals, topicConvergenceScore } from "./scoring";
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
  /**
   * Shared-cap counts (pressure + manual only). Baseline runs draw on
   * their reserved budget instead (D-2) and are counted separately.
   */
  runsToday: number;
  runsThisMonth: number;
  /** ISO time of the last SUCCESSFUL baseline briefing, or null (D-2 success-based floor). */
  lastBaselineSuccessAt?: string | null;
  /** Baseline runs (any counted status) inside the rolling 30 days - the reserve meter. */
  baselineRunsThisMonth?: number;
  /** Baseline runs inside the rolling 24 hours - feeds the shared daily ceiling. */
  baselineRunsToday?: number;
  /** Topic -> ISO time of the last executed pressure run (convergence cooldowns, D-4). */
  lastPressureRunByTopic?: Record<string, string>;
}

/**
 * How many more runs of `kind` the caps allow right now (0 = capped).
 * Baseline ('scheduled') runs draw on the reserved baseline budget so
 * pressure can never starve the floor (D-2); they still respect the
 * shared daily ceiling so one day never produces more than
 * maxRunsPerDay runs in total. Pressure/manual share the classic caps.
 */
export function capHeadroom(
  history: CompanyRunHistory,
  config: ResearchConfig,
  kind: RunDecision["kind"] = "pressure",
): number {
  const daily = config.maxRunsPerDay - history.runsToday - (history.baselineRunsToday ?? 0);
  if (kind === "scheduled") {
    const reserve = config.baselineReservePerMonth - (history.baselineRunsThisMonth ?? 0);
    return Math.max(0, Math.min(daily, reserve));
  }
  return Math.max(0, Math.min(daily, config.maxRunsPerMonth - history.runsThisMonth));
}

export function isBaselineDue(history: CompanyRunHistory, config: ResearchConfig, now: Date): boolean {
  // Success-based floor (D-2): only a briefing the owner actually
  // received resets the cadence. A failed/insufficient attempt retries
  // after the cooldown instead of silently pushing the floor out by a
  // full interval. Fixtures built before the success field existed
  // fall back to the attempt-based read.
  const anchor = history.lastBaselineSuccessAt !== undefined ? history.lastBaselineSuccessAt : history.lastBaselineRunAt;
  if (!anchor) {
    if (history.lastBaselineSuccessAt !== undefined && history.lastBaselineRunAt) {
      const sinceAttemptMs = now.getTime() - Date.parse(history.lastBaselineRunAt);
      return sinceAttemptMs >= config.baselineRetryCooldownHours * 60 * 60 * 1000;
    }
    return true;
  }
  const elapsedMs = now.getTime() - Date.parse(anchor);
  return elapsedMs >= config.baselineIntervalDays * 24 * 60 * 60 * 1000;
}

/** The week-over-week diesel move a signal carries (structured data, never parsed prose). */
export function signalDieselPct(signal: PressureSignal): number | null {
  if (signal.watcherKey !== "eia_diesel" && signal.watcherKey !== "eia_diesel_regional") return null;
  const pct = signal.data.wowPct;
  return typeof pct === "number" && Number.isFinite(pct) ? pct : null;
}

/** Does this one signal, on its own, cross its pressure threshold? */
export function signalCrossesThreshold(signal: PressureSignal, config: ResearchConfig): boolean {
  if (signal.watcherKey === "eia_diesel" || signal.watcherKey === "eia_diesel_regional") {
    const pct = signalDieselPct(signal);
    return pct !== null && Math.abs(pct) >= config.dieselThresholdPct;
  }
  if (signal.watcherKey === "federal_register") {
    return signal.magnitude >= config.federalRegisterTriggerMagnitude;
  }
  if (signal.watcherKey === "openstates") {
    // Enacted state law hard-fires like a federal final rule;
    // introductions (low magnitude) only feed convergence (D-3/D-4).
    return signal.kind === "state_law_enacted" && signal.magnitude >= config.federalRegisterTriggerMagnitude;
  }
  if (signal.watcherKey === "nws_weather") {
    // The watcher only emits warning-class, multi-state/hurricane
    // signals nationally - those are hard triggers by construction.
    return signal.kind === "weather_alert";
  }
  if (signal.watcherKey === "gdelt_geo") {
    // Geopolitics corroborates; only a very large cluster fires alone.
    const count = signal.data.itemCount;
    return typeof count === "number" && count >= config.geoHardMinItems;
  }
  if (signal.kind === "news_burst") {
    return true; // a burst only exists because it already crossed its floor
  }
  return false;
}

/** True when any of the signal's affected states touches the company's corridor (D-5). */
export function signalTouchesStates(signal: PressureSignal, states: string[] | undefined): boolean {
  if (!states || states.length === 0) return false;
  const signalStates = signal.data.states;
  if (!Array.isArray(signalStates)) return false;
  return signalStates.some((s) => typeof s === "string" && states.includes(s));
}

/**
 * The decision list for one company for one tick, in priority order:
 * pressure first (it's time-sensitive), baseline second. One pressure
 * decision per triggering topic - several signals on one topic queue a
 * single run that reads all of them.
 *
 * Two ways a topic fires (D-4): a hard trigger (one signal over its
 * own threshold) or convergence (distinct sources' scores summing
 * past the fire line inside the window). After a pressure run, a
 * topic sits in cooldown: convergence must clear a raised line, hard
 * triggers still fire. `storedSignals` are previously-stored,
 * never-consumed signals re-evaluated alongside this tick's fresh
 * ones (D-2) - pressure capped on its first day is no longer dropped.
 * Corridor-touching signals count double toward convergence (D-5).
 */
export function evaluateTriggers(input: {
  now: Date;
  history: CompanyRunHistory;
  freshSignals: PressureSignal[];
  storedSignals?: PressureSignal[];
  corridorStates?: string[];
  config: ResearchConfig;
}): RunDecision[] {
  const { now, history, config } = input;
  const decisions: RunDecision[] = [];

  const byKey = new Map<string, PressureSignal>();
  for (const signal of [...(input.storedSignals ?? []), ...input.freshSignals]) {
    byKey.set(signal.dedupeKey, signal);
    for (const pseudo of marketPressureSignals(signal, config)) byKey.set(pseudo.dedupeKey, pseudo);
  }
  const signals = [...byKey.values()];

  const topics = new Set(signals.map((s) => s.topic));
  for (const topic of topics) {
    const topicSignals = signals.filter((s) => s.topic === topic);
    const hard = topicSignals.filter((signal) => signalCrossesThreshold(signal, config));

    if (hard.length > 0) {
      decisions.push({
        kind: "pressure",
        topic,
        reason: hard.map((s) => s.summary).join(" "),
        signalDedupeKeys: topicSignals.map((s) => s.dedupeKey),
      });
      continue;
    }

    // Convergence: corridor signals count double (D-5 escalation) -
    // implemented as a magnitude-boosted scoring clone (never
    // persisted); convergence groups by source, so duplicating the
    // signal itself would change nothing.
    const corridorBoosted = topicSignals.map((s) =>
      signalTouchesStates(s, input.corridorStates) ? { ...s, magnitude: s.magnitude * 2 } : s,
    );
    const score = topicConvergenceScore(corridorBoosted, topic, now, config);

    const lastPressureAt = history.lastPressureRunByTopic?.[topic];
    const inCooldown =
      lastPressureAt !== undefined &&
      now.getTime() - Date.parse(lastPressureAt) < config.pressureCooldownDays * 24 * 60 * 60 * 1000;
    const fireLine = config.convergenceFireScore * (inCooldown ? config.cooldownConvergenceMultiplier : 1);

    if (score >= fireLine) {
      decisions.push({
        kind: "pressure",
        topic,
        reason: `Convergence: independent sources scored ${score.toFixed(2)} on "${topic}" inside ${config.convergenceWindowHours}h (fire line ${fireLine.toFixed(2)}${inCooldown ? ", raised by cooldown" : ""}). ${topicSignals.map((s) => s.summary).join(" ")}`,
        signalDedupeKeys: topicSignals.map((s) => s.dedupeKey),
      });
    }
  }

  if (isBaselineDue(history, config, now)) {
    const anchor = history.lastBaselineSuccessAt !== undefined ? history.lastBaselineSuccessAt : history.lastBaselineRunAt;
    decisions.push({
      kind: "scheduled",
      topic: "industry",
      reason: anchor
        ? `Baseline cadence: last successful scheduled briefing ${config.baselineIntervalDays}+ days ago.`
        : "Baseline cadence: no successful scheduled briefing has ever run for this company.",
      signalDedupeKeys: [],
    });
  }

  return decisions;
}
