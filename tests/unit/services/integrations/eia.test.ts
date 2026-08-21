// Tests the parsing/validation logic against a fixture matching this
// implementation's best-confidence understanding of the EIA v2 response
// shape - NOT a live-verified shape (see eia.ts's top comment: this
// sandbox's network egress blocks api.eia.gov, confirmed via curl).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFuelMarketSnapshot } from "@/services/integrations/eia";

const originalFetch = global.fetch;
const originalKey = process.env.EIA_API_KEY;

beforeEach(() => {
  process.env.EIA_API_KEY = "test-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.EIA_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("fetchFuelMarketSnapshot", () => {
  it("throws when EIA_API_KEY is not configured", async () => {
    delete process.env.EIA_API_KEY;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow("EIA_API_KEY is not configured");
  });

  it("parses a well-formed EIA v2 response into a FuelMarketSnapshot", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          data: [{ period: "2026-08-18", value: 3.852, units: "$/GAL" }],
        },
      }),
    }) as never;

    const result = await fetchFuelMarketSnapshot();
    expect(result).toEqual({
      label: "U.S. average diesel retail price",
      period: "2026-08-18",
      pricePerGallon: 3.852,
      units: "$/GAL",
    });
  });

  it("throws when the HTTP response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" }) as never;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow("EIA API request failed: 403");
  });

  it("throws when the response body doesn't match the expected shape (fails explicit, per docs/automation.md)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: "shape" }),
    }) as never;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow("didn't match the expected shape");
  });

  it("throws when EIA returns an empty data array", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: { data: [] } }),
    }) as never;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow();
  });
});
