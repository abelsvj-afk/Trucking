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

    const articles = await fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0);

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

    const articles = await fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(articles).toHaveLength(1);
  });

  it("gives up into a visible error after a second 429", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(429, null));

    await expect(fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0)).rejects.toThrow(
      "GDELT request failed: 429 Too Many Requests",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-429 failures", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, null));

    await expect(fetchGdeltArticles("48h", 75, fetchFn as never, undefined, 0)).rejects.toThrow("GDELT request failed: 500");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
