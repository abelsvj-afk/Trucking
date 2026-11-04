// OpenStates client tests - mocked HTTP only, no live calls.
//
// Production history: with the key verified good (jurisdictions ->
// 200), every bills poll answered 400 Bad Request and the client
// threw the body away, so the Research page showed a bare status.
// Keyless probing (2026-11-04) proved the API authenticates BEFORE
// validating params (bogus key -> 401 for every param shape), so the
// bad param cannot be isolated from outside; the service's own
// OpenAPI spec clears jurisdiction-by-name, per_page, and
// include=actions (a valid BillInclude enum value), leaving the
// full-ISO-timestamp `updated_since` as the prime suspect. These
// tests pin the request shape and the error-detail surfacing that
// makes any remaining 400 self-naming on the Research page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOpenStatesBills } from "@/services/integrations/openstates";

const originalKey = process.env.OPENSTATES_API_KEY;

beforeEach(() => {
  process.env.OPENSTATES_API_KEY = "test-key";
});

afterEach(() => {
  process.env.OPENSTATES_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("fetchOpenStatesBills", () => {
  it("throws when OPENSTATES_API_KEY is not configured", async () => {
    delete process.env.OPENSTATES_API_KEY;
    await expect(fetchOpenStatesBills("Florida", "truck", "2026-11-01")).rejects.toThrow(
      "OPENSTATES_API_KEY is not configured",
    );
  });

  it("builds the documented bills request and parses the results", async () => {
    const seen: { url: URL | null; key: string | null } = { url: null, key: null };
    const fetchFn = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.url = new URL(String(input));
      seen.key = (init?.headers as Record<string, string>)["X-API-Key"] ?? null;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              id: "ocd-bill/00000000-0000-0000-0000-000000000001",
              title: "Truck Weights",
              jurisdiction: { name: "Florida" },
              latest_action_description: "Signed by Governor",
              latest_action_date: "2026-10-30",
              actions: [{ description: "Signed", date: "2026-10-30", classification: ["governor:signed"] }],
            },
          ],
        }),
      };
    });

    const bills = await fetchOpenStatesBills("Florida", "truck", "2026-11-01", fetchFn as never);

    expect(seen.key).toBe("test-key");
    expect(seen.url?.origin + (seen.url?.pathname ?? "")).toBe("https://v3.openstates.org/bills");
    expect(seen.url?.searchParams.get("jurisdiction")).toBe("Florida");
    expect(seen.url?.searchParams.get("q")).toBe("truck");
    expect(seen.url?.searchParams.get("updated_since")).toBe("2026-11-01");
    expect(seen.url?.searchParams.get("per_page")).toBe("20");
    expect(seen.url?.searchParams.get("include")).toBe("actions");
    expect(bills).toHaveLength(1);
    expect(bills[0]?.title).toBe("Truck Weights");
  });

  it("surfaces the API's own error detail on failure (a bare '400 Bad Request' names nothing)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ detail: "Invalid value for updated_since: not a valid date." }),
    });
    await expect(fetchOpenStatesBills("Florida", "truck", "2026-11-01", fetchFn as never)).rejects.toThrow(
      "OpenStates request for Florida failed: 400 Bad Request (Invalid value for updated_since: not a valid date.)",
    );
  });

  it("falls back to the plain status line when the error body is unreadable", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => {
        throw new Error("stream already consumed");
      },
    });
    await expect(fetchOpenStatesBills("Florida", "truck", "2026-11-01", fetchFn as never)).rejects.toThrow(
      "OpenStates request for Florida failed: 500 Internal Server Error",
    );
  });

  it("throws when the response body doesn't match the expected shape", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: "shape" }),
    });
    await expect(fetchOpenStatesBills("Florida", "truck", "2026-11-01", fetchFn as never)).rejects.toThrow(
      "didn't match the expected shape",
    );
  });
});
