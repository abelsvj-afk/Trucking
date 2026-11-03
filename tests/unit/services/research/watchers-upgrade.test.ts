import { describe, expect, it } from "vitest";
import { parseNwsAlerts, statesFromZones } from "@/services/integrations/nws";
import { billIsEnacted } from "@/services/integrations/openstates";
import { fredChangeOverSteps, type FredPoint } from "@/services/integrations/fred";
import { buildRegionalDieselSignal } from "@/services/research/watchers/eia-regional";
import { buildGdeltSignals } from "@/services/research/watchers/gdelt-geo";
import { buildMarketSignal } from "@/services/research/watchers/market-snapshot";
import { buildWeatherSignals, severityRank } from "@/services/research/watchers/nws-weather";
import { billMatchesCategories, buildStateLawSignal } from "@/services/research/watchers/openstates";
import { getResearchConfig } from "@/services/research/config";
import type { FuelMarketPoint } from "@/services/integrations/eia";

const config = getResearchConfig({} as NodeJS.ProcessEnv);
const OBSERVED = "2026-10-31T12:00:00Z";

describe("EIA regional diesel (buildRegionalDieselSignal)", () => {
  const points: FuelMarketPoint[] = [
    { period: "2026-10-26", pricePerGallon: 5.5, units: "$/gal" },
    { period: "2026-10-19", pricePerGallon: 5.0, units: "$/gal" },
  ];

  it("labels the region, keeps the wowPct read, and dedupes per area+period", () => {
    const signal = buildRegionalDieselSignal({ duoarea: "R30", label: "Gulf Coast (PADD 3)" }, points, OBSERVED);
    expect(signal?.watcherKey).toBe("eia_diesel_regional");
    expect(signal?.data.wowPct).toBeCloseTo(10);
    expect(signal?.data.area).toBe("R30");
    expect(signal?.dedupeKey).toBe("eia_diesel_regional:R30:2026-10-26");
    expect(signal?.summary).toContain("Gulf Coast (PADD 3)");
  });

  it("a single point is a first observation with no WoW read (never threshold-crossing)", () => {
    const [latestPoint] = points;
    if (!latestPoint) throw new Error("fixture missing");
    const first = buildRegionalDieselSignal({ duoarea: "R10", label: "East Coast (PADD 1)" }, [latestPoint], OBSERVED);
    expect(first).not.toBeNull();
    expect(first?.data.wowPct).toBeNull();
    expect(buildRegionalDieselSignal({ duoarea: "R10", label: "East Coast (PADD 1)" }, [], OBSERVED)).toBeNull();
  });
});

describe("FRED daily WoW (fredChangeOverSteps)", () => {
  // Desc order, as fetchFredSeries returns: newest first.
  const pointsOf = (values: number[]): FredPoint[] => values.map((value, i) => ({ date: `2026-10-${30 - i}`, value }));

  it("computes the 5-observation (one trading week) change for daily series", () => {
    expect(fredChangeOverSteps(pointsOf([110, 104, 103, 102, 101, 100]), 5)).toBeCloseTo(10);
    expect(fredChangeOverSteps(pointsOf([95, 99, 99, 99, 99, 100]), 5)).toBeCloseTo(-5);
  });

  it("skips non-numeric gap observations instead of counting them as steps, and returns null on thin history", () => {
    const withGap = pointsOf([110, Number.NaN, 104, 103, 102, 101, 100]);
    expect(fredChangeOverSteps(withGap, 5)).toBeCloseTo(10);
    expect(fredChangeOverSteps(pointsOf([110, 104]), 5)).toBeNull();
  });
});

describe("market snapshot (buildMarketSignal)", () => {
  it("emits one daily observation with per-series WoW reads and a date dedupe", () => {
    const signal = buildMarketSignal({ spxWowPct: 2, transportsWowPct: -5, crudeWowPct: 10, natgasWowPct: 0 }, null, OBSERVED);
    expect(signal.watcherKey).toBe("fred_market");
    expect(signal.kind).toBe("market_snapshot");
    expect(signal.topic).toBe("market");
    expect(signal.data.crudeWowPct).toBeCloseTo(10);
    expect(signal.data.transportsWowPct).toBeCloseTo(-5);
    expect(signal.data.fredDieselWowPct).toBeNull();
    expect(signal.dedupeKey).toBe("market_snapshot:2026-10-31");
    expect(signal.summary).toContain("Transports down 5.0%");
  });
});

