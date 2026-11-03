import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFredSeries, fredWeekOverWeek } from "@/services/integrations/fred";

// FRED client after the 2026-11-03 Stooq -> FRED switch: the market
// watcher's only source. All HTTP is mocked - these tests pin the
// request shape (api.stlouisfed.org/fred/series/observations, key as
// the api_key query param) and the parsing/change math.

const ORIGINAL_KEY = process.env.FRED_API_KEY;

beforeEach(() => {
  process.env.FRED_API_KEY = "test-fred-key";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.FRED_API_KEY;
  else process.env.FRED_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

describe("fetchFredSeries", () => {
  it("requests the observations endpoint with series, key, and desc/limit params", async () => {
    const fetchFn = vi.fn(async (_url: URL) => okResponse({ observations: [{ date: "2026-10-30", value: "7580.07" }] }));
    const points = await fetchFredSeries("SP500", 10, fetchFn as unknown as typeof fetch);

    expect(points).toEqual([{ date: "2026-10-30", value: 7580.07 }]);
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://api.stlouisfed.org/fred/series/observations");
    expect(url.searchParams.get("series_id")).toBe("SP500");
    expect(url.searchParams.get("api_key")).toBe("test-fred-key");
    expect(url.searchParams.get("file_type")).toBe("json");
    expect(url.searchParams.get("sort_order")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("throws 'not configured' without calling FRED when the key is unset", async () => {
    delete process.env.FRED_API_KEY;
    const fetchFn = vi.fn(async () => okResponse({ observations: [] }));
    await expect(fetchFredSeries("SP500", 10, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      "FRED_API_KEY is not configured.",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails loudly on a non-OK response, naming the series and status", async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({}) }) as Response,
    );
    await expect(fetchFredSeries("DCOILWTICO", 10, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      "FRED request for DCOILWTICO failed: 400",
    );
  });

  it("fails loudly on a wrong-shaped response instead of inventing numbers", async () => {
    const fetchFn = vi.fn(async () => okResponse({ notObservations: true }));
    await expect(fetchFredSeries("SP500", 10, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      "didn't match the expected shape",
    );
  });

  it("maps FRED's '.' gap values to NaN so change math can skip them", async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        observations: [
          { date: "2026-11-02", value: "20642.92" },
          { date: "2026-10-30", value: "." },
        ],
      }),
    );
    const points = await fetchFredSeries("DJTA", 10, fetchFn as unknown as typeof fetch);
    expect(points[0]?.value).toBeCloseTo(20642.92);
    expect(Number.isNaN(points[1]?.value)).toBe(true);
  });
});

describe("fredWeekOverWeek", () => {
  it("compares the two newest numeric observations (weekly diesel read)", () => {
    const points = [
      { date: "2026-10-26", value: 5.5 },
      { date: "2026-10-19", value: Number.NaN },
      { date: "2026-10-12", value: 5.0 },
    ];
    expect(fredWeekOverWeek(points)).toBeCloseTo(10);
  });

  it("returns null when a comparison is impossible", () => {
    expect(fredWeekOverWeek([{ date: "2026-10-26", value: 5.5 }])).toBeNull();
    expect(fredWeekOverWeek([])).toBeNull();
  });
});
