// Tests the parsing/validation logic against fixtures matching the
// EIA v2 response shape - live-verified 2026-11-03 (see eia.ts's top
// comment: the exact request this module builds returned 200 with the
// registered key; the error-body fixtures match EIA's real 403s).

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

  it("parses the STRING value EIA actually sends (live-verified 2026-11-04: value arrives as \"6.292\", not a number)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          data: [{ period: "2026-11-02", value: "6.292", units: "$/GAL" }],
        },
      }),
    }) as never;

    const result = await fetchFuelMarketSnapshot();
    expect(result.pricePerGallon).toBe(6.292);
    expect(typeof result.pricePerGallon).toBe("number");
  });

  it("throws loudly on a non-numeric string value instead of coercing it to 0/NaN", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          data: [{ period: "2026-11-02", value: "N/A", units: "$/GAL" }],
        },
      }),
    }) as never;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow("didn't match the expected shape");
  });

  it("throws loudly on an empty-string value instead of reading it as 0", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          data: [{ period: "2026-11-02", value: "", units: "$/GAL" }],
        },
      }),
    }) as never;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow("didn't match the expected shape");
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

  it("surfaces EIA's own error code on failure (API_KEY_INVALID vs API_KEY_MISSING is the diagnosis)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () =>
        JSON.stringify({ error: { code: "API_KEY_INVALID", message: "An invalid api_key was supplied." } }),
    }) as never;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow("EIA API request failed: 403 Forbidden (API_KEY_INVALID");
  });

  it("falls back to the plain status line when the error body is unreadable", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => {
        throw new Error("stream already consumed");
      },
    }) as never;
    await expect(fetchFuelMarketSnapshot()).rejects.toThrow("EIA API request failed: 500 Internal Server Error");
  });
});
