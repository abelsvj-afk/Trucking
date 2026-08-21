import { describe, expect, it, vi } from "vitest";

const { parseURLMock } = vi.hoisted(() => ({ parseURLMock: vi.fn() }));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = parseURLMock;
  },
}));

import { fetchIndustryNews } from "@/services/integrations/rss";

describe("fetchIndustryNews", () => {
  it("normalizes items from every feed that succeeds", async () => {
    parseURLMock.mockResolvedValue({
      items: [
        {
          title: "New FMCSA rule proposed",
          link: "https://example.test/1",
          isoDate: "2026-08-20T00:00:00Z",
          contentSnippet: "Summary of the rule.",
        },
      ],
    });

    const results = await fetchIndustryNews();

    expect(results).toHaveLength(3);
    for (const feed of results) {
      expect(feed.error).toBeNull();
      expect(feed.items[0]).toEqual({
        source: feed.source,
        title: "New FMCSA rule proposed",
        link: "https://example.test/1",
        publishedAt: "2026-08-20T00:00:00Z",
        summary: "Summary of the rule.",
      });
    }
  });

  it("records a per-feed error instead of throwing, so one dead feed doesn't sink the others", async () => {
    parseURLMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const results = await fetchIndustryNews();

    expect(results).toHaveLength(3);
    for (const feed of results) {
      expect(feed.error).toBe("ECONNREFUSED");
      expect(feed.items).toEqual([]);
    }
  });

  it("caps items at 10 per feed", async () => {
    parseURLMock.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, i) => ({ title: `Item ${i}`, link: `https://example.test/${i}` })),
    });

    const results = await fetchIndustryNews();
    expect(results[0]?.items).toHaveLength(10);
  });
});
