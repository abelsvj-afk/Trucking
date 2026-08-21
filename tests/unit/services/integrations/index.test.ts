// Tests the hard-fail-vs-thin-data distinction clarified in
// docs/automation.md's Failure recovery section: EIA failing, or every RSS
// feed failing, throws (no partial briefing); some-but-not-all RSS feeds
// failing is "thin" data, not a failure.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/integrations/eia", () => ({
  fetchFuelMarketSnapshot: vi.fn(),
}));
vi.mock("@/services/integrations/rss", () => ({
  fetchIndustryNews: vi.fn(),
}));

import { fetchFuelMarketSnapshot } from "@/services/integrations/eia";
import { fetchIndustryNews } from "@/services/integrations/rss";
import { gatherIndustrySources, SourceUnreachableError } from "@/services/integrations";

const SNAPSHOT = { label: "test", period: "2026-08-18", pricePerGallon: 3.85, units: "$/GAL" };

describe("gatherIndustrySources", () => {
  it("throws SourceUnreachableError when EIA fails", async () => {
    vi.mocked(fetchFuelMarketSnapshot).mockRejectedValue(new Error("timeout"));
    vi.mocked(fetchIndustryNews).mockResolvedValue([{ source: "A", items: [], error: null }]);

    await expect(gatherIndustrySources()).rejects.toThrow(SourceUnreachableError);
  });

  it("throws SourceUnreachableError when every RSS feed fails", async () => {
    vi.mocked(fetchFuelMarketSnapshot).mockResolvedValue(SNAPSHOT);
    vi.mocked(fetchIndustryNews).mockResolvedValue([
      { source: "A", items: [], error: "down" },
      { source: "B", items: [], error: "down" },
    ]);

    await expect(gatherIndustrySources()).rejects.toThrow(SourceUnreachableError);
  });

  it("succeeds with newsPartial=true when some (not all) RSS feeds fail", async () => {
    vi.mocked(fetchFuelMarketSnapshot).mockResolvedValue(SNAPSHOT);
    vi.mocked(fetchIndustryNews).mockResolvedValue([
      { source: "A", items: [{ source: "A", title: "t", link: "l", publishedAt: null, summary: null }], error: null },
      { source: "B", items: [], error: "down" },
    ]);

    const result = await gatherIndustrySources();
    expect(result.newsPartial).toBe(true);
    expect(result.fuelMarket).toEqual(SNAPSHOT);
  });

  it("succeeds with newsPartial=false when every RSS feed succeeds", async () => {
    vi.mocked(fetchFuelMarketSnapshot).mockResolvedValue(SNAPSHOT);
    vi.mocked(fetchIndustryNews).mockResolvedValue([{ source: "A", items: [], error: null }]);

    const result = await gatherIndustrySources();
    expect(result.newsPartial).toBe(false);
  });
});
