import { describe, expect, it } from "vitest";
import { getResearchConfig } from "@/services/research/config";
import {
  capHeadroom,
  evaluateTriggers,
  isBaselineDue,
  signalCrossesThreshold,
  type CompanyRunHistory,
} from "@/services/research/triggers";
import type { PressureSignal } from "@/services/research/watchers/types";

const config = getResearchConfig({} as NodeJS.ProcessEnv);
const NOW = new Date("2026-10-31T12:00:00Z");

function signal(partial: Partial<PressureSignal>): PressureSignal {
  return {
    watcherKey: "industry_news",
    kind: "news_burst",
    topic: "fuel",
    magnitude: 0.5,
    summary: "s",
    items: [],
    data: {},
    dedupeKey: "k",
    observedAt: NOW.toISOString(),
    ...partial,
  };
}

const baseHistory: CompanyRunHistory = { lastBaselineRunAt: NOW.toISOString(), runsToday: 0, runsThisMonth: 0 };

/** A sub-threshold diesel observation: real pressure, no hard trigger (score 0.9). */
const softDiesel = () =>
  signal({
    watcherKey: "eia_diesel",
    kind: "fuel_price_observation",
    magnitude: 0.9,
    data: { wowPct: 1 },
    dedupeKey: "eia-soft",
  });

/** A market snapshot whose crude move becomes fuel pressure (score 0.64 via the pseudo-signal). */
const crudeSnapshot = () =>
  signal({
    watcherKey: "stooq_market",
    kind: "market_snapshot",
    topic: "market",
    magnitude: 0.3,
    data: { crudeWowPct: -8 },
    dedupeKey: "market_snapshot:2026-10-31",
  });

/** A mid-size GDELT cluster: below the solo hard floor, real convergence weight (score 0.54). */
const geoCluster = () =>
  signal({
    watcherKey: "gdelt_geo",
    kind: "geo_burst",
    magnitude: 0.9,
    data: { itemCount: 6 },
    dedupeKey: "geo-1",
  });

describe("success-based floor (isBaselineDue)", () => {
  it("only a success resets the cadence - a success 20 days ago is due no matter the attempts", () => {
    const history: CompanyRunHistory = {
      ...baseHistory,
      lastBaselineRunAt: new Date(NOW.getTime() - 30 * 3600 * 1000).toISOString(),
      lastBaselineSuccessAt: new Date(NOW.getTime() - 20 * 24 * 3600 * 1000).toISOString(),
    };
    expect(isBaselineDue(history, config, NOW)).toBe(true);
  });

  it("with no success yet, a failed attempt retries after the cooldown, not a full interval", () => {
    const attempted2hAgo: CompanyRunHistory = {
      ...baseHistory,
      lastBaselineRunAt: new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString(),
      lastBaselineSuccessAt: null,
    };
    expect(isBaselineDue(attempted2hAgo, config, NOW)).toBe(false);

    const attempted3dAgo: CompanyRunHistory = {
      ...baseHistory,
      lastBaselineRunAt: new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString(),
      lastBaselineSuccessAt: null,
    };
    expect(isBaselineDue(attempted3dAgo, config, NOW)).toBe(true);
  });

  it("a recent success means not due", () => {
    const history: CompanyRunHistory = {
      ...baseHistory,
      lastBaselineRunAt: NOW.toISOString(),
      lastBaselineSuccessAt: new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString(),
    };
    expect(isBaselineDue(history, config, NOW)).toBe(false);
  });
});

describe("split caps (capHeadroom)", () => {
  it("baseline draws its reserved budget when pressure has exhausted the shared MONTHLY pool", () => {
    const history: CompanyRunHistory = {
      ...baseHistory,
      runsToday: 0,
      runsThisMonth: config.maxRunsPerMonth,
      baselineRunsThisMonth: 0,
      baselineRunsToday: 0,
    };
    expect(capHeadroom(history, config, "pressure")).toBe(0);
    expect(capHeadroom(history, config, "manual")).toBe(0);
    expect(capHeadroom(history, config, "scheduled")).toBeGreaterThan(0);
  });

  it("baseline still respects the shared daily ceiling, and its reserve is itself capped", () => {
    const fullDay: CompanyRunHistory = {
      ...baseHistory,
      runsToday: config.maxRunsPerDay,
      baselineRunsThisMonth: 0,
      baselineRunsToday: 0,
    };
    expect(capHeadroom(fullDay, config, "scheduled")).toBe(0);

    const reserveSpent: CompanyRunHistory = {
      ...baseHistory,
      baselineRunsThisMonth: config.baselineReservePerMonth,
      baselineRunsToday: 0,
    };
    expect(capHeadroom(reserveSpent, config, "scheduled")).toBe(0);
  });

  it("legacy callers (no kind) keep the old shared-pool behavior", () => {
    expect(capHeadroom({ ...baseHistory, runsToday: 1 }, config)).toBe(config.maxRunsPerDay - 1);
  });
});

