import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDieselSignal,
  eiaDieselWatcher,
  weekOverWeekPct,
} from "@/services/research/watchers/eia-diesel";
import {
  documentToSignal,
  fetchFederalRegisterDocuments,
  type FederalRegisterDocument,
} from "@/services/research/watchers/federal-register";
import { buildBurstSignal, clusterNewsItems } from "@/services/research/watchers/industry-news";
import type { NewsItem } from "@/services/integrations/rss";

const originalFetch = global.fetch;
const originalKey = process.env.EIA_API_KEY;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.EIA_API_KEY;
  else process.env.EIA_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("eia_diesel watcher", () => {
  const points: Array<{ period: string; pricePerGallon: number; units: string }> = [
    { period: "2026-10-26", pricePerGallon: 5.89, units: "$/GAL" },
    { period: "2026-10-19", pricePerGallon: 5.74, units: "$/GAL" },
  ];

  it("computes the week-over-week move from two real points", () => {
    expect(weekOverWeekPct(points)).toBeCloseTo(2.613, 2);
    expect(weekOverWeekPct([points[0]!])).toBeNull();
    expect(weekOverWeekPct([points[0]!, { period: "2026-10-19", pricePerGallon: 0, units: "$/GAL" }])).toBeNull();
  });

  it("builds a deduped observation signal carrying the structured wowPct", () => {
    const signal = buildDieselSignal(points, "2026-10-31T12:00:00Z");
    expect(signal?.dedupeKey).toBe("eia_diesel:2026-10-26");
    expect(signal?.topic).toBe("fuel");
    expect(signal?.data.wowPct).toBeCloseTo(2.613, 2);
    expect(signal?.summary).toContain("up 2.61%");
  });

  it("skips gracefully without an EIA_API_KEY - never fabricates a price", async () => {
    delete process.env.EIA_API_KEY;
    const result = await eiaDieselWatcher.poll({});
    expect(result.status).toBe("skipped");
    expect(result.message).toContain("EIA_API_KEY");
    expect(result.signals).toEqual([]);
  });

  it("emits one signal for a new week and none when the week is unchanged", async () => {
    process.env.EIA_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          data: [
            { period: "2026-10-26", value: 5.89, units: "$/GAL" },
            { period: "2026-10-19", value: 5.74, units: "$/GAL" },
          ],
        },
      }),
    }) as never;

    const first = await eiaDieselWatcher.poll({});
    expect(first.status).toBe("ok");
    expect(first.signals).toHaveLength(1);
    expect(first.state.lastPeriod).toBe("2026-10-26");

    const second = await eiaDieselWatcher.poll({ lastPeriod: "2026-10-26" });
    expect(second.status).toBe("ok");
    expect(second.signals).toEqual([]);
  });
});

describe("federal_register watcher", () => {
  const base: FederalRegisterDocument = {
    document_number: "2026-12345",
    title: "Hours of Service of Drivers; Final Rule",
    type: "RULE",
    abstract: "FMCSA amends the hours of service regulations.",
    html_url: "https://www.federalregister.gov/documents/2026-12345",
    publication_date: "2026-10-30",
  };

  it("rates a final rule on a tracked topic as the strongest regulatory pressure", () => {
    const signal = documentToSignal(base, "2026-10-31T12:00:00Z");
    expect(signal.kind).toBe("federal_rule_final");
    expect(signal.magnitude).toBe(0.9);
    expect(signal.dedupeKey).toBe("federal_register:2026-12345");
    expect(signal.items[0]?.url).toBe(base.html_url);
  });

  it("rates an untracked proposed rule low - recorded, not triggering", () => {
    const signal = documentToSignal(
      { ...base, type: "PRORULE", title: "Administrative Update to Mailing Addresses", abstract: "Updated contact addresses." },
      "2026-10-31T12:00:00Z",
    );
    expect(signal.kind).toBe("federal_rule_proposed");
    expect(signal.magnitude).toBe(0.3);
  });

  it("parses the API envelope and fails loud on a wrong shape", async () => {
    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [base] }),
    }) as never;
    await expect(fetchFederalRegisterDocuments(okFetch)).resolves.toEqual([base]);

    const badFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nope: true }),
    }) as never;
    await expect(fetchFederalRegisterDocuments(badFetch)).rejects.toThrow("didn't match the expected shape");
  });
});

describe("industry_news burst detection", () => {
  function item(title: string): NewsItem {
    return { source: "FreightWaves", title, link: `https://example.test/${title}`, publishedAt: null, summary: null };
  }

  it("clusters items by tracked topic and only bursts at the floor", () => {
    const items = [
      item("Diesel prices jump at the pump"),
      item("Fuel surcharges rise again"),
      item("Oil price rally hits trucking"),
      item("Diesel demand outpaces supply"),
      item("Local driver wins rodeo"),
    ];
    const clusters = clusterNewsItems(items);
    const fuel = clusters.find((c) => c.topic === "fuel");
    expect(fuel?.items).toHaveLength(4);

    const signal = buildBurstSignal(fuel!, { newsBurstMinItems: 4 }, "2026-10-31T12:00:00Z");
    expect(signal?.kind).toBe("news_burst");
    expect(signal?.magnitude).toBe(0.5);
    expect(signal?.dedupeKey).toBe("news_burst:fuel:2026-10-31");

    const below = buildBurstSignal(
      { topic: "fuel", items: items.slice(0, 3) },
      { newsBurstMinItems: 4 },
      "2026-10-31T12:00:00Z",
    );
    expect(below).toBeNull();
  });
});
