// GDELT client tests - mocked HTTP only, no live calls. The request
// shape pinned here is the one live-verified 2026-11-03: GDELT
// throttles clients that send no identifying User-Agent (429) and
// answers the same request with the honest UA (200) - see gdelt.ts.

import { describe, expect, it, vi } from "vitest";
import { fetchGdeltArticles, GDELT_USER_AGENT } from "@/services/integrations/gdelt";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 429 ? "Too Many Requests" : "Error",
    json: async () => body,
  };
}

const ARTICLES_BODY = {
  articles: [
    {
      title: "Red Sea shipping disruption widens",
      url: "https://example.com/story",
      domain: "example.com",
      seendate: "20261103T120000Z",
    },
  ],
};

describe("fetchGdeltArticles", () => {
  it("sends the identifying User-Agent and parses the article list", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, ARTICLES_BODY));

    const articles = await fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0, 0, 0);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(GDELT_USER_AGENT);
    expect(articles).toEqual([
      {
        title: "Red Sea shipping disruption widens",
        url: "https://example.com/story",
        domain: "example.com",
        seenDate: "20261103T120000Z",
      },
    ]);
  });

  it("retries once after a 429 (GDELT's one-per-5-seconds rule) and succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, null))
      .mockResolvedValueOnce(jsonResponse(200, ARTICLES_BODY));

    const articles = await fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0, 0, 0);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(articles).toHaveLength(1);
  });

  it("succeeds on the third attempt after two 429s (shared-IP throttling is erratic - live-verified 2026-11-04)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, null))
      .mockResolvedValueOnce(jsonResponse(429, null))
      .mockResolvedValueOnce(jsonResponse(200, ARTICLES_BODY));

    const articles = await fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0, 0, 0);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(articles).toHaveLength(1);
  });

  it("gives up into a visible error after the third 429", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(429, null));

    await expect(fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0, 0, 0)).rejects.toThrow(
      "GDELT request failed: 429 Too Many Requests",
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries a network-level failure (the production gdelt_geo 'fetch failed') and succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, ARTICLES_BODY));

    const articles = await fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0, 0, 0);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(articles).toHaveLength(1);
  });

  it("gives up into a visible error after repeated network failures, keeping the cause", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0, 0, 0)).rejects.toThrow(
      "GDELT request failed: fetch failed",
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-429 failures", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, null));

    await expect(fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0, 0, 0)).rejects.toThrow(
      "GDELT request failed: 500",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("paces request starts process-wide: back-to-back calls (the gdelt_tech burst pattern) are spaced by the pace interval", async () => {
    const starts: number[] = [];
    const fetchFn = vi.fn().mockImplementation(async () => {
      starts.push(Date.now());
      return jsonResponse(200, ARTICLES_BODY);
    });

    const PACE = 200;
    await fetchGdeltArticles("48h", 75, fetchFn as never, "query one", 0, PACE);
    await fetchGdeltArticles("48h", 75, fetchFn as never, "query two", 0, PACE);
    await fetchGdeltArticles("48h", 75, fetchFn as never, "query three", 0, PACE);
    await fetchGdeltArticles("48h", 75, fetchFn as never, "query four", 0, PACE);

    expect(fetchFn).toHaveBeenCalledTimes(4);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(PACE - 25);
    }
  });
});
