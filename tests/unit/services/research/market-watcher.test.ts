import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketSnapshotWatcher } from "@/services/research/watchers/market-snapshot";

// Market watcher poll behavior after the 2026-11-03 Stooq -> FRED
// switch. Global fetch is stubbed and routed by the series_id query
// param - no live calls. Pins: visible skip without FRED_API_KEY,
// the daily snapshot shape, per-series degradation, and the
// all-series-down error path.

const ORIGINAL_KEY = process.env.FRED_API_KEY;
const today = () => new Date().toISOString().slice(0, 10);

// Desc-order values: newest 110 vs 100 five numeric steps back = +10% WoW.
const DAILY_VALUES = ["110", "104", "103", "102", "101", "100"];
const DIESEL_VALUES = ["5.5", "5.0"];

function fredResponse(values: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      observations: values.map((value, i) => ({ date: `2026-10-${30 - i}`, value })),
    }),
  } as Response;
}

function errorResponse(): Response {
  return { ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) } as Response;
}

function stubFredFetch(failing: Set<string> = new Set()) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const seriesId = new URL(String(input)).searchParams.get("series_id") ?? "";
    if (failing.has(seriesId)) return errorResponse();
    return fredResponse(seriesId === "GASDESW" ? DIESEL_VALUES : DAILY_VALUES);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.FRED_API_KEY = "test-fred-key";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.FRED_API_KEY;
  else process.env.FRED_API_KEY = ORIGINAL_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("marketSnapshotWatcher.poll", () => {
  it("skips visibly when FRED_API_KEY is not set - and never calls FRED", async () => {
    delete process.env.FRED_API_KEY;
    const fetchMock = stubFredFetch();

    const result = await marketSnapshotWatcher.poll({});

    expect(result.watcherKey).toBe("fred_market");
    expect(result.status).toBe("skipped");
    expect(result.message).toContain("FRED_API_KEY is not set");
    expect(result.signals).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits one daily FRED snapshot with per-series WoW reads and the diesel read", async () => {
    stubFredFetch();

    const result = await marketSnapshotWatcher.poll({});

    expect(result.status).toBe("ok");
    expect(result.message).toBeNull();
    expect(result.state.lastSnapshotDay).toBe(today());
    expect(result.signals).toHaveLength(1);
    const [signal] = result.signals;
    expect(signal?.watcherKey).toBe("fred_market");
    expect(signal?.kind).toBe("market_snapshot");
    expect(signal?.data.spxWowPct).toBeCloseTo(10);
    expect(signal?.data.transportsWowPct).toBeCloseTo(10);
    expect(signal?.data.crudeWowPct).toBeCloseTo(10);
    expect(signal?.data.natgasWowPct).toBeCloseTo(10);
    expect(signal?.data.fredDieselWowPct).toBeCloseTo(10);
    expect(signal?.dedupeKey).toBe(`market_snapshot:${today()}`);
    expect(signal?.summary).toContain("Dow Transports up 10.0%");
  });

  it("does not snapshot twice in one day", async () => {
    const fetchMock = stubFredFetch();

    const result = await marketSnapshotWatcher.poll({ lastSnapshotDay: today() });

    expect(result.status).toBe("ok");
    expect(result.signals).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades one failed series to a null read and names it in the poll message", async () => {
    stubFredFetch(new Set(["DJTA"]));

    const result = await marketSnapshotWatcher.poll({});

    expect(result.status).toBe("ok");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.data.transportsWowPct).toBeNull();
    expect(result.signals[0]?.data.spxWowPct).toBeCloseTo(10);
    expect(result.message).toContain("DJTA");
  });

  it("errors (and stores no snapshot day) when all four market series fail", async () => {
    stubFredFetch(new Set(["SP500", "DJTA", "DCOILWTICO", "DHHNGSP"]));

    const result = await marketSnapshotWatcher.poll({});

    expect(result.status).toBe("error");
    expect(result.message).toContain("All FRED market series failed");
    expect(result.signals).toEqual([]);
    expect(result.state.lastSnapshotDay).toBeUndefined();
  });
});
