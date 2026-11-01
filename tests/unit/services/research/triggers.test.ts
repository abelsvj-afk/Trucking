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

const freshHistory: CompanyRunHistory = { lastBaselineRunAt: null, runsToday: 0, runsThisMonth: 0 };

describe("signalCrossesThreshold", () => {
  it("diesel crosses at or above the configured % move, in either direction", () => {
    const diesel = (wowPct: number | null) =>
      signal({ watcherKey: "eia_diesel", kind: "fuel_price_observation", data: { wowPct } });
    expect(signalCrossesThreshold(diesel(3), config)).toBe(true);
    expect(signalCrossesThreshold(diesel(-4.2), config)).toBe(true);
    expect(signalCrossesThreshold(diesel(2.9), config)).toBe(false);
    expect(signalCrossesThreshold(diesel(null), config)).toBe(false);
  });

  it("a federal final rule crosses; a proposed rule does not", () => {
    expect(
      signalCrossesThreshold(signal({ watcherKey: "federal_register", kind: "federal_rule_final", magnitude: 0.9 }), config),
    ).toBe(true);
    expect(
      signalCrossesThreshold(signal({ watcherKey: "federal_register", kind: "federal_rule_proposed", magnitude: 0.6 }), config),
    ).toBe(false);
  });

  it("a news burst crosses by construction", () => {
    expect(signalCrossesThreshold(signal({}), config)).toBe(true);
  });
});

describe("baseline cadence", () => {
  it("is due when never run, not due inside the interval, due after it", () => {
    expect(isBaselineDue(freshHistory, config, NOW)).toBe(true);
    expect(
      isBaselineDue({ ...freshHistory, lastBaselineRunAt: "2026-10-25T12:00:00Z" }, config, NOW),
    ).toBe(false);
    expect(
      isBaselineDue({ ...freshHistory, lastBaselineRunAt: "2026-10-10T12:00:00Z" }, config, NOW),
    ).toBe(true);
  });
});

describe("capHeadroom", () => {
  it("is bounded by whichever cap is tighter", () => {
    expect(capHeadroom(freshHistory, config)).toBe(2);
    expect(capHeadroom({ ...freshHistory, runsToday: 2 }, config)).toBe(0);
    expect(capHeadroom({ ...freshHistory, runsThisMonth: 10 }, config)).toBe(0);
    expect(capHeadroom({ ...freshHistory, runsToday: 1, runsThisMonth: 9 }, config)).toBe(1);
  });
});

describe("evaluateTriggers", () => {
  it("groups triggering signals on one topic into a single pressure run", () => {
    const decisions = evaluateTriggers({
      now: NOW,
      history: { ...freshHistory, lastBaselineRunAt: "2026-10-30T12:00:00Z" },
      freshSignals: [
        signal({ watcherKey: "eia_diesel", kind: "fuel_price_observation", data: { wowPct: 5 }, dedupeKey: "d1" }),
        signal({ dedupeKey: "d2" }),
        signal({ topic: "rates", dedupeKey: "d3" }),
      ],
      config,
    });
    expect(decisions).toHaveLength(2);
    const fuel = decisions.find((d) => d.topic === "fuel");
    expect(fuel?.kind).toBe("pressure");
    expect(fuel?.signalDedupeKeys.sort()).toEqual(["d1", "d2"]);
  });

  it("adds the baseline run when due, and stays quiet when nothing is due", () => {
    const withBaseline = evaluateTriggers({ now: NOW, history: freshHistory, freshSignals: [], config });
    expect(withBaseline).toEqual([
      expect.objectContaining({ kind: "scheduled", topic: "industry" }),
    ]);

    const quiet = evaluateTriggers({
      now: NOW,
      history: { ...freshHistory, lastBaselineRunAt: "2026-10-30T12:00:00Z" },
      freshSignals: [signal({ watcherKey: "eia_diesel", kind: "fuel_price_observation", data: { wowPct: 1 } })],
      config,
    });
    expect(quiet).toEqual([]);
  });
});
