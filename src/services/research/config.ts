// Deep Research Engine configuration (docs/design/research-engine.md
// §3). Every knob is an env-overridable constant, the same treatment
// Stage 4 gave INDUSTRY_BRIEFING_INTERVAL_MS - the governance numbers
// (caps, thresholds) live in exactly one place, and a deployment can
// tighten them without a code change.

export interface ResearchConfig {
  /** Baseline ("scheduled") run cadence - twice-monthly per vision §3. */
  baselineIntervalDays: number;
  /** |week-over-week diesel change| at or above this % is pressure. */
  dieselThresholdPct: number;
  /** Hard caps - enforced against research_runs counts, never memory. */
  maxRunsPerDay: number;
  maxRunsPerMonth: number;
  /** News-burst detection: items inside the window matching one topic. */
  newsBurstMinItems: number;
  newsBurstWindowHours: number;
  /** A federal-register signal at or above this magnitude triggers. */
  federalRegisterTriggerMagnitude: number;
  // --- Research Intelligence upgrade (2026-11-02 design, D-2/D-4/D-6) ---
  /** Reserved monthly budget ONLY baseline runs may draw on (D-2). */
  baselineReservePerMonth: number;
  /** After a failed/insufficient baseline, wait this long before retrying (D-2). */
  baselineRetryCooldownHours: number;
  /** Convergence: distinct-source topic score inside the window that fires a run (D-4). */
  convergenceFireScore: number;
  /** Convergence look-back window in hours (D-4). */
  convergenceWindowHours: number;
  /** After a pressure run on a topic, convergence must clear a higher line for this many days (D-4). */
  pressureCooldownDays: number;
  /** Multiplier applied to the convergence line during a topic cooldown (D-4). */
  cooldownConvergenceMultiplier: number;
  /** A crude-oil weekly move at/above this % feeds convergence as market pressure (D-3). */
  marketCrudeThresholdPct: number;
  /** A Dow Transports weekly move at/above this % feeds convergence as market pressure (D-3). */
  marketTransportsThresholdPct: number;
  /** GDELT cluster size that hard-fires on its own; smaller clusters only converge (D-3). */
  geoHardMinItems: number;
  /** Heartbeat older than this many hours = the runner is stale (D-1.3). */
  heartbeatStaleHours: number;
  /** A watcher in 'error' longer than this many hours alerts (D-1.3). */
  watcherErrorAlertHours: number;
  /** No successful briefing (any kind) in this many days alerts (D-8). */
  floorAlertDays: number;
  /** Quiet hours for non-urgent Telegram delivery, America/New_York (D-6). */
  deliveryQuietStartHourEt: number;
  deliveryQuietEndHourEt: number;
  /** Max hours a non-urgent briefing's buzz may be held by driving status (D-6). */
  deliveryHoldMaxHours: number;
}

export function getResearchConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  const num = (name: string, fallback: number) => {
    const raw = Number(env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    baselineIntervalDays: num("RESEARCH_BASELINE_INTERVAL_DAYS", 15),
    dieselThresholdPct: num("RESEARCH_DIESEL_THRESHOLD_PCT", 3),
    maxRunsPerDay: num("RESEARCH_MAX_RUNS_PER_DAY", 2),
    maxRunsPerMonth: num("RESEARCH_MAX_RUNS_PER_MONTH", 10),
    newsBurstMinItems: num("RESEARCH_NEWS_BURST_MIN_ITEMS", 4),
    newsBurstWindowHours: num("RESEARCH_NEWS_BURST_WINDOW_HOURS", 48),
    federalRegisterTriggerMagnitude: 0.8,
    baselineReservePerMonth: num("RESEARCH_BASELINE_RESERVE_PER_MONTH", 3),
    baselineRetryCooldownHours: num("RESEARCH_BASELINE_RETRY_COOLDOWN_HOURS", 24),
    convergenceFireScore: num("RESEARCH_CONVERGENCE_FIRE_SCORE", 1.6),
    convergenceWindowHours: num("RESEARCH_CONVERGENCE_WINDOW_HOURS", 72),
    pressureCooldownDays: num("RESEARCH_PRESSURE_COOLDOWN_DAYS", 5),
    cooldownConvergenceMultiplier: num("RESEARCH_COOLDOWN_CONVERGENCE_MULTIPLIER", 2),
    marketCrudeThresholdPct: num("RESEARCH_MARKET_CRUDE_THRESHOLD_PCT", 5),
    marketTransportsThresholdPct: num("RESEARCH_MARKET_TRANSPORTS_THRESHOLD_PCT", 4),
    geoHardMinItems: num("RESEARCH_GEO_HARD_MIN_ITEMS", 12),
    heartbeatStaleHours: num("RESEARCH_HEARTBEAT_STALE_HOURS", 26),
    watcherErrorAlertHours: num("RESEARCH_WATCHER_ERROR_ALERT_HOURS", 24),
    floorAlertDays: num("RESEARCH_FLOOR_ALERT_DAYS", 35),
    deliveryQuietStartHourEt: num("RESEARCH_DELIVERY_QUIET_START_HOUR_ET", 21),
    deliveryQuietEndHourEt: num("RESEARCH_DELIVERY_QUIET_END_HOUR_ET", 6),
    deliveryHoldMaxHours: num("RESEARCH_DELIVERY_HOLD_MAX_HOURS", 4),
  };
}
