import { describe, expect, it } from "vitest";
import { getResearchConfig } from "@/services/research/config";
import {
  marketPressureSignals,
  recencyDecay,
  scoreSignal,
  sourceWeight,
  topicConvergenceScore,
} from "@/services/research/scoring";
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

describe("sourceWeight", () => {
  it("trusts official sources most, news least, unknown in between", () => {
    expect(sourceWeight("eia_diesel")).toBe(1);
    expect(sourceWeight("federal_register")).toBe(1);
    expect(sourceWeight("industry_news")).toBe(0.6);
    expect(sourceWeight("gdelt_geo")).toBe(0.6);
    expect(sourceWeight("some_future_watcher")).toBe(0.5);
  });
});

describe("recencyDecay", () => {
  it("is 1 now, decays linearly toward 0.25, and is 0 at and beyond the window edge", () => {
    const window = config.convergenceWindowHours;
    expect(recencyDecay(NOW.toISOString(), NOW, window)).toBe(1);
    const nearEdge = new Date(NOW.getTime() - (window - 0.01) * 3600 * 1000).toISOString();
    expect(recencyDecay(nearEdge, NOW, window)).toBeCloseTo(0.25, 1);
    const atEdge = new Date(NOW.getTime() - window * 3600 * 1000).toISOString();
    expect(recencyDecay(atEdge, NOW, window)).toBe(0);
    const beyond = new Date(NOW.getTime() - (window + 1) * 3600 * 1000).toISOString();
    expect(recencyDecay(beyond, NOW, window)).toBe(0);
  });
});

describe("topicConvergenceScore", () => {
  it("counts only the strongest signal per source - one loud feed never converges alone", () => {
    const fiveFromOneFeed = Array.from({ length: 5 }, (_, i) =>
      signal({ dedupeKey: `n${i}`, magnitude: 0.9 }),
    );
    expect(topicConvergenceScore(fiveFromOneFeed, "fuel", NOW, config)).toBeCloseTo(0.9 * 0.6);
  });

  it("sums across distinct sources and ignores other topics", () => {
    const signals = [
      signal({ watcherKey: "eia_diesel", magnitude: 0.5, dedupeKey: "a" }),
      signal({ watcherKey: "industry_news", magnitude: 0.5, dedupeKey: "b" }),
      signal({ watcherKey: "industry_news", magnitude: 0.9, topic: "rates", dedupeKey: "c" }),
    ];
    expect(topicConvergenceScore(signals, "fuel", NOW, config)).toBeCloseTo(0.5 * 1 + 0.5 * 0.6);
    expect(topicConvergenceScore(signals, "carriers", NOW, config)).toBe(0);
  });

  it("old signals outside the window contribute nothing", () => {
    const stale = signal({
      watcherKey: "eia_diesel",
      magnitude: 1,
      observedAt: new Date(NOW.getTime() - (config.convergenceWindowHours + 2) * 3600 * 1000).toISOString(),
    });
    expect(topicConvergenceScore([stale], "fuel", NOW, config)).toBe(0);
  });
});

describe("scoreSignal", () => {
  it("multiplies magnitude, source weight, and decay", () => {
    const s = signal({ watcherKey: "eia_diesel", magnitude: 0.8 });
    expect(scoreSignal(s, NOW, config)).toBeCloseTo(0.8);
  });
});

describe("marketPressureSignals", () => {
  const snapshot = (data: Record<string, unknown>) =>
    signal({ watcherKey: "fred_market", kind: "market_snapshot", topic: "market", data, dedupeKey: "market_snapshot:2026-10-31" });

  it("turns a big crude move into fuel pressure and a big Transports move into rates pressure", () => {
    const out = marketPressureSignals(snapshot({ crudeWowPct: -7, transportsWowPct: 5 }), config);
    expect(out.map((s) => s.topic)).toEqual(["fuel", "rates"]);
    expect(out[0]?.kind).toBe("market_pressure");
  });

  it("still scores stored stooq_market snapshots from before the FRED switch", () => {
    const legacy = signal({
      watcherKey: "stooq_market",
      kind: "market_snapshot",
      topic: "market",
      data: { crudeWowPct: -7 },
      dedupeKey: "market_snapshot:2026-10-30",
    });
    expect(marketPressureSignals(legacy, config).map((s) => s.topic)).toEqual(["fuel"]);
  });

  it("stays silent on ordinary market moves and on non-market signals", () => {
    expect(marketPressureSignals(snapshot({ crudeWowPct: 2, transportsWowPct: 1 }), config)).toEqual([]);
    expect(marketPressureSignals(signal({ data: { crudeWowPct: 9 } }), config)).toEqual([]);
  });
});