describe("convergence firing (evaluateTriggers)", () => {
  it("weak signals from three distinct sources converge into a pressure run", () => {
    const decisions = evaluateTriggers({
      now: NOW,
      history: baseHistory,
      freshSignals: [softDiesel(), crudeSnapshot(), geoCluster()],
      config,
    });
    const fuel = decisions.find((d) => d.topic === "fuel");
    expect(fuel?.kind).toBe("pressure");
    expect(fuel?.reason).toMatch(/convergence/i);
  });

  it("two weak sources are not enough, and one never fires on convergence", () => {
    expect(
      evaluateTriggers({ now: NOW, history: baseHistory, freshSignals: [geoCluster()], config }),
    ).toEqual([]);
    expect(
      evaluateTriggers({ now: NOW, history: baseHistory, freshSignals: [crudeSnapshot(), geoCluster()], config }),
    ).toEqual([]);
  });

  it("a cooldown raises the convergence bar but never blocks a hard trigger", () => {
    const history: CompanyRunHistory = {
      ...baseHistory,
      lastPressureRunByTopic: { fuel: new Date(NOW.getTime() - 3600 * 1000).toISOString() },
    };
    expect(
      evaluateTriggers({ now: NOW, history, freshSignals: [softDiesel(), crudeSnapshot(), geoCluster()], config }),
    ).toEqual([]);

    const hard = signal({
      watcherKey: "eia_diesel",
      kind: "fuel_price_observation",
      data: { wowPct: 4 },
      dedupeKey: "eia-hard",
    });
    const decisions = evaluateTriggers({ now: NOW, history, freshSignals: [hard], config });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("pressure");
  });

  it("stored signals from earlier ticks are re-evaluated and can complete a convergence", () => {
    const fiveHoursAgo = new Date(NOW.getTime() - 5 * 3600 * 1000).toISOString();
    const stored = [
      { ...geoCluster(), observedAt: fiveHoursAgo },
      { ...softDiesel(), observedAt: fiveHoursAgo },
    ];
    const decisions = evaluateTriggers({
      now: NOW,
      history: baseHistory,
      freshSignals: [crudeSnapshot()],
      storedSignals: stored,
      config,
    });
    expect(decisions.some((d) => d.topic === "fuel" && /convergence/i.test(d.reason))).toBe(true);
  });
});

describe("new hard thresholds (signalCrossesThreshold)", () => {
  it("an enacted state law crosses; an introduction does not", () => {
    expect(
      signalCrossesThreshold(signal({ watcherKey: "openstates", kind: "state_law_enacted", magnitude: 0.85 }), config),
    ).toBe(true);
    expect(
      signalCrossesThreshold(signal({ watcherKey: "openstates", kind: "state_law_introduced", magnitude: 0.3 }), config),
    ).toBe(false);
  });

  it("a warning-class weather alert crosses by construction", () => {
    expect(
      signalCrossesThreshold(signal({ watcherKey: "nws_weather", kind: "weather_alert", topic: "weather", magnitude: 0.85 }), config),
    ).toBe(true);
  });

  it("a GDELT burst crosses alone only at the hard floor; below it, it is convergence-only", () => {
    expect(
      signalCrossesThreshold(
        signal({ watcherKey: "gdelt_geo", kind: "geo_burst", data: { itemCount: config.geoHardMinItems } }),
        config,
      ),
    ).toBe(true);
    expect(
      signalCrossesThreshold(signal({ watcherKey: "gdelt_geo", kind: "geo_burst", data: { itemCount: 5 } }), config),
    ).toBe(false);
  });

  it("regional diesel uses the same % threshold as national", () => {
    expect(
      signalCrossesThreshold(signal({ watcherKey: "eia_diesel_regional", kind: "fuel_price_observation", data: { wowPct: -3.4 } }), config),
    ).toBe(true);
    expect(
      signalCrossesThreshold(signal({ watcherKey: "eia_diesel_regional", kind: "fuel_price_observation", data: { wowPct: 1 } }), config),
    ).toBe(false);
  });
});
