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
  };
}