describe("GDELT clustering (buildGdeltSignals)", () => {
  const articles = (n: number, title: string) =>
    Array.from({ length: n }, (_, i) => ({ title: `${title} ${i}`, url: `https://x.example/${i}`, domain: "x.example", seenDate: "20261031T000000Z" }));

  it("clusters by tracked topic and only bursts at the floor", () => {
    const signals = buildGdeltSignals(
      [...articles(4, "Diesel prices surge as OPEC cuts"), ...articles(2, "Local bake sale")],
      config,
      OBSERVED,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe("geo_burst");
    expect(signals[0]?.topic).toBe("fuel");
    expect(signals[0]?.data.itemCount).toBe(4);
    expect(signals[0]?.dedupeKey).toBe("geo_burst:fuel:2026-10-31");
  });

  it("below the burst floor there is no signal at all", () => {
    expect(buildGdeltSignals(articles(3, "Diesel prices"), config, OBSERVED)).toEqual([]);
  });
});

describe("NWS weather (parseNwsAlerts / buildWeatherSignals)", () => {
  it("derives states from zone ids, never from prose", () => {
    expect(statesFromZones(["https://api.weather.gov/zones/forecast/FLZ162", "https://api.weather.gov/zones/county/GAC001"])).toEqual(["FL", "GA"]);
    const alerts = parseNwsAlerts({
      features: [
        {
          properties: {
            event: "Hurricane Warning",
            severity: "Extreme",
            headline: "Hurricane Warning issued",
            affectedZones: ["https://api.weather.gov/zones/forecast/FLZ162"],
            expires: null,
          },
        },
      ],
    });
    expect(alerts[0]?.states).toEqual(["FL"]);
  });

  it("severity ranks hurricane-class highest, then multi-state warnings", () => {
    expect(severityRank("Hurricane Warning", 1)).toBe(5);
    expect(severityRank("Winter Storm Warning", 3)).toBe(4);
    expect(severityRank("Winter Storm Warning", 1)).toBe(2);
  });

  it("only warning-class, nationally significant events become signals", () => {
    const signals = buildWeatherSignals(
      [
        { event: "Hurricane Warning", severity: "Extreme", headline: "Landfall expected", states: ["FL"], expires: null },
        { event: "Winter Storm Warning", severity: "Severe", headline: "Snow", states: ["NY"], expires: null },
        { event: "Dense Fog Advisory", severity: "Minor", headline: "Fog", states: ["FL", "GA", "AL", "SC"], expires: null },
      ],
      OBSERVED,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.data.severityRank).toBe(5);
    expect(signals[0]?.data.states).toEqual(["FL"]);
  });
});

describe("OpenStates (bill classification)", () => {
  const bill = (partial: Record<string, unknown>) => ({
    id: "ocd-bill/1",
    title: "An act relating to truck weight limits",
    latest_action_description: "Signed by Governor",
    latest_action_date: "2026-10-15",
    actions: [{ description: "Signed", date: "2026-10-15", classification: ["governor:signed"] }],
    ...partial,
  });

  it("an enacted, on-category bill is a strong signal; an introduction is weak", () => {
    expect(billIsEnacted(bill({}))).toBe(true);
    expect(billMatchesCategories(bill({}))).toBe(true);
    expect(billMatchesCategories(bill({ title: "An act relating to library funding" }))).toBe(false);

    const enacted = buildStateLawSignal(bill({}), "FL", OBSERVED);
    expect(enacted.kind).toBe("state_law_enacted");
    expect(enacted.magnitude).toBe(0.85);
    expect(enacted.data.states).toEqual(["FL"]);

    const introduced = buildStateLawSignal(bill({ actions: [{ classification: ["introduction"] }] }), "GA", OBSERVED);
    expect(introduced.kind).toBe("state_law_introduced");
    expect(introduced.magnitude).toBe(0.3);
  });
});
